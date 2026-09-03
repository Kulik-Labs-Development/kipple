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

describe('superuser role assignment (issue #97)', () => {
  let app: App
  let superCookie: string
  let adminCookie: string
  let agentCookie: string
  let ownerUserId: string
  let agentUserId: string

  beforeAll(async () => {
    await runMigrations()
    await wipe()
    app = await buildApp()
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: owner })
    expect(setup.statusCode).toBe(200)
    superCookie = await signIn(app, owner.ownerEmail, owner.password)
    await createUserRow('Dana Admin', 'dana@kuliklabs.dev', 'admin', 'dana-pass-123')
    adminCookie = await signIn(app, 'dana@kuliklabs.dev', 'dana-pass-123')
    agentUserId = await createUserRow('Pat Agent', 'pat@kuliklabs.dev', 'agent', 'pat-pass-123')
    agentCookie = await signIn(app, 'pat@kuliklabs.dev', 'pat-pass-123')
    const [ownerRow] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, owner.ownerEmail))
    ownerUserId = ownerRow.id
  })

  afterAll(async () => {
    await app.close()
    await wipe()
  })

  it('promotes an agent to superuser (superuser-only, audited)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/users/${agentUserId}/role`,
      headers: { cookie: superCookie },
      payload: { role: 'superuser' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().role).toBe('superuser')
    const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, agentUserId))
    expect(row.role).toBe('superuser')
    const auditRows = await db.select().from(audit).where(eq(audit.action, 'user.role'))
    expect(auditRows.length).toBe(1)
    expect(auditRows[0].actorId).toBe(ownerUserId)
    expect(auditRows[0].meta).toMatchObject({ from: 'agent', to: 'superuser' })
  })

  it('revokes superuser back to agent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/users/${agentUserId}/role`,
      headers: { cookie: superCookie },
      payload: { role: 'agent' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().role).toBe('agent')
    const auditRows = await db.select().from(audit).where(eq(audit.action, 'user.role'))
    expect(auditRows.length).toBe(2)
    expect(auditRows[1].meta).toMatchObject({ from: 'superuser', to: 'agent' })
  })

  it('lets a superuser step down once another superuser exists', async () => {
    const suTwo = await createUserRow('Su Two', 'su2@kuliklabs.dev', 'superuser', 'su2-pass-123')
    const res = await app.inject({
      method: 'POST',
      url: `/api/users/${suTwo}/role`,
      headers: { cookie: superCookie },
      payload: { role: 'admin' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().role).toBe('admin')
  })

  it('keeps the last superuser from being demoted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/users/${ownerUserId}/role`,
      headers: { cookie: superCookie },
      payload: { role: 'admin' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toMatch(/at least one superuser/)
    const [row] = await db.select({ role: users.role }).from(users).where(eq(users.id, ownerUserId))
    expect(row.role).toBe('superuser')
  })

  it('rejects admin and agent callers', async () => {
    for (const cookie of [adminCookie, agentCookie]) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/users/${ownerUserId}/role`,
        headers: { cookie },
        payload: { role: 'superuser' },
      })
      expect(res.statusCode).toBe(403)
    }
  })

  it('rejects contact targets, unknown ids and invalid roles', async () => {
    const contact = await createUserRow('Cy Contact', 'cy@acme.test', 'contact', 'cy-pass-123')
    const contactRes = await app.inject({
      method: 'POST',
      url: `/api/users/${contact}/role`,
      headers: { cookie: superCookie },
      payload: { role: 'admin' },
    })
    expect(contactRes.statusCode).toBe(400)
    const unknownRes = await app.inject({
      method: 'POST',
      url: `/api/users/${randomUUID()}/role`,
      headers: { cookie: superCookie },
      payload: { role: 'agent' },
    })
    expect(unknownRes.statusCode).toBe(404)
    const badRes = await app.inject({
      method: 'POST',
      url: `/api/users/${agentUserId}/role`,
      headers: { cookie: superCookie },
      payload: { role: 'owner' },
    })
    expect(badRes.statusCode).toBe(400)
  })
})
