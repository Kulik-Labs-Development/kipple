import { randomUUID } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import { desc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { db } from './db'
import { runMigrations } from './db/migrate'
import {
  accounts,
  audit,
  clients,
  contactClients,
  contacts,
  settings,
  tickets,
  updates,
  users,
} from './db/schema'

type App = Awaited<ReturnType<typeof buildApp>>

const owner = {
  instanceName: 'Kulik Users',
  ownerName: 'Max Users',
  ownerEmail: 'max@users.test',
  password: 'correct-horse-users',
}

function cookiesFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie']
  const list = Array.isArray(raw) ? raw : [raw]
  return list
    .filter(Boolean)
    .map((cookie) => String(cookie).split(';')[0])
    .join('; ')
}

async function signIn(app: App, email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email, password },
  })
  expect(res.statusCode).toBe(200)
  return cookiesFrom(res)
}

async function createLocalUser(name: string, email: string, role: string, password: string): Promise<string> {
  const id = randomUUID()
  await db.insert(users).values({ id, name, email, role })
  await db.insert(accounts).values({
    id: randomUUID(),
    providerId: 'credential',
    issuer: 'local:credential',
    accountId: id,
    userId: id,
    password: await hashPassword(password),
  })
  return id
}

async function wipe() {
  await db.delete(updates)
  await db.delete(tickets)
  await db.delete(contactClients)
  await db.delete(contacts)
  await db.delete(clients)
  await db.delete(audit)
  await db.delete(users)
  await db.delete(settings)
}

describe('users <-> client association + queue client filter (item 11)', () => {
  let app: App
  let superuserCookie: string
  let agentCookie: string
  let agentUserId: string
  let clientA: string
  let clientB: string

  beforeAll(async () => {
    await runMigrations()
    await wipe()
    app = await buildApp()
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: owner })
    expect(setup.statusCode).toBe(200)
    superuserCookie = await signIn(app, owner.ownerEmail, owner.password)

    agentUserId = await createLocalUser('Riley Agent', 'riley@users.test', 'agent', 'riley-users-pass')
    agentCookie = await signIn(app, 'riley@users.test', 'riley-users-pass')

    const resA = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie: superuserCookie },
      payload: { name: 'Acme Corp' },
    })
    expect(resA.statusCode).toBe(201)
    clientA = resA.json().id

    const resB = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie: superuserCookie },
      payload: { name: 'Globex' },
    })
    expect(resB.statusCode).toBe(201)
    clientB = resB.json().id
  })

  afterAll(async () => {
    await app.close()
    await wipe()
  })

  it('lists staff with clientId + clientName (contacts never listed)', async () => {
    const contactRes = await app.inject({
      method: 'POST',
      url: `/api/clients/${clientA}/contacts`,
      headers: { cookie: superuserCookie },
      payload: { name: 'Ada Client', email: 'ada@users.test' },
    })
    expect(contactRes.statusCode).toBe(201)

    const res = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: agentCookie } })
    expect(res.statusCode).toBe(200)
    const rows = res.json()
    expect(rows.map((row: { email: string }) => row.email)).not.toContain('ada@users.test')
    const agent = rows.find((row: { id: string }) => row.id === agentUserId)
    expect(agent).toMatchObject({ clientId: null, clientName: null })
    const ownerRow = rows.find((row: { email: string }) => row.email === owner.ownerEmail)
    expect(ownerRow).toMatchObject({ role: 'superuser', clientId: null })
  })

  it('assigns a client to a staff member and audits it', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/users/${agentUserId}`,
      headers: { cookie: superuserCookie, 'content-type': 'application/json' },
      payload: { clientId: clientA },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ id: agentUserId, clientId: clientA })

    const list = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: superuserCookie } })
    const agent = list.json().find((row: { id: string }) => row.id === agentUserId)
    expect(agent).toMatchObject({ clientId: clientA, clientName: 'Acme Corp' })

    const [auditRow] = await db
      .select({ action: audit.action, entityId: audit.entityId })
      .from(audit)
      .where(eq(audit.entityId, agentUserId))
      .orderBy(desc(audit.createdAt))
      .limit(1)
    expect(auditRow).toMatchObject({ action: 'user.client' })
  })

  it('clears the association with null', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/users/${agentUserId}`,
      headers: { cookie: superuserCookie, 'content-type': 'application/json' },
      payload: { clientId: null },
    })
    expect(res.statusCode).toBe(200)
    const list = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: superuserCookie } })
    const agent = list.json().find((row: { id: string }) => row.id === agentUserId)
    expect(agent).toMatchObject({ clientId: null, clientName: null })
  })

  it('rejects non-superuser assignment with 403', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/users/${agentUserId}`,
      headers: { cookie: agentCookie, 'content-type': 'application/json' },
      payload: { clientId: clientA },
    })
    expect(res.statusCode).toBe(403)
  })

  it('404s an unknown user and an unknown client', async () => {
    const unknownUser = await app.inject({
      method: 'PATCH',
      url: '/api/users/00000000-0000-0000-0000-000000000000',
      headers: { cookie: superuserCookie, 'content-type': 'application/json' },
      payload: { clientId: clientA },
    })
    expect(unknownUser.statusCode).toBe(404)

    const unknownClient = await app.inject({
      method: 'PATCH',
      url: `/api/users/${agentUserId}`,
      headers: { cookie: superuserCookie, 'content-type': 'application/json' },
      payload: { clientId: '00000000-0000-0000-0000-000000000000' },
    })
    expect(unknownClient.statusCode).toBe(404)

    const list = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: superuserCookie } })
    const agent = list.json().find((row: { id: string }) => row.id === agentUserId)
    expect(agent.clientId).toBeNull()
  })

  it('rejects assigning a contact (they belong via their portal accounts)', async () => {
    const contactRes = await app.inject({
      method: 'POST',
      url: `/api/clients/${clientB}/contacts`,
      headers: { cookie: superuserCookie },
      payload: { name: 'Ben Contact', email: 'ben@users.test' },
    })
    expect(contactRes.statusCode).toBe(201)
    const contactRecordId = contactRes.json().id
    const contactUserId = randomUUID()
    await db.insert(users).values({
      id: contactUserId,
      name: 'Ben Contact',
      email: 'ben@users.test',
      role: 'contact',
      contactId: contactRecordId,
    })

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/users/${contactUserId}`,
      headers: { cookie: superuserCookie, 'content-type': 'application/json' },
      payload: { clientId: clientA },
    })
    expect(res.statusCode).toBe(400)
  })

  it('nulls the staff association when the client is deleted (on delete set null)', async () => {
    await app.inject({
      method: 'PATCH',
      url: `/api/users/${agentUserId}`,
      headers: { cookie: superuserCookie, 'content-type': 'application/json' },
      payload: { clientId: clientB },
    })
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/clients/${clientB}`,
      headers: { cookie: superuserCookie },
    })
    expect(del.statusCode).toBe(204)

    const list = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: superuserCookie } })
    const agent = list.json().find((row: { id: string }) => row.id === agentUserId)
    expect(agent).toMatchObject({ clientId: null, clientName: null })
  })
})
