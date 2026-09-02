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
  instanceName: 'Kulik Labs IT',
  ownerName: 'Max Kulik',
  ownerEmail: 'max@kuliklabs.dev',
  password: 'correct-horse-battery',
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

async function signIn(app: App, email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email, password },
  })
  expect(res.statusCode).toBe(200)
  return cookiesFrom(res)
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

describe('user settings (profile + avatar)', () => {
  let app: App
  let superuserCookie: string
  let contactCookie: string

  beforeAll(async () => {
    await runMigrations()
    await wipe()
    app = await buildApp()
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: owner })
    expect(setup.statusCode).toBe(200)
    superuserCookie = await signIn(app, owner.ownerEmail, owner.password)
    await createLocalUser('Ada Client', 'ada@acme.test', 'contact', 'ada-pass-123')
    contactCookie = await signIn(app, 'ada@acme.test', 'ada-pass-123')
  })

  afterAll(async () => {
    await app.close()
    await wipe()
  })

  it('updates the profile fields and audits the change', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/me/profile',
      headers: { cookie: superuserCookie },
      payload: { name: 'Max Kulik', phone: '+1 555 0100', address: '100 E Wisconsin Ave, Milwaukee', office: 'HQ' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().profile).toMatchObject({
      name: 'Max Kulik',
      phone: '+1 555 0100',
      address: '100 E Wisconsin Ave, Milwaukee',
      office: 'HQ',
    })
    const [row] = await db
      .select({ action: audit.action })
      .from(audit)
      .orderBy(desc(audit.createdAt))
      .limit(1)
    expect(row).toMatchObject({ action: 'profile.update' })
  })

  it('rejects an email owned by another user with 409, accepts the own email', async () => {
    const otherId = await createLocalUser('Riley Agent', 'riley@kuliklabs.dev', 'agent', 'riley-pass-123')
    const taken = await app.inject({
      method: 'POST',
      url: '/api/me/profile',
      headers: { cookie: superuserCookie },
      payload: { email: 'riley@kuliklabs.dev' },
    })
    expect(taken.statusCode).toBe(409)
    const own = await app.inject({
      method: 'POST',
      url: '/api/me/profile',
      headers: { cookie: superuserCookie },
      payload: { email: owner.ownerEmail },
    })
    expect(own.statusCode).toBe(200)
    await db.delete(accounts).where(eq(accounts.userId, otherId))
    await db.delete(users).where(eq(users.id, otherId))
  })

  it('rejects empty patches and invalid values', async () => {
    for (const payload of [{}, { name: '   ' }, { email: 'nope' }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/me/profile',
        headers: { cookie: superuserCookie },
        payload,
      })
      expect(res.statusCode).toBe(400)
    }
  })

  it('uploads an avatar, serves it with the sniffed content type, and removes it', async () => {
    const boundary = `kbtest${randomUUID().replace(/-/g, '')}`
    const upload = await app.inject({
      method: 'POST',
      url: '/api/me/avatar',
      headers: { cookie: superuserCookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, [
        { name: 'file', filename: 'me.png', contentType: 'image/png', content: PNG_BYTES },
      ]),
    })
    expect(upload.statusCode).toBe(200)
    expect(upload.json().image).toMatch(/^avatar-/)

    const get = await app.inject({ method: 'GET', url: '/api/me/avatar', headers: { cookie: superuserCookie } })
    expect(get.statusCode).toBe(200)
    expect(get.headers['content-type']).toContain('image/png')
    expect(get.rawPayload.equals(PNG_BYTES)).toBe(true)

    const del = await app.inject({ method: 'DELETE', url: '/api/me/avatar', headers: { cookie: superuserCookie } })
    expect(del.statusCode).toBe(200)
    expect(del.json()).toEqual({ image: null })
    const gone = await app.inject({ method: 'GET', url: '/api/me/avatar', headers: { cookie: superuserCookie } })
    expect(gone.statusCode).toBe(404)
  })

  it('rejects non-image avatar uploads', async () => {
    const boundary = `kbtest${randomUUID().replace(/-/g, '')}`
    const res = await app.inject({
      method: 'POST',
      url: '/api/me/avatar',
      headers: { cookie: superuserCookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, [
        { name: 'file', filename: 'notes.txt', contentType: 'text/plain', content: 'not an image' },
      ]),
    })
    expect(res.statusCode).toBe(415)
  })

  it('serves a staff member avatar to staff, not to contacts', async () => {
    const boundary = `kbtest${randomUUID().replace(/-/g, '')}`
    const upload = await app.inject({
      method: 'POST',
      url: '/api/me/avatar',
      headers: { cookie: superuserCookie, 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody(boundary, [
        { name: 'file', filename: 'me.png', contentType: 'image/png', content: PNG_BYTES },
      ]),
    })
    expect(upload.statusCode).toBe(200)
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: superuserCookie } })
    const ownerId: string = me.json().user.id
    const staffGet = await app.inject({
      method: 'GET',
      url: `/api/users/${ownerId}/avatar`,
      headers: { cookie: superuserCookie },
    })
    expect(staffGet.statusCode).toBe(200)
    const contactGet = await app.inject({
      method: 'GET',
      url: `/api/users/${ownerId}/avatar`,
      headers: { cookie: contactCookie },
    })
    expect(contactGet.statusCode).toBe(403)
    const del = await app.inject({ method: 'DELETE', url: '/api/me/avatar', headers: { cookie: superuserCookie } })
    expect(del.statusCode).toBe(200)
  })
})
