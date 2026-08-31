import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { db } from './db'
import { runMigrations } from './db/migrate'
import {
  clients,
  contactClients,
  contacts,
  emailOutbox,
  settings,
  tickets,
  updates,
  users,
  verifications,
} from './db/schema'
import { closeMail } from './mail'

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

function firstSetCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie']
  const list = Array.isArray(raw) ? raw : [raw]
  return String(list.find(Boolean) ?? '').split(';')[0]
}

async function wipe() {
  await db.delete(verifications)
  await db.delete(emailOutbox)
  await db.delete(updates)
  await db.delete(tickets)
  await db.delete(contactClients)
  await db.delete(contacts)
  await db.delete(clients)
  await db.delete(users)
  await db.delete(settings)
}

describe('magic link login + client portal access', () => {
  let app: App
  let staffCookie: string
  let contactId: string
  let portalUserId: string
  let adaSessionCookie: string

  beforeAll(async () => {
    await runMigrations()
    await wipe()
    app = await buildApp()

    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: owner })
    expect(setup.statusCode).toBe(200)
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: owner.ownerEmail, password: owner.password },
    })
    expect(login.statusCode).toBe(200)
    staffCookie = cookiesFrom(login)

    const resA = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie: staffCookie },
      payload: { name: 'Acme Corp', domain: 'acme.test' },
    })
    expect(resA.statusCode).toBe(201)
    const clientA = resA.json().id

    const contactRes = await app.inject({
      method: 'POST',
      url: `/api/clients/${clientA}/contacts`,
      headers: { cookie: staffCookie },
      payload: { name: 'Ada Client', email: 'ada@acme.test' },
    })
    expect(contactRes.statusCode).toBe(201)
    contactId = contactRes.json().id

    const saveRes = await app.inject({
      method: 'POST',
      url: '/api/email',
      headers: { cookie: staffCookie },
      payload: {
        domain: 'kuliklabs.dev',
        provider: 'smtp',
        smtp: {
          host: '127.0.0.1',
          port: 2525,
          secure: false,
          startTls: false,
          from: 'support@kuliklabs.dev',
        },
      },
    })
    expect(saveRes.statusCode).toBe(200)
  })

  afterAll(async () => {
    await app.close()
    await closeMail()
    await wipe()
  })

  it('provisions a portal user for a contact (idempotent)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/contacts/${contactId}/portal`,
      headers: { cookie: staffCookie },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({
      email: 'ada@acme.test',
      name: 'Ada Client',
      existing: false,
    })
    portalUserId = res.json().userId

    const [user] = await db.select().from(users).where(eq(users.id, portalUserId))
    expect(user.role).toBe('contact')
    expect(user.contactId).toBe(contactId)

    const again = await app.inject({
      method: 'POST',
      url: `/api/contacts/${contactId}/portal`,
      headers: { cookie: staffCookie },
    })
    expect(again.statusCode).toBe(200)
    expect(again.json()).toMatchObject({ userId: portalUserId, existing: true })
  })

  it('sends a magic link email to a contact and the link signs them in', async () => {
    const before = await db
      .select({ id: emailOutbox.id })
      .from(emailOutbox)

    const reqRes = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/magic-link',
      payload: { email: 'ada@acme.test', callbackURL: '/portal' },
    })
    expect(reqRes.statusCode).toBe(200)
    expect(reqRes.json()).toEqual({ status: true })

    const [row] = await db.select().from(emailOutbox).orderBy(emailOutbox.createdAt)
    expect(row).toBeDefined()
    expect(before.length + 1).toBe((await db.select({ id: emailOutbox.id }).from(emailOutbox)).length)
    expect(row.to).toBe('ada@acme.test')
    expect(row.subject).toContain('Sign in to Kulik Labs IT')
    expect(row.body).toContain('/api/auth/magic-link/verify')

    const linkUrl = row.body
      .split('\n')
      .find((line) => line.startsWith('http')) as string
    const target = new URL(linkUrl)
    const verifyRes = await app.inject({
      method: 'GET',
      url: `${target.pathname}${target.search}`,
    })
    expect(verifyRes.statusCode).toBe(302)
    const expectedLocation = new URL(
      '/portal',
      process.env.PUBLIC_URL ?? 'http://localhost:3000',
    ).toString()
    expect(verifyRes.headers.location).toBe(expectedLocation)

    const sessionCookie = firstSetCookie(verifyRes)
    expect(sessionCookie).toBeTruthy()
    adaSessionCookie = sessionCookie
    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: sessionCookie },
    })
    expect(me.statusCode).toBe(200)
    const meBody = me.json()
    expect(meBody.user.email).toBe('ada@acme.test')
    expect(meBody.user.role).toBe('contact')
    expect(meBody.primaryClient).toEqual({
      id: expect.any(String),
      name: 'Acme Corp',
      domain: 'acme.test',
    })
  })

  it('consumes the token: the same link cannot be used twice', async () => {
    const [row] = await db.select().from(emailOutbox).orderBy(emailOutbox.createdAt)
    const linkUrl = row.body
      .split('\n')
      .find((line) => line.startsWith('http')) as string
    const target = new URL(linkUrl)
    const verifyRes = await app.inject({
      method: 'GET',
      url: `${target.pathname}${target.search}`,
    })
    expect(verifyRes.statusCode).toBe(302)
    expect(verifyRes.headers.location).toContain('error=INVALID_TOKEN')
  })

  it('does not send a link for unknown emails (no enumeration)', async () => {
    const before = (await db.select({ id: emailOutbox.id }).from(emailOutbox)).length
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/magic-link',
      payload: { email: 'ghost@nowhere.test', callbackURL: '/portal' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: true })
    const after = (await db.select({ id: emailOutbox.id }).from(emailOutbox)).length
    expect(after).toBe(before)
  })

  it('does not send a link for staff accounts', async () => {
    const before = (await db.select({ id: emailOutbox.id }).from(emailOutbox)).length
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/magic-link',
      payload: { email: owner.ownerEmail, callbackURL: '/' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: true })
    const after = (await db.select({ id: emailOutbox.id }).from(emailOutbox)).length
    expect(after).toBe(before)
  })

  it('does not send a link for contacts without a portal account', async () => {
    const client = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie: staffCookie },
      payload: { name: 'Globex', domain: 'globex.test' },
    })
    expect(client.statusCode).toBe(201)
    const contact = await app.inject({
      method: 'POST',
      url: `/api/clients/${client.json().id}/contacts`,
      headers: { cookie: staffCookie },
      payload: { name: 'Bob Globex', email: 'bob@globex.test' },
    })
    expect(contact.statusCode).toBe(201)

    const before = (await db.select({ id: emailOutbox.id }).from(emailOutbox)).length
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/magic-link',
      payload: { email: 'bob@globex.test', callbackURL: '/portal' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: true })
    const after = (await db.select({ id: emailOutbox.id }).from(emailOutbox)).length
    expect(after).toBe(before)
  })

  it('blocks public email sign-up once the instance has users', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: {
        name: 'Rogue',
        email: 'rogue@evil.test',
        password: 'i-want-in-please-1',
      },
    })
    expect(res.statusCode).toBe(403)
    const [rogue] = await db.select().from(users).where(eq(users.email, 'rogue@evil.test'))
    expect(rogue).toBeUndefined()
  })

  it('lets the contact portal user list and create scoped tickets', async () => {
    if (!adaSessionCookie) {
      const reqRes = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/magic-link',
        payload: { email: 'ada@acme.test', callbackURL: '/portal' },
      })
      expect(reqRes.statusCode).toBe(200)
      const [row] = await db.select().from(emailOutbox).orderBy(emailOutbox.createdAt)
      const target = new URL(
        row.body.split('\n').find((line) => line.startsWith('http')) as string,
      )
      const verifyRes = await app.inject({
        method: 'GET',
        url: `${target.pathname}${target.search}`,
      })
      expect(verifyRes.statusCode).toBe(302)
      adaSessionCookie = firstSetCookie(verifyRes)
    }
    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: adaSessionCookie },
    })
    expect(me.statusCode).toBe(200)
    const clientId = me.json().primaryClient.id
    const cookie = adaSessionCookie

    const created = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: cookie },
      payload: { clientId, subject: 'VPN down', body: 'Cannot connect to the VPN.' },
    })
    expect(created.statusCode).toBe(201)

    const list = await app.inject({
      method: 'GET',
      url: '/api/tickets',
      headers: { cookie: cookie },
    })
    expect(list.statusCode).toBe(200)
    const rows = list.json()
    expect(rows).toHaveLength(1)
    expect(rows[0].subject).toBe('VPN down')

    const detail = await app.inject({
      method: 'GET',
      url: `/api/tickets/${rows[0].id}`,
      headers: { cookie: cookie },
    })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().updates).toHaveLength(1)
    expect(detail.json().updates[0].kind).toBe('public')

    const replyRes = await app.inject({
      method: 'POST',
      url: `/api/tickets/${rows[0].id}/updates`,
      headers: { cookie: cookie },
      payload: { kind: 'internal', body: 'clients cannot write internal notes' },
    })
    expect(replyRes.statusCode).toBe(201)
    expect(replyRes.json().kind).toBe('public')
  })
})
