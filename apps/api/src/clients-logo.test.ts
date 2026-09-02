import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
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
import { attachmentFileSize, attachmentPath, maxLogoBytes } from './storage'

type App = Awaited<ReturnType<typeof buildApp>>

const owner = {
  instanceName: 'Kulik Logo',
  ownerName: 'Max Logo',
  ownerEmail: 'max@logo.test',
  password: 'correct-horse-logo',
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

function logoKeyFor(clientId: string): string {
  return `client-logo-${clientId}`
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

describe('client logo upload', () => {
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

    // contact on clientA (the scoping test subject)
    const contactRes = await app.inject({
      method: 'POST',
      url: `/api/clients/${clientA}/contacts`,
      headers: { cookie: staffCookie },
      payload: { name: 'Ada Client', email: 'ada@logo.test' },
    })
    expect(contactRes.statusCode).toBe(201)
    const contactRecordId = contactRes.json().id
    const contactUserId = randomUUID()
    await db.insert(users).values({
      id: contactUserId,
      name: 'Ada Client',
      email: 'ada@logo.test',
      role: 'contact',
      contactId: contactRecordId,
    })
    await db.insert(accounts).values({
      id: randomUUID(),
      providerId: 'credential',
      issuer: 'local:credential',
      accountId: contactUserId,
      userId: contactUserId,
      password: await hashPassword('ada-logo-pass'),
    })
    const contactLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'ada@logo.test', password: 'ada-logo-pass' },
    })
    expect(contactLogin.statusCode).toBe(200)
    contactCookie = cookiesFrom(contactLogin)
  })

  afterAll(async () => {
    await app.close()
    await wipe()
  })

  async function uploadLogo(
    cookie: string,
    clientId: string,
    content: Buffer,
    filename: string,
    contentType: string,
  ) {
    const boundary = `kblogo${randomUUID().replace(/-/g, '')}`
    return app.inject({
      method: 'POST',
      url: `/api/clients/${clientId}/logo`,
      headers: { cookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, [{ name: 'file', filename, contentType, content }]),
    })
  }

  it('uploads a logo, serves it byte-exact with the sniffed content type, and audits it', async () => {
    const upload = await uploadLogo(staffCookie, clientA, PNG_BYTES, 'logo.png', 'image/png')
    expect(upload.statusCode).toBe(200)
    const key = logoKeyFor(clientA)
    expect(upload.json()).toEqual({ logoUrl: key })

    const client = await app.inject({
      method: 'GET',
      url: `/api/clients/${clientA}`,
      headers: { cookie: staffCookie },
    })
    expect(client.json().branding).toEqual({ logoUrl: key })

    const get = await app.inject({
      method: 'GET',
      url: `/api/clients/${clientA}/logo`,
      headers: { cookie: staffCookie },
    })
    expect(get.statusCode).toBe(200)
    expect(get.headers['content-type']).toContain('image/png')
    expect(get.rawPayload.equals(PNG_BYTES)).toBe(true)

    const [auditRow] = await db
      .select({ action: audit.action, entityId: audit.entityId })
      .from(audit)
      .where(eq(audit.entityId, clientA))
      .orderBy(desc(audit.createdAt))
      .limit(1)
    expect(auditRow).toMatchObject({ action: 'client.logo' })
  })

  it('rejects non-image files and multipart bodies without a file part', async () => {
    const txt = await uploadLogo(
      staffCookie,
      clientA,
      Buffer.from('not an image'),
      'notes.txt',
      'text/plain',
    )
    expect(txt.statusCode).toBe(415)

    const boundary = `kblogo${randomUUID().replace(/-/g, '')}`
    const noFile = await app.inject({
      method: 'POST',
      url: `/api/clients/${clientA}/logo`,
      headers: { cookie: staffCookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, [{ name: 'kind', content: 'public' }]),
    })
    expect(noFile.statusCode).toBe(415)

    const client = await app.inject({
      method: 'GET',
      url: `/api/clients/${clientA}`,
      headers: { cookie: staffCookie },
    })
    expect(client.json().branding?.logoUrl).toBe(logoKeyFor(clientA))
  })

  it('removes an uploaded logo and 404s the serve route afterwards', async () => {
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/clients/${clientA}/logo`,
      headers: { cookie: staffCookie },
    })
    expect(del.statusCode).toBe(200)
    expect(del.json()).toEqual({ logoUrl: null })

    const client = await app.inject({
      method: 'GET',
      url: `/api/clients/${clientA}`,
      headers: { cookie: staffCookie },
    })
    expect(client.json().branding).toBeNull()

    const get = await app.inject({
      method: 'GET',
      url: `/api/clients/${clientA}/logo`,
      headers: { cookie: staffCookie },
    })
    expect(get.statusCode).toBe(404)
    expect(await attachmentFileSize(logoKeyFor(clientA))).toBeNull()
  })

  it('leaves external-URL logos untouched: serve 404, remove 400, branding unchanged', async () => {
    const get = await app.inject({
      method: 'GET',
      url: `/api/clients/${clientB}/logo`,
      headers: { cookie: staffCookie },
    })
    expect(get.statusCode).toBe(404)

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/clients/${clientB}/logo`,
      headers: { cookie: staffCookie },
    })
    expect(del.statusCode).toBe(400)
    expect(del.json()).toMatchObject({ error: 'bad_request' })

    const client = await app.inject({
      method: 'GET',
      url: `/api/clients/${clientB}`,
      headers: { cookie: staffCookie },
    })
    expect(client.json().branding).toEqual({ logoUrl: 'https://cdn.globex.test/logo.png' })
  })

  it('serves the logo to an in-scope contact, 404s an out-of-scope client', async () => {
    const upload = await uploadLogo(staffCookie, clientA, PNG_BYTES, 'logo.png', 'image/png')
    expect(upload.statusCode).toBe(200)

    const own = await app.inject({
      method: 'GET',
      url: `/api/clients/${clientA}/logo`,
      headers: { cookie: contactCookie },
    })
    expect(own.statusCode).toBe(200)
    expect(own.headers['content-type']).toContain('image/png')
    expect(own.rawPayload.equals(PNG_BYTES)).toBe(true)

    const other = await app.inject({
      method: 'GET',
      url: `/api/clients/${clientB}/logo`,
      headers: { cookie: contactCookie },
    })
    expect(other.statusCode).toBe(404)
  })

  it('removes the stored file when a patch clears branding', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/clients/${clientA}`,
      headers: { cookie: staffCookie, 'content-type': 'application/json' },
      payload: { branding: null },
    })
    expect(patch.statusCode).toBe(200)
    expect(patch.json().branding).toBeNull()

    const get = await app.inject({
      method: 'GET',
      url: `/api/clients/${clientA}/logo`,
      headers: { cookie: staffCookie },
    })
    expect(get.statusCode).toBe(404)
    expect(await attachmentFileSize(logoKeyFor(clientA))).toBeNull()
    await expect(stat(attachmentPath(logoKeyFor(clientA)))).rejects.toThrow()
  })

  it('rejects an oversize upload with 413 and leaves no file behind', async () => {
    const res = await uploadLogo(
      staffCookie,
      clientA,
      Buffer.alloc(maxLogoBytes() + 1),
      'big.png',
      'image/png',
    )
    expect(res.statusCode).toBe(413)
    expect(res.json()).toMatchObject({ error: 'file_too_large' })
    expect(await attachmentFileSize(logoKeyFor(clientA))).toBeNull()

    const client = await app.inject({
      method: 'GET',
      url: `/api/clients/${clientA}`,
      headers: { cookie: staffCookie },
    })
    expect(client.json().branding).toBeNull()
  })
})
