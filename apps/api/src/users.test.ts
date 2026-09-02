import { randomUUID } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { db } from './db'
import { runMigrations } from './db/migrate'
import { accounts, audit, clients, contactClients, contacts, settings, tickets, updates, users } from './db/schema'

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

async function createStaffUser(name: string, email: string, role: string, password: string) {
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

describe('user list', () => {
  let app: App
  let staffCookie: string
  let contactCookie: string

  beforeAll(async () => {
    await runMigrations()
    await db.delete(updates)
    await db.delete(tickets)
    await db.delete(contactClients)
    await db.delete(contacts)
    await db.delete(clients)
    await db.delete(audit)
    await db.delete(users)
    await db.delete(settings)
    app = await buildApp()
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: owner })
    expect(setup.statusCode).toBe(200)
    staffCookie = await signIn(app, owner.ownerEmail, owner.password)

    await createStaffUser('Riley Agent', 'riley@kuliklabs.dev', 'agent', 'riley-pass-123')
    const contactId = randomUUID()
    await db.insert(users).values({
      id: contactId,
      name: 'Ada Client',
      email: 'ada@acme.test',
      role: 'contact',
    })
    await db.insert(accounts).values({
      id: randomUUID(),
      providerId: 'credential',
      issuer: 'local:credential',
      accountId: contactId,
      userId: contactId,
      password: await hashPassword('ada-contact-pass'),
    })
    contactCookie = await signIn(app, 'ada@acme.test', 'ada-contact-pass')
  })

  afterAll(async () => {
    await app.close()
    await db.delete(updates)
    await db.delete(tickets)
    await db.delete(contactClients)
    await db.delete(contacts)
    await db.delete(clients)
    await db.delete(audit)
    await db.delete(users)
    await db.delete(settings)
  })

  it('lists staff users only, ordered by name', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: staffCookie } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.map((u: { email: string }) => u.email)).toEqual([
      'max@kuliklabs.dev',
      'riley@kuliklabs.dev',
    ])
    expect(body.every((u: { role: string }) => u.role !== 'contact')).toBe(true)
  })

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/users' })
    expect(res.statusCode).toBe(401)
  })

  it('forbids contact users', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/users', headers: { cookie: contactCookie } })
    expect(res.statusCode).toBe(403)
  })
})


describe('presence resets to online on sign-in (staff only)', () => {
  let app: App

  beforeAll(async () => {
    await runMigrations()
    await db.delete(updates)
    await db.delete(tickets)
    await db.delete(contactClients)
    await db.delete(contacts)
    await db.delete(clients)
    await db.delete(audit)
    await db.delete(users)
    await db.delete(settings)
    app = await buildApp()
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: owner })
    expect(setup.statusCode).toBe(200)
  })

  afterAll(async () => {
    await app.close()
    await db.delete(updates)
    await db.delete(tickets)
    await db.delete(contactClients)
    await db.delete(contacts)
    await db.delete(clients)
    await db.delete(audit)
    await db.delete(users)
    await db.delete(settings)
  })

  it('resets staff presence to online on every sign-in', async () => {
    let cookie = await signIn(app, owner.ownerEmail, owner.password)
    const away = await app.inject({
      method: 'PATCH',
      url: '/api/me/presence',
      headers: { cookie },
      payload: { presence: 'away' },
    })
    expect(away.statusCode).toBe(200)
    expect(away.json()).toEqual({ presence: 'away' })

    // a fresh session (re-authentication) puts the staff user back online
    cookie = await signIn(app, owner.ownerEmail, owner.password)
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })
    expect(me.statusCode).toBe(200)
    expect(me.json().user.presence).toBe('online')
  })

  it('leaves contact presence untouched on sign-in', async () => {
    const contactId = randomUUID()
    await db.insert(users).values({
      id: contactId,
      name: 'Ada Client',
      email: 'ada@acme.test',
      role: 'contact',
    })
    await db.insert(accounts).values({
      id: randomUUID(),
      providerId: 'credential',
      issuer: 'local:credential',
      accountId: contactId,
      userId: contactId,
      password: await hashPassword('ada-contact-pass'),
    })
    const contactCookie = await signIn(app, 'ada@acme.test', 'ada-contact-pass')
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: contactCookie } })
    expect(me.statusCode).toBe(200)
    expect(me.json().user.presence).toBe('offline')
  })
})

