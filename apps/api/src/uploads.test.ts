import { randomUUID } from 'node:crypto'
import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
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
  uploads,
  users,
  verifications,
} from './db/schema'
import { uploadTempPath } from './uploads'

type App = Awaited<ReturnType<typeof buildApp>>

const owner = {
  instanceName: 'Upload Portal',
  ownerName: 'Max Upload',
  ownerEmail: 'max@upload.test',
  password: 'correct-horse-upload',
}

const FILE_BYTES = Buffer.alloc(11 * 1024 * 1024, 7) // 11MB — 3 chunks of 5MB

function cookiesFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie']
  const list = Array.isArray(raw) ? raw : [raw]
  return list
    .filter(Boolean)
    .map((cookie) => String(cookie).split(';')[0])
    .join('; ')
}

function b64(value: string): string {
  return Buffer.from(value).toString('base64')
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
  await db.delete(uploads)
  await db.delete(users)
  await db.delete(settings)
}

// Stage a file through the tus endpoints and return the upload id.
async function stageFile(app: App, cookie: string, file: Buffer, name = 'report.pdf', mime = 'application/pdf'): Promise<string> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/uploads',
    headers: {
      cookie,
      'Upload-Length': String(file.length),
      'Upload-Metadata': `filename ${b64(name)},mime ${b64(mime)}`,
    },
  })
  expect(created.statusCode).toBe(201)
  const id = created.headers['location']!.replace('/api/uploads/', '')
  let offset = 0
  const CHUNK = 5 * 1024 * 1024
  while (offset < file.length) {
    const end = Math.min(offset + CHUNK, file.length)
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/uploads/${id}`,
      headers: {
        cookie,
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': String(offset),
      },
      payload: file.subarray(offset, end),
    })
    expect(patched.statusCode).toBe(204)
    offset = Number(patched.headers['upload-offset'])
  }
  return id
}

describe('chunked (tus) uploads + superuser upload settings (row 18 part 1)', () => {
  let app: App
  let ownerCookie: string
  let agentCookie: string
  let contactCookie: string
  let clientIdA: string
  let ticketId: string

  const contactEmail = 'ada@upload.test'

  beforeAll(async () => {
    const storageDir = path.join(tmpdir(), `kipple-uploads-test-${process.pid}`)
    process.env.STORAGE_DIR = storageDir
    await runMigrations()
    await wipe()
    app = await buildApp()

    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: owner })
    expect(setup.statusCode).toBe(200)
    ownerCookie = cookiesFrom(setup)
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: owner.ownerEmail, password: owner.password },
    })
    expect(login.statusCode).toBe(200)
    ownerCookie = cookiesFrom(login)

    const agent = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: ownerCookie },
      payload: { name: 'Dana Agent', email: 'dana@upload.test', password: 'dana-pass-1', role: 'agent' },
    })
    expect(agent.statusCode).toBe(200)
    const agentLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'dana@upload.test', password: 'dana-pass-1' },
    })
    expect(agentLogin.statusCode).toBe(200)
    agentCookie = cookiesFrom(agentLogin)

    const client = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie: ownerCookie },
      payload: { name: 'Upload Co', domain: 'uploadco.test' },
    })
    expect(client.statusCode).toBe(201)
    clientIdA = client.json().id

    const contact = await app.inject({
      method: 'POST',
      url: `/api/clients/${clientIdA}/contacts`,
      headers: { cookie: ownerCookie },
      payload: { name: 'Ada Upload', email: contactEmail },
    })
    expect(contact.statusCode).toBe(201)
    const portal = await app.inject({
      method: 'POST',
      url: `/api/contacts/${contact.json().id}/portal`,
      headers: { cookie: ownerCookie },
      payload: { email: contactEmail, name: 'Ada Upload', password: 'ada-portal-1' },
    })
    expect(portal.statusCode).toBe(201)
    // The portal route provisions a random password (it neither accepts nor
    // returns one) — set a known hash on the credential account, matching
    // the attachments-test / live-seed pattern, before signing the contact in.
    await db
      .update(accounts)
      .set({ password: await hashPassword('ada-portal-1') })
      .where(eq(accounts.userId, portal.json().userId))
    const contactLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: contactEmail, password: 'ada-portal-1' },
    })
    expect(contactLogin.statusCode).toBe(200)
    contactCookie = cookiesFrom(contactLogin)

    const ticket = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: ownerCookie },
      payload: { clientId: clientIdA, subject: 'Upload test ticket' },
    })
    expect(ticket.statusCode).toBe(201)
    ticketId = ticket.json().id
  })

  afterAll(async () => {
    const storageDir = process.env.STORAGE_DIR
    delete process.env.STORAGE_DIR
    if (storageDir) await rm(storageDir, { recursive: true, force: true }).catch(() => undefined)
  })

  describe('tus protocol surface', () => {
    it('OPTIONS advertises tus capabilities + the effective max size', async () => {
      const res = await app.inject({ method: 'OPTIONS', url: '/api/uploads' })
      expect(res.statusCode).toBe(200)
      expect(res.headers['tus-resumable']).toBe('1.0.0')
      expect(res.headers['tus-version']).toBe('1.0.0')
      expect(String(res.headers['tus-extension'])).toContain('creation')
      expect(Number(res.headers['tus-max-size'])).toBe(25 * 1024 * 1024)
    })

    it('rejects unauthenticated creates', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/uploads',
        headers: { 'Upload-Length': '10' },
      })
      expect(res.statusCode).toBe(401)
    })

    it('create requires Upload-Length and a sane size', async () => {
      const noLength = await app.inject({
        method: 'POST',
        url: '/api/uploads',
        headers: { cookie: ownerCookie },
      })
      expect(noLength.statusCode).toBe(400)
      const tooBig = await app.inject({
        method: 'POST',
        url: '/api/uploads',
        headers: { cookie: ownerCookie, 'Upload-Length': String(26 * 1024 * 1024) },
      })
      expect(tooBig.statusCode).toBe(413)
      expect(tooBig.json().error).toBe('file_too_large')
    })

    it('creates a staged upload and streams it in chunks to completion', async () => {
      const id = await stageFile(app, ownerCookie, FILE_BYTES)
      const info = await app.inject({ method: 'GET', url: `/api/uploads/${id}`, headers: { cookie: ownerCookie } })
      expect(info.statusCode).toBe(200)
      const body = info.json()
      expect(body).toMatchObject({
        id,
        filename: 'report.pdf',
        mime: 'application/pdf',
        size: FILE_BYTES.length,
        offset: FILE_BYTES.length,
        status: 'complete',
      })
      const head = await app.inject({ method: 'HEAD', url: `/api/uploads/${id}`, headers: { cookie: ownerCookie } })
      expect(head.statusCode).toBe(200)
      expect(head.headers['upload-offset']).toBe(String(FILE_BYTES.length))
      expect(head.headers['upload-length']).toBe(String(FILE_BYTES.length))
      expect(head.headers['tus-resumable']).toBe('1.0.0')
      const file = await stat(uploadTempPath(id))
      expect(file.size).toBe(FILE_BYTES.length)
      await app.inject({ method: 'DELETE', url: `/api/uploads/${id}`, headers: { cookie: ownerCookie } })
    })

    it('PATCH validates content-type and offset (415 / 409)', async () => {
      const id = await stageFile(app, ownerCookie, FILE_BYTES.subarray(0, 5 * 1024 * 1024))
      const wrongCt = await app.inject({
        method: 'PATCH',
        url: `/api/uploads/${id}`,
        headers: { cookie: ownerCookie, 'Content-Type': 'application/octet-stream', 'Upload-Offset': '0' },
        payload: Buffer.from('x'),
      })
      expect(wrongCt.statusCode).toBe(415)
      // Offset conflicts assert against a PARTIAL upload — a completed one
      // 409s as upload_finished before any offset negotiation (the consumed
      // test above pins that order).
      const part = await app.inject({
        method: 'POST',
        url: '/api/uploads',
        headers: {
          cookie: ownerCookie,
          'Upload-Length': '1024',
          'Upload-Metadata': `filename ${b64('part.bin')},mime ${b64('application/octet-stream')}`,
        },
      })
      expect(part.statusCode).toBe(201)
      const partId = part.headers['location']!.replace('/api/uploads/', '')
      const partChunk = await app.inject({
        method: 'PATCH',
        url: `/api/uploads/${partId}`,
        headers: { cookie: ownerCookie, 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0' },
        payload: Buffer.alloc(64, 1),
      })
      expect(partChunk.statusCode).toBe(204)
      const wrongOffset = await app.inject({
        method: 'PATCH',
        url: `/api/uploads/${partId}`,
        headers: { cookie: ownerCookie, 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '1' },
        payload: Buffer.from('x'),
      })
      expect(wrongOffset.statusCode).toBe(409)
      expect(wrongOffset.json().error).toBe('offset_mismatch')
      await app.inject({ method: 'DELETE', url: `/api/uploads/${partId}`, headers: { cookie: ownerCookie } })
    })

    it('a chunk that overshoots the declared size 413s and rolls back', async () => {
      const file = Buffer.alloc(1024, 1)
      const created = await app.inject({
        method: 'POST',
        url: '/api/uploads',
        headers: {
          cookie: ownerCookie,
          'Upload-Length': String(file.length),
          'Upload-Metadata': `filename ${b64('small.bin')},mime ${b64('application/octet-stream')}`,
        },
      })
      const id = created.headers['location']!.replace('/api/uploads/', '')
      const overshot = await app.inject({
        method: 'PATCH',
        url: `/api/uploads/${id}`,
        headers: {
          cookie: ownerCookie,
          'Content-Type': 'application/offset+octet-stream',
          'Upload-Offset': '0',
        },
        payload: Buffer.alloc(2048, 1), // 2KB into a 1KB file
      })
      expect(overshot.statusCode).toBe(413)
      const info = await app.inject({ method: 'GET', url: `/api/uploads/${id}`, headers: { cookie: ownerCookie } })
      expect(info.json().offset).toBe(0) // rolled back
      await app.inject({ method: 'DELETE', url: `/api/uploads/${id}`, headers: { cookie: ownerCookie } })
    })

    it('foreign and unknown uploads 404 on every endpoint (no existence leaks)', async () => {
      const id = await stageFile(app, agentCookie, Buffer.from('agent bytes'))
      for (const method of ['GET', 'HEAD', 'PATCH', 'DELETE'] as const) {
        const res = await app.inject({
          method,
          url: `/api/uploads/${id}`,
          headers: {
            cookie: ownerCookie,
            ...(method === 'PATCH'
              ? { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0' }
              : {}),
          },
          ...(method === 'PATCH' ? { payload: Buffer.from('x') } : {}),
        })
        expect(res.statusCode).toBe(404)
      }
      const unknown = await app.inject({
        method: 'GET',
        url: `/api/uploads/${randomUUID()}`,
        headers: { cookie: ownerCookie },
      })
      expect(unknown.statusCode).toBe(404)
      await app.inject({ method: 'DELETE', url: `/api/uploads/${id}`, headers: { cookie: agentCookie } })
    })

    it('consumed uploads stop accepting bytes and reject DELETE', async () => {
      const id = await stageFile(app, ownerCookie, Buffer.from('to consume'))
      // consume it via a ticket update (see the consumption block below for
      // the happy path; here we drive the state directly through the API)
      const consumed = await app.inject({
        method: 'POST',
        url: `/api/tickets/${ticketId}/updates`,
        headers: { cookie: ownerCookie },
        payload: { kind: 'internal', body: 'attaching', uploadIds: [id] },
      })
      expect(consumed.statusCode).toBe(201)
      const patch = await app.inject({
        method: 'PATCH',
        url: `/api/uploads/${id}`,
        headers: {
          cookie: ownerCookie,
          'Content-Type': 'application/offset+octet-stream',
          'Upload-Offset': '0',
        },
        payload: Buffer.from('x'),
      })
      expect(patch.statusCode).toBe(409)
      expect(patch.json().error).toBe('upload_finished')
      const del = await app.inject({ method: 'DELETE', url: `/api/uploads/${id}`, headers: { cookie: ownerCookie } })
      expect(del.statusCode).toBe(400)
    })

    it('the create endpoint sweeps expired uploads (rows + temp files)', async () => {
      const id = randomUUID()
      await db.insert(uploads).values({
        id,
        userId: (await db.select({ id: users.id }).from(users).where(eq(users.email, owner.ownerEmail)))[0].id,
        filename: 'expired.bin',
        mime: 'application/octet-stream',
        size: 10,
        offset: 0,
        status: 'open',
        expiresAt: new Date(Date.now() - 60_000),
      })
      const temp = uploadTempPath(id)
      await mkdir(path.dirname(temp), { recursive: true })
      await writeFile(temp, 'expired')
      const created = await app.inject({
        method: 'POST',
        url: '/api/uploads',
        headers: { cookie: ownerCookie, 'Upload-Length': '10' },
      })
      expect(created.statusCode).toBe(201)
      const [row] = await db.select({ id: uploads.id }).from(uploads).where(eq(uploads.id, id))
      expect(row).toBeUndefined()
      const stillThere = await stat(temp).then(() => true, () => false)
      expect(stillThere).toBe(false)
    })
  })

  describe('consumption by ticket updates', () => {
    it('moves staged files to attachments (rows + file + consumed state)', async () => {
      const id = await stageFile(app, ownerCookie, FILE_BYTES.subarray(0, 1024 * 100), 'big.pdf')
      const res = await app.inject({
        method: 'POST',
        url: `/api/tickets/${ticketId}/updates`,
        headers: { cookie: ownerCookie },
        payload: { kind: 'public', body: 'see attached', uploadIds: [id] },
      })
      expect(res.statusCode).toBe(201)
      const detail = await app.inject({
        method: 'GET',
        url: `/api/tickets/${ticketId}`,
        headers: { cookie: ownerCookie },
      })
      const attachment = detail
        .json()
        .updates.find((u: { id: string }) => u.id === res.json().id).attachments[0]
      expect(attachment.filename).toBe('big.pdf')
      expect(attachment.size).toBe(1024 * 100)
      expect(attachment.mime).toBe('application/pdf')
      const [row] = await db.select().from(uploads).where(eq(uploads.id, id))
      expect(row.status).toBe('consumed')
      expect(row.consumedAt).toBeTruthy()
      // the file now lives at the sharded final path, not the temp path
      const { attachmentPath } = await import('./storage')
      await stat(attachmentPath(attachment.id))
      const tempGone = await stat(uploadTempPath(id)).then(() => true, () => false)
      expect(tempGone).toBe(false)
    })

    it('a reused upload id 400s (single-use)', async () => {
      const id = await stageFile(app, ownerCookie, Buffer.from('once only'))
      const first = await app.inject({
        method: 'POST',
        url: `/api/tickets/${ticketId}/updates`,
        headers: { cookie: ownerCookie },
        payload: { body: 'first', uploadIds: [id] },
      })
      expect(first.statusCode).toBe(201)
      const second = await app.inject({
        method: 'POST',
        url: `/api/tickets/${ticketId}/updates`,
        headers: { cookie: ownerCookie },
        payload: { body: 'second', uploadIds: [id] },
      })
      expect(second.statusCode).toBe(400)
      expect(second.json().error).toBe('upload_consumed')
    })

    it('foreign, unknown, incomplete, and duplicate ids are rejected', async () => {
      const mine = await stageFile(app, ownerCookie, Buffer.from('owner bytes'))
      const foreign = await app.inject({
        method: 'POST',
        url: `/api/tickets/${ticketId}/updates`,
        headers: { cookie: agentCookie },
        payload: { body: 'steal', uploadIds: [mine] },
      })
      expect(foreign.statusCode).toBe(404)
      const unknown = await app.inject({
        method: 'POST',
        url: `/api/tickets/${ticketId}/updates`,
        headers: { cookie: ownerCookie },
        payload: { body: 'ghost', uploadIds: [randomUUID()] },
      })
      expect(unknown.statusCode).toBe(404)
      const partial = await app.inject({
        method: 'POST',
        url: '/api/uploads',
        headers: { cookie: ownerCookie, 'Upload-Length': '1000' },
      })
      const partialId = partial.headers['location']!.replace('/api/uploads/', '')
      await app.inject({
        method: 'PATCH',
        url: `/api/uploads/${partialId}`,
        headers: {
          cookie: ownerCookie,
          'Content-Type': 'application/offset+octet-stream',
          'Upload-Offset': '0',
        },
        payload: Buffer.from('partial'),
      })
      const incomplete = await app.inject({
        method: 'POST',
        url: `/api/tickets/${ticketId}/updates`,
        headers: { cookie: ownerCookie },
        payload: { body: 'not done', uploadIds: [partialId] },
      })
      expect(incomplete.statusCode).toBe(400)
      expect(incomplete.json().error).toBe('upload_incomplete')
      const dupes = await app.inject({
        method: 'POST',
        url: `/api/tickets/${ticketId}/updates`,
        headers: { cookie: ownerCookie },
        payload: { body: 'twice', uploadIds: [mine, mine] },
      })
      expect(dupes.statusCode).toBe(400)
      expect(dupes.json().error).toBe('bad_request')
      await app.inject({ method: 'DELETE', url: `/api/uploads/${partialId}`, headers: { cookie: ownerCookie } })
    })

    it('a client-scope wall still applies when consuming uploads (issue #31 shape)', async () => {
      // agent with a client association = scoped to that client only
      const otherClient = await app.inject({
        method: 'POST',
        url: '/api/clients',
        headers: { cookie: ownerCookie },
        payload: { name: 'Other Co', domain: 'other.test' },
      })
      expect(otherClient.statusCode).toBe(201)
      const scoped = await app.inject({
        method: 'PATCH',
        url: `/api/users/${(await db.select({ id: users.id }).from(users).where(eq(users.email, 'dana@upload.test')))[0].id}`,
        headers: { cookie: ownerCookie },
        payload: { clientId: otherClient.json().id },
      })
      expect(scoped.statusCode).toBe(200)
      const id = await stageFile(app, agentCookie, Buffer.from('scoped bytes'))
      const res = await app.inject({
        method: 'POST',
        url: `/api/tickets/${ticketId}/updates`,
        headers: { cookie: agentCookie },
        payload: { body: 'cross client', uploadIds: [id] },
      })
      expect(res.statusCode).toBe(404) // ticket out of scope — uploads never bypass it
      await app.inject({ method: 'DELETE', url: `/api/uploads/${id}`, headers: { cookie: agentCookie } })
      // un-scope the agent again for later tests
      const unscope = await app.inject({
        method: 'PATCH',
        url: `/api/users/${(await db.select({ id: users.id }).from(users).where(eq(users.email, 'dana@upload.test')))[0].id}`,
        headers: { cookie: ownerCookie },
        payload: { clientId: null },
      })
      expect(unscope.statusCode).toBe(200)
    })

    it('a contact stages and attaches their own file (forced public, portal-visible)', async () => {
      const id = await stageFile(app, contactCookie, Buffer.from('from the client'), 'screenshot.png', 'image/png')
      const res = await app.inject({
        method: 'POST',
        url: `/api/tickets/${ticketId}/updates`,
        headers: { cookie: contactCookie },
        payload: { body: 'here is the log', uploadIds: [id] },
      })
      expect(res.statusCode).toBe(201)
      expect(res.json().kind).toBe('public')
      const detail = await app.inject({
        method: 'GET',
        url: `/api/tickets/${ticketId}`,
        headers: { cookie: contactCookie },
      })
      expect(detail.json().updates.find((u: { id: string }) => u.id === res.json().id).attachments[0].filename).toBe(
        'screenshot.png',
      )
      // portal download works for the contact (public update, own client)
      const attachmentId = detail
        .json()
        .updates.find((u: { id: string }) => u.id === res.json().id).attachments[0].id
      const download = await app.inject({
        method: 'GET',
        url: `/api/attachments/${attachmentId}`,
        headers: { cookie: contactCookie },
      })
      expect(download.statusCode).toBe(200)
      expect(download.rawPayload.equals(Buffer.from('from the client'))).toBe(true)
    })
  })

  describe('superuser upload settings', () => {
    it('is superuser-only (403 for agent, 401 unauth)', async () => {
      expect((await app.inject({ method: 'GET', url: '/api/instance/uploads' })).statusCode).toBe(401)
      expect(
        (await app.inject({ method: 'GET', url: '/api/instance/uploads', headers: { cookie: agentCookie } })).statusCode,
      ).toBe(403)
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/instance/uploads',
            headers: { cookie: agentCookie },
            payload: { maxMb: 5 },
          })
        ).statusCode,
      ).toBe(403)
    })

    it('returns the env defaults until a row exists, then round-trips a patch + audit row', async () => {
      const defaults = await app.inject({
        method: 'GET',
        url: '/api/instance/uploads',
        headers: { cookie: ownerCookie },
      })
      expect(defaults.json()).toEqual({ maxMb: 25, allowedMimes: [] })

      const patched = await app.inject({
        method: 'POST',
        url: '/api/instance/uploads',
        headers: { cookie: ownerCookie },
        payload: { maxMb: 1, allowedMimes: ['image/*'] },
      })
      expect(patched.statusCode).toBe(200)
      expect(patched.json()).toEqual({ maxMb: 1, allowedMimes: ['image/*'] })

      const again = await app.inject({
        method: 'GET',
        url: '/api/instance/uploads',
        headers: { cookie: ownerCookie },
      })
      expect(again.json()).toEqual({ maxMb: 1, allowedMimes: ['image/*'] })

      const [auditRow] = await db
        .select()
        .from(audit)
        .where(eq(audit.action, 'instance.uploads'))
        .orderBy(desc(audit.createdAt))
        .limit(1)
      expect(auditRow).toBeTruthy()
      // restore the defaults for the remaining tests
      const reset = await app.inject({
        method: 'POST',
        url: '/api/instance/uploads',
        headers: { cookie: ownerCookie },
        payload: { maxMb: 25, allowedMimes: [] },
      })
      expect(reset.statusCode).toBe(200)
    })

    it('rejects out-of-bounds settings', async () => {
      for (const bad of [{ maxMb: 0 }, { maxMb: 5000 }, { allowedMimes: ['not-a-mime'] }]) {
        const res = await app.inject({
          method: 'POST',
          url: '/api/instance/uploads',
          headers: { cookie: ownerCookie },
          payload: bad,
        })
        expect(res.statusCode).toBe(400)
      }
    })

    it('the settings maxMb beats the env default on the next create', async () => {
      const set = await app.inject({
        method: 'POST',
        url: '/api/instance/uploads',
        headers: { cookie: ownerCookie },
        payload: { maxMb: 1 },
      })
      expect(set.statusCode).toBe(200)
      const tooBig = await app.inject({
        method: 'POST',
        url: '/api/uploads',
        headers: { cookie: ownerCookie, 'Upload-Length': String(2 * 1024 * 1024) },
      })
      expect(tooBig.statusCode).toBe(413)
      const ok = await app.inject({
        method: 'POST',
        url: '/api/uploads',
        headers: { cookie: ownerCookie, 'Upload-Length': '1024' },
      })
      expect(ok.statusCode).toBe(201)
      await app.inject({
        method: 'POST',
        url: '/api/instance/uploads',
        headers: { cookie: ownerCookie },
        payload: { maxMb: 25 },
      })
    })

    it('the MIME allowlist gates the tus create path', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/instance/uploads',
        headers: { cookie: ownerCookie },
        payload: { allowedMimes: ['image/*'] },
      })
      const blocked = await app.inject({
        method: 'POST',
        url: '/api/uploads',
        headers: {
          cookie: ownerCookie,
          'Upload-Length': '10',
          'Upload-Metadata': `filename ${b64('doc.pdf')},mime ${b64('application/pdf')}`,
        },
      })
      expect(blocked.statusCode).toBe(415)
      expect(blocked.json().error).toBe('mime_not_allowed')
      const allowed = await app.inject({
        method: 'POST',
        url: '/api/uploads',
        headers: {
          cookie: ownerCookie,
          'Upload-Length': '10',
          'Upload-Metadata': `filename ${b64('pic.png')},mime ${b64('image/png')}`,
        },
      })
      expect(allowed.statusCode).toBe(201)
      const id = allowed.headers['location']!.replace('/api/uploads/', '')
      await app.inject({ method: 'DELETE', url: `/api/uploads/${id}`, headers: { cookie: ownerCookie } })
      // reset the allowlist
      await app.inject({
        method: 'POST',
        url: '/api/instance/uploads',
        headers: { cookie: ownerCookie },
        payload: { allowedMimes: [] },
      })
    })

    it('the MIME allowlist also gates the legacy multipart path', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/instance/uploads',
        headers: { cookie: ownerCookie },
        payload: { allowedMimes: ['application/pdf'] },
      })
      const boundary = 'test-boundary-123'
      const blocked = await app.inject({
        method: 'POST',
        url: `/api/tickets/${ticketId}/updates`,
        headers: {
          cookie: ownerCookie,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: multipartBody(boundary, [
          { name: 'body', content: 'legacy multipart' },
          { name: 'files', filename: 'doc.html', contentType: 'text/html', content: '<p>no</p>' },
        ]),
      })
      expect(blocked.statusCode).toBe(415)
      expect(blocked.json().error).toBe('mime_not_allowed')
      const allowed = await app.inject({
        method: 'POST',
        url: `/api/tickets/${ticketId}/updates`,
        headers: {
          cookie: ownerCookie,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: multipartBody(boundary, [
          { name: 'body', content: 'legacy multipart' },
          { name: 'files', filename: 'doc.pdf', contentType: 'application/pdf', content: '%PDF-1.4 fake' },
        ]),
      })
      expect(allowed.statusCode).toBe(201)
      const detail = await app.inject({
        method: 'GET',
        url: `/api/tickets/${ticketId}`,
        headers: { cookie: ownerCookie },
      })
      expect(
        detail.json().updates.find((u: { id: string }) => u.id === allowed.json().id).attachments[0].mime,
      ).toBe('application/pdf')
      await app.inject({
        method: 'POST',
        url: '/api/instance/uploads',
        headers: { cookie: ownerCookie },
        payload: { allowedMimes: [] },
      })
    })
  })
})
