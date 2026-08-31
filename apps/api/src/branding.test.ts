import { randomUUID } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
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
  emailMessages,
  emailOutbox,
  emailTemplates,
  notifications,
  ruleRuns,
  rules,
  sessions,
  settings,
  slaPolicies,
  tickets,
  timeEntries,
  twoFactor,
  updates,
  users,
  verifications,
} from './db/schema'

type App = Awaited<ReturnType<typeof buildApp>>

const owner = {
  instanceName: 'Kulip Branding',
  ownerName: 'Max Branding',
  ownerEmail: 'max@branding.test',
  password: 'correct-horse-branding',
}

function cookiesFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie']
  const list = Array.isArray(raw) ? raw : [raw]
  return list
    .filter(Boolean)
    .map((cookie) => String(cookie).split(';')[0])
    .join('; ')
}

async function wipe() {
  await db.delete(verifications)
  await db.delete(twoFactor)
  await db.delete(sessions)
  await db.delete(notifications)
  await db.delete(ruleRuns)
  await db.delete(rules)
  await db.delete(emailTemplates)
  await db.delete(emailMessages)
  await db.delete(emailOutbox)
  await db.delete(timeEntries)
  await db.delete(updates)
  await db.delete(tickets)
  await db.delete(slaPolicies)
  await db.delete(contactClients)
  await db.delete(contacts)
  await db.delete(clients)
  await db.delete(audit)
  await db.delete(users)
  await db.delete(settings)
}

describe('client branding', () => {
  let app: App
  let staffCookie: string
  let contactCookie: string
  let clientA: string
  let clientB: string

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
      payload: {
        name: 'Acme Corp',
        branding: {
          themeId: 'slate',
          accent: '#0b5fff',
          logoUrl: 'https://cdn.acme.test/logo.png',
        },
      },
    })
    expect(resA.statusCode).toBe(201)
    clientA = resA.json().id

    const resB = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie: staffCookie },
      payload: { name: 'Globex', branding: { accent: '#ff0000' } },
    })
    expect(resB.statusCode).toBe(201)
    clientB = resB.json().id

    const contactRes = await app.inject({
      method: 'POST',
      url: `/api/clients/${clientA}/contacts`,
      headers: { cookie: staffCookie },
      payload: { name: 'Ada Client', email: 'ada@branding.test' },
    })
    expect(contactRes.statusCode).toBe(201)
    const contactRecordId = contactRes.json().id

    const contactUserId = randomUUID()
    await db.insert(users).values({
      id: contactUserId,
      name: 'Ada Client',
      email: 'ada@branding.test',
      role: 'contact',
      contactId: contactRecordId,
    })
    await db.insert(accounts).values({
      id: randomUUID(),
      providerId: 'credential',
      issuer: 'local:credential',
      accountId: contactUserId,
      userId: contactUserId,
      password: await hashPassword('ada-branding-pass'),
    })
    const contactLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'ada@branding.test', password: 'ada-branding-pass' },
    })
    expect(contactLogin.statusCode).toBe(200)
    contactCookie = cookiesFrom(contactLogin)
  })

  afterAll(async () => {
    await app.close()
    await wipe()
  })

  it('stores and returns branding on create', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/clients/${clientA}`,
      headers: { cookie: staffCookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().branding).toEqual({
      themeId: 'slate',
      accent: '#0b5fff',
      logoUrl: 'https://cdn.acme.test/logo.png',
    })
  })

  it('rejects agent-only themes as a portal branding theme', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie: staffCookie },
      payload: { name: 'Terminal Co', branding: { themeId: 'console' } },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toContain('portal theme')
  })

  it('rejects non-hex accent colors', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie: staffCookie },
      payload: { name: 'Paint Co', branding: { accent: 'rgb(0,0,0)' } },
    })
    expect(res.statusCode).toBe(400)
  })

  it('rejects non-URL logo values', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/clients/${clientB}`,
      headers: { cookie: staffCookie },
      payload: { branding: { logoUrl: 'not a url' } },
    })
    expect(res.statusCode).toBe(400)
  })

  it('stores empty branding as null', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/clients/${clientB}`,
      headers: { cookie: staffCookie },
      payload: { branding: {} },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().branding).toBeNull()
  })

  it('replaces and clears branding via patch', async () => {
    const set = await app.inject({
      method: 'PATCH',
      url: `/api/clients/${clientB}`,
      headers: { cookie: staffCookie },
      payload: { branding: { themeId: 'blush' } },
    })
    expect(set.statusCode).toBe(200)
    expect(set.json().branding).toEqual({ themeId: 'blush' })

    const clear = await app.inject({
      method: 'PATCH',
      url: `/api/clients/${clientB}`,
      headers: { cookie: staffCookie },
      payload: { branding: null },
    })
    expect(clear.statusCode).toBe(200)
    expect(clear.json().branding).toBeNull()
  })

  it('exposes the contact own-client branding on /api/me', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: contactCookie } })
    expect(me.statusCode).toBe(200)
    const body = me.json()
    expect(body.primaryClient.id).toBe(clientA)
    expect(body.primaryClient.branding).toEqual({
      themeId: 'slate',
      accent: '#0b5fff',
      logoUrl: 'https://cdn.acme.test/logo.png',
    })
  })

  it('never surfaces another client branding to a contact', async () => {
    const other = await app.inject({
      method: 'PATCH',
      url: `/api/clients/${clientB}`,
      headers: { cookie: staffCookie },
      payload: { branding: { accent: '#123456', logoUrl: 'https://globex.test/secret.png' } },
    })
    expect(other.statusCode).toBe(200)

    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: contactCookie } })
    expect(me.json().primaryClient.branding.accent).toBe('#0b5fff')
    expect(JSON.stringify(me.json().primaryClient)).not.toContain('globex.test')

    const direct = await app.inject({
      method: 'GET',
      url: `/api/clients/${clientB}`,
      headers: { cookie: contactCookie },
    })
    expect(direct.statusCode).toBe(404)
  })

  it('keeps staff /api/me without a primary client', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: staffCookie } })
    expect(me.statusCode).toBe(200)
    expect(me.json().primaryClient).toBeNull()
  })
})
