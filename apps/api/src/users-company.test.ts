import { randomUUID } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import { eq } from 'drizzle-orm'
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
  instanceName: 'Kulik Labs IT',
  ownerName: 'Max Kulik',
  ownerEmail: 'max@kuliklabs.dev',
  password: 'correct-horse-battery',
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

async function signInStatus(app: App, email: string, password: string): Promise<number> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email, password },
  })
  return res.statusCode
}

async function createUserRow(name: string, email: string, role: string, password: string): Promise<string> {
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

describe('company settings — add/remove staff (UI triage item 15)', () => {
  let app: App
  let superCookie: string
  let adminCookie: string
  let ownerUserId: string
  let clientId: string

  beforeAll(async () => {
    await runMigrations()
    await wipe()
    app = await buildApp()
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: owner })
    expect(setup.statusCode).toBe(200)
    superCookie = await signIn(app, owner.ownerEmail, owner.password)
    await createUserRow('Dana Admin', 'dana@kuliklabs.dev', 'admin', 'dana-pass-123')
    adminCookie = await signIn(app, 'dana@kuliklabs.dev', 'dana-pass-123')
    const [ownerRow] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, owner.ownerEmail))
    ownerUserId = ownerRow.id
    clientId = randomUUID()
    await db.insert(clients).values({ id: clientId, name: 'Acme Robotics' })
  })

  afterAll(async () => {
    await app.close()
    await wipe()
  })

  it('creates a staff account that can sign in (superuser only, audited)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: superCookie },
      payload: { name: 'Pat Agent', email: 'pat@kuliklabs.dev', password: 'pat-pass-123' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.name).toBe('Pat Agent')
    expect(body.email).toBe('pat@kuliklabs.dev')
    expect(body.role).toBe('agent')
    expect(await signIn(app, 'pat@kuliklabs.dev', 'pat-pass-123')).toBeTruthy()
    const auditRows = await db.select().from(audit).where(eq(audit.action, 'user.create'))
    expect(auditRows.length).toBe(1)
    expect(auditRows[0].actorId).toBe(ownerUserId)
    expect(auditRows[0].meta).toMatchObject({ email: 'pat@kuliklabs.dev', role: 'agent' })
  })

  it('creates an admin when asked', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: superCookie },
      payload: {
        name: 'Remy Admin',
        email: 'remy@kuliklabs.dev',
        password: 'remy-pass-123',
        role: 'admin',
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().role).toBe('admin')
  })

  it('never creates superusers through the endpoint', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: superCookie },
      payload: {
        name: 'Evil Su',
        email: 'evil@kuliklabs.dev',
        password: 'evil-pass-123',
        role: 'superuser',
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects a duplicate email with 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: superCookie },
      payload: { name: 'Sam Agent', email: 'sam@kuliklabs.dev', password: 'sam-pass-123' },
    })
    expect(res.statusCode).toBe(200)
    const again = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: superCookie },
      payload: { name: 'Sam Clone', email: 'sam@kuliklabs.dev', password: 'sam-pass-123' },
    })
    expect(again.statusCode).toBe(409)
    expect(again.json().error).toBe('conflict')
  })

  it('rejects invalid bodies with 400', async () => {
    const shortName = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: superCookie },
      payload: { name: 'P', email: 'p@kuliklabs.dev', password: 'p-pass-12345' },
    })
    expect(shortName.statusCode).toBe(400)
    const shortPassword = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: superCookie },
      payload: { name: 'Peggy Good Name', email: 'peggy@kuliklabs.dev', password: 'short' },
    })
    expect(shortPassword.statusCode).toBe(400)
  })

  it('forbids non-superusers', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: adminCookie },
      payload: { name: 'Nope Agent', email: 'nope@kuliklabs.dev', password: 'nope-pass-123' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('removes a staff account — sign-in stops, audit row kept', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: superCookie },
      payload: { name: 'Tess Agent', email: 'tess@kuliklabs.dev', password: 'tess-pass-123' },
    })
    expect(res.statusCode).toBe(200)
    const userId = res.json().id
    await signIn(app, 'tess@kuliklabs.dev', 'tess-pass-123')
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/users/${userId}`,
      headers: { cookie: superCookie },
    })
    expect(del.statusCode).toBe(200)
    const [gone] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId))
    expect(gone).toBeUndefined()
    expect(await signInStatus(app, 'tess@kuliklabs.dev', 'tess-pass-123')).toBe(401)
    const auditRows = await db.select().from(audit).where(eq(audit.action, 'user.delete'))
    expect(auditRows.length).toBe(1)
    expect(auditRows[0].entityId).toBe(userId)
    expect(auditRows[0].actorId).toBe(ownerUserId)
  })

  it('refuses to remove the signed-in user', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/users/${ownerUserId}`,
      headers: { cookie: superCookie },
    })
    expect(res.statusCode).toBe(400)
  })

  it('refuses to remove a contact', async () => {
    const contactId = await createUserRow('Ada Client', 'ada@acme.test', 'contact', 'ada-contact-pass')
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/users/${contactId}`,
      headers: { cookie: superCookie },
    })
    expect(res.statusCode).toBe(400)
  })

  it('unattributes tickets/updates instead of failing the delete (migration 0011)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: superCookie },
      payload: { name: 'Uma Agent', email: 'uma@kuliklabs.dev', password: 'uma-pass-123' },
    })
    expect(res.statusCode).toBe(200)
    const umaId = res.json().id
    const ticketId = randomUUID()
    await db.insert(tickets).values({
      id: ticketId,
      clientId,
      subject: 'Firmware for the Milwaukee office',
      assignedTo: umaId,
      createdBy: umaId,
    })
    await db.insert(updates).values({ id: randomUUID(), ticketId, authorId: umaId, kind: 'internal', body: 'head start' })
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/users/${umaId}`,
      headers: { cookie: superCookie },
    })
    expect(del.statusCode).toBe(200)
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId))
    expect(ticket.assignedTo).toBeNull()
    expect(ticket.createdBy).toBeNull()
    const [update] = await db.select().from(updates).where(eq(updates.ticketId, ticketId))
    expect(update.authorId).toBeNull()
    // the queue still renders the ticket (author unattributed, not missing)
    const list = await app.inject({
      method: 'GET',
      url: '/api/tickets',
      headers: { cookie: superCookie },
    })
    expect(list.statusCode).toBe(200)
    expect(list.json().some((t: { id: string }) => t.id === ticketId)).toBe(true)
  })
})
