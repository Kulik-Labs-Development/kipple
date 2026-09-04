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
  instanceName: 'Kulik Portal',
  ownerName: 'Max Portal',
  ownerEmail: 'max@portal.test',
  password: 'correct-horse-portal',
}

// 1x1 transparent PNG (67 bytes)
const PNG_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444174789c6260010000000500010d0a2db40000000049454e44ae426082',
  'hex',
)

function cookiesFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie']
  const list = Array.isArray(raw) ? raw : [raw]
  return list
    .filter(Boolean)
    .map((cookie) => String(cookie).split(';')[0])
    .join('; ')
}

type Part = { name: string; filename?: string; contentType?: string; content: string | Buffer }

function multipartBody(boundary: string, parts: Part[]): Buffer {
  const chunks: Buffer[] = []
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`))
    chunks.push(
      Buffer.from(
        part.filename
          ? `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`
          : `Content-Disposition: form-data; name="${part.name}"\r\n`,
      ),
    )
    chunks.push(Buffer.from(`Content-Type: ${part.contentType ?? 'text/plain'}\r\n\r\n`))
    chunks.push(Buffer.isBuffer(part.content) ? part.content : Buffer.from(part.content))
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(chunks)
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

describe('pre-sign-in portal branding (login screen)', () => {
  let app: App
  let staffCookie: string
  let clientA: string
  let clientB: string
  let clientC: string

  const adaEmail = 'ada@portal.test'
  const benEmail = 'ben@portal.test'
  const caraEmail = 'cara@portal.test'

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
      payload: { name: 'Acme Corp' },
    })
    expect(resA.statusCode).toBe(201)
    clientA = resA.json().id

    const resB = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie: staffCookie },
      payload: { name: 'Globex', branding: { logoUrl: 'https://cdn.globex.test/logo.png' } },
    })
    expect(resB.statusCode).toBe(201)
    clientB = resB.json().id

    const resC = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie: staffCookie },
      payload: { name: 'Initech' },
    })
    expect(resC.statusCode).toBe(201)
    clientC = resC.json().id

    // clientA gets an uploaded logo (key form) — the login screen must serve it
    const boundary = `kbportal${randomUUID().replace(/-/g, '')}`
    const upload = await app.inject({
      method: 'POST',
      url: `/api/clients/${clientA}/logo`,
      headers: { cookie: staffCookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, [
        { name: 'file', filename: 'acme.png', contentType: 'image/png', content: PNG_BYTES },
      ]),
    })
    expect(upload.statusCode).toBe(200)

    // contacts: ada -> A (uploaded logo), ben -> B (external URL)
    for (const [clientId, name, email, password] of [
      [clientA, 'Ada Client', adaEmail, 'ada-portal-pass'],
      [clientB, 'Ben Client', benEmail, 'ben-portal-pass'],
    ] as const) {
      const contactRes = await app.inject({
        method: 'POST',
        url: `/api/clients/${clientId}/contacts`,
        headers: { cookie: staffCookie },
        payload: { name, email },
      })
      expect(contactRes.statusCode).toBe(201)
      const contactId = contactRes.json().id
      const userId = randomUUID()
      await db.insert(users).values({ id: userId, name, email, role: 'contact', contactId })
      await db.insert(accounts).values({
        id: randomUUID(),
        providerId: 'credential',
        issuer: 'local:credential',
        accountId: userId,
        userId,
        password: await hashPassword(password),
      })
    }

    // cara is linked to C (primary) AND A (non-primary) — resolution must
    // pick the primary link (the same isPrimary-first rule /api/me uses)
    const caraContactId = randomUUID()
    await db.insert(contacts).values({ id: caraContactId, name: 'Cara Client', email: caraEmail })
    await db.insert(contactClients).values({ contactId: caraContactId, clientId: clientC, isPrimary: true })
    await db.insert(contactClients).values({ contactId: caraContactId, clientId: clientA, isPrimary: false })
    const caraUserId = randomUUID()
    await db.insert(users).values({ id: caraUserId, name: 'Cara Client', email: caraEmail, role: 'contact', contactId: caraContactId })
    await db.insert(accounts).values({
      id: randomUUID(),
      providerId: 'credential',
      issuer: 'local:credential',
      accountId: caraUserId,
      userId: caraUserId,
      password: await hashPassword('cara-portal-pass'),
    })
  })

  afterAll(async () => {
    await app.close()
    await wipe()
  })

  async function brandingFor(email: string) {
    return app.inject({
      method: 'POST',
      url: '/api/portal/branding',
      headers: { 'content-type': 'application/json' },
      payload: { email },
    })
  }

  it('returns the client name + a resolvable logo for a known contact (unauthenticated)', async () => {
    const res = await brandingFor(adaEmail)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      clientName: 'Acme Corp',
      logoUrl: `/api/portal/logo?email=${encodeURIComponent(adaEmail)}`,
      selfRegister: false,
    })

    const logo = await app.inject({ method: 'GET', url: res.json().logoUrl })
    expect(logo.statusCode).toBe(200)
    expect(logo.headers['content-type']).toContain('image/png')
    expect(logo.rawPayload.equals(PNG_BYTES)).toBe(true)
  })

  it('resolves the email case-insensitively', async () => {
    const res = await brandingFor(adaEmail.toUpperCase())
    expect(res.statusCode).toBe(200)
    expect(res.json().clientName).toBe('Acme Corp')
  })

  it('returns nulls for unknown, staff, and malformed emails; 400 for a bad body', async () => {
    for (const email of ['nobody@nowhere.test', owner.ownerEmail]) {
      const res = await brandingFor(email)
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ clientName: null, logoUrl: null, selfRegister: false })
    }
    for (const body of [{}, { email: 'nope' }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/portal/branding',
        headers: { 'content-type': 'application/json' },
        payload: body,
      })
      expect(res.statusCode).toBe(400)
    }
  })

  it('keeps external-URL logos untouched and 404s the key-serve route for them', async () => {
    const res = await brandingFor(benEmail)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({
      clientName: 'Globex',
      logoUrl: 'https://cdn.globex.test/logo.png',
      selfRegister: false,
    })
    const logo = await app.inject({
      method: 'GET',
      url: `/api/portal/logo?email=${encodeURIComponent(benEmail)}`,
    })
    expect(logo.statusCode).toBe(404)
  })

  it('never crosses clients: one contact email cannot surface another client branding', async () => {
    const ada = await brandingFor(adaEmail)
    expect(JSON.stringify(ada.json())).not.toContain('Globex')
    expect(JSON.stringify(ada.json())).not.toContain('globex.test')
    const ben = await brandingFor(benEmail)
    expect(JSON.stringify(ben.json())).not.toContain('Acme')
    expect(JSON.stringify(ben.json())).not.toContain(`client-logo-${clientA}`)

    // and the key-serve route re-resolves the email: ada's logo URL must not
    // serve when a different contact's email is used
    const foreign = await app.inject({
      method: 'GET',
      url: `/api/portal/logo?email=${encodeURIComponent(benEmail)}`,
    })
    expect(foreign.statusCode).toBe(404)
  })

  it('resolves the primary client when a contact is linked to several', async () => {
    const res = await brandingFor(caraEmail)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ clientName: 'Initech', logoUrl: null, selfRegister: false })
  })

  it('stops serving the logo after it is removed', async () => {
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/clients/${clientA}/logo`,
      headers: { cookie: staffCookie },
    })
    expect(del.statusCode).toBe(200)

    const res = await brandingFor(adaEmail)
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ clientName: 'Acme Corp', logoUrl: null, selfRegister: false })

    const logo = await app.inject({
      method: 'GET',
      url: `/api/portal/logo?email=${encodeURIComponent(adaEmail)}`,
    })
    expect(logo.statusCode).toBe(404)
  })
})
