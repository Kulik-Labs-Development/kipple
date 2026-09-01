import { randomUUID } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { hashPassword } from 'better-auth/crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { db } from './db'
import { runMigrations } from './db/migrate'
import {
  accounts,
  audit,
  attachments,
  clients,
  contactClients,
  contacts,
  settings,
  tickets,
  updates,
  users,
} from './db/schema'
import { eq } from 'drizzle-orm'

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

async function wipe() {
  await db.delete(attachments)
  await db.delete(updates)
  await db.delete(tickets)
  await db.delete(contactClients)
  await db.delete(contacts)
  await db.delete(clients)
  await db.delete(audit)
  await db.delete(users)
  await db.delete(settings)
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

function walkFiles(root: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) out.push(...walkFiles(full))
    else out.push(full)
  }
  return out
}

describe('attachments on updates', () => {
  let app: App
  let storageDir: string
  let staffCookie: string
  let contactACookie: string
  let contactBCookie: string
  let clientA: string
  let clientB: string
  let ticketA: string

  let publicUpdateId: string
  let pngAttachmentId: string
  const pngBytes = Buffer.from('PNGDATA')
  const textBytes = Buffer.from('text notes here')

  beforeAll(async () => {
    console.error('MARK beforeAll start')
    storageDir = mkdtempSync(path.join(tmpdir(), 'kipple-attachments-'))
    process.env.STORAGE_DIR = storageDir
    await runMigrations()
    await wipe()
    console.error('MARK wiped')
    app = await buildApp()
    console.error('MARK app built')

    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: owner })
    console.error('MARK setup', setup.statusCode)
    expect(setup.statusCode).toBe(200)
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: owner.ownerEmail, password: owner.password },
    })
    expect(login.statusCode).toBe(200)
    staffCookie = cookiesFrom(login)
    console.error('MARK staff login')

    const resA = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie: staffCookie },
      payload: { name: 'Acme Corp', domain: 'acme.test' },
    })
    expect(resA.statusCode).toBe(201)
    clientA = resA.json().id
    const resB = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie: staffCookie },
      payload: { name: 'Globex' },
    })
    expect(resB.statusCode).toBe(201)
    clientB = resB.json().id

    // Contact A (client A) — created through the staff API, then given a
    // real credential account so sign-in works (better-auth signs tokens).
    const contactA = await app.inject({
      method: 'POST',
      url: `/api/clients/${clientA}/contacts`,
      headers: { cookie: staffCookie },
      payload: { name: 'Ada Client', email: 'ada@acme.test' },
    })
    expect(contactA.statusCode).toBe(201)
    console.error('MARK contacts created')
    const contactAUserId = randomUUID()
    await db.insert(users).values({
      id: contactAUserId,
      name: 'Ada Client',
      email: 'ada@acme.test',
      role: 'contact',
      contactId: contactA.json().id,
    })
    await db.insert(accounts).values({
      id: randomUUID(),
      providerId: 'credential',
      issuer: 'local:credential',
      accountId: contactAUserId,
      userId: contactAUserId,
      password: await hashPassword('ada-contact-pass'),
    })
    const loginA = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'ada@acme.test', password: 'ada-contact-pass' },
    })
    expect(loginA.statusCode).toBe(200)
    contactACookie = cookiesFrom(loginA)

    // Contact B (client B) — a second client's person, for scoping checks.
    const contactB = await app.inject({
      method: 'POST',
      url: `/api/clients/${clientB}/contacts`,
      headers: { cookie: staffCookie },
      payload: { name: 'Bob Client', email: 'bob@globex.test' },
    })
    expect(contactB.statusCode).toBe(201)
    const contactBUserId = randomUUID()
    await db.insert(users).values({
      id: contactBUserId,
      name: 'Bob Client',
      email: 'bob@globex.test',
      role: 'contact',
      contactId: contactB.json().id,
    })
    await db.insert(accounts).values({
      id: randomUUID(),
      providerId: 'credential',
      issuer: 'local:credential',
      accountId: contactBUserId,
      userId: contactBUserId,
      password: await hashPassword('bob-contact-pass'),
    })
    const loginB = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'bob@globex.test', password: 'bob-contact-pass' },
    })
    expect(loginB.statusCode).toBe(200)
    contactBCookie = cookiesFrom(loginB)
    console.error('MARK contact logins')

    const ticketARes = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: contactACookie },
      payload: { clientId: clientA, subject: 'Printer is on fire', body: 'Please help' },
    })
    expect(ticketARes.statusCode).toBe(201)
    ticketA = ticketARes.json().id
    console.error('MARK ticket created')

    // Baseline: a staff public update with two attachments (one unicode
    // filename, to exercise the filename* header).
    const boundary = `kbtest${randomUUID().replace(/-/g, '')}`
    console.error('MARK upload starting')
    const upload = await app.inject({
      method: 'POST',
      url: `/api/tickets/${ticketA}/updates`,
      headers: {
        cookie: staffCookie,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartBody(boundary, [
        { name: 'kind', content: 'public' },
        { name: 'body', content: 'here is the log file and a scan' },
        { name: 'files', filename: 'notes.txt', contentType: 'text/plain', content: textBytes },
        { name: 'files', filename: 'naïve-resume.png', contentType: 'image/png', content: pngBytes },
      ]),
    })
    console.error('MARK upload done', upload.statusCode)
    expect(upload.statusCode).toBe(201)
    publicUpdateId = upload.json().id
    const detail = await app.inject({
      method: 'GET',
      url: `/api/tickets/${ticketA}`,
      headers: { cookie: staffCookie },
    })
    const row = detail.json().updates.find((u: { id: string }) => u.id === publicUpdateId)
    pngAttachmentId = row.attachments.find((a: { filename: string }) =>
      a.filename.endsWith('.png'),
    ).id
    console.error('MARK beforeAll complete')
  })

  afterAll(async () => {
    delete process.env.STORAGE_DIR
    rmSync(storageDir, { recursive: true, force: true })
  })

  it('lists the uploaded attachments on the update (filename/size/mime) and stores the files on disk', async () => {
    const detail = await app.inject({
      method: 'GET',
      url: `/api/tickets/${ticketA}`,
      headers: { cookie: staffCookie },
    })
    expect(detail.statusCode).toBe(200)
    const row = detail.json().updates.find((u: { id: string }) => u.id === publicUpdateId)
    expect(row.attachments).toHaveLength(2)
    const notes = row.attachments.find((a: { filename: string }) => a.filename === 'notes.txt')
    expect(notes.size).toBe(textBytes.length)
    expect(notes.mime).toBe('text/plain')
    const png = row.attachments.find((a: { filename: string }) =>
      a.filename.endsWith('.png'),
    )
    expect(png.filename).toBe('naïve-resume.png')
    expect(png.size).toBe(pngBytes.length)
    expect(png.mime).toBe('image/png')
    const onDisk = walkFiles(storageDir)
    expect(onDisk).toHaveLength(2)
    expect(onDisk.every((file) => file.startsWith(storageDir))).toBe(true)
    // exactly one level deep: <storageDir>/<2-char shard>/<id>
    expect(
      onDisk.every((file) => path.dirname(file).length === storageDir.length + 1 + 2),
    ).toBe(true)
  })

  it('serves the file back byte-equal with attachment + nosniff headers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/attachments/${pngAttachmentId}`,
      headers: { cookie: staffCookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('image/png')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['content-length']).toBe(String(pngBytes.length))
    expect(String(res.headers['content-disposition'])).toContain("filename*=UTF-8''")
    expect(String(res.headers['content-disposition'])).toContain('na%C3%AFve-resume.png')
    expect(res.rawPayload.equals(pngBytes)).toBe(true)
  })

  it('lets the ticket owner client download public attachments', async () => {
    const detail = await app.inject({
      method: 'GET',
      url: `/api/tickets/${ticketA}`,
      headers: { cookie: contactACookie },
    })
    expect(detail.statusCode).toBe(200)
    const row = detail.json().updates.find((u: { id: string }) => u.id === publicUpdateId)
    expect(row.attachments).toHaveLength(2)
    const res = await app.inject({
      method: 'GET',
      url: `/api/attachments/${pngAttachmentId}`,
      headers: { cookie: contactACookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.rawPayload.equals(pngBytes)).toBe(true)
  })

  it('hides internal-update attachments from contacts (detail + direct 404)', async () => {
    const boundary = `kbtest${randomUUID().replace(/-/g, '')}`
    const upload = await app.inject({
      method: 'POST',
      url: `/api/tickets/${ticketA}/updates`,
      headers: {
        cookie: staffCookie,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartBody(boundary, [
        { name: 'kind', content: 'internal' },
        { name: 'body', content: 'internal follow-up with a file' },
        { name: 'files', filename: 'secret.png', contentType: 'image/png', content: pngBytes },
      ]),
    })
    expect(upload.statusCode).toBe(201)
    const internalUpdateId = upload.json().id
    const internalDetail = await app.inject({
      method: 'GET',
      url: `/api/tickets/${ticketA}`,
      headers: { cookie: staffCookie },
    })
    const internalRow = internalDetail.json().updates.find(
      (u: { id: string }) => u.id === internalUpdateId,
    )
    const internalFileId = internalRow.attachments[0].id

    const contactDetail = await app.inject({
      method: 'GET',
      url: `/api/tickets/${ticketA}`,
      headers: { cookie: contactACookie },
    })
    expect(
      contactDetail.json().updates.some((u: { id: string }) => u.id === internalUpdateId),
    ).toBe(false)
    const direct = await app.inject({
      method: 'GET',
      url: `/api/attachments/${internalFileId}`,
      headers: { cookie: contactACookie },
    })
    expect(direct.statusCode).toBe(404)
  })

  it('404s another client contact for both the ticket and the attachment', async () => {
    const detail = await app.inject({
      method: 'GET',
      url: `/api/tickets/${ticketA}`,
      headers: { cookie: contactBCookie },
    })
    expect(detail.statusCode).toBe(404)
    const res = await app.inject({
      method: 'GET',
      url: `/api/attachments/${pngAttachmentId}`,
      headers: { cookie: contactBCookie },
    })
    expect(res.statusCode).toBe(404)
  })

  it('deletes an attachment as staff (row + file gone, audit row written)', async () => {
    const notesRow = await app
      .inject({
        method: 'GET',
        url: `/api/tickets/${ticketA}`,
        headers: { cookie: staffCookie },
      })
      .then((res) =>
        res.json().updates.find((u: { id: string }) => u.id === publicUpdateId)
          .attachments.find((a: { filename: string }) => a.filename === 'notes.txt'),
      )
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/attachments/${notesRow.id}`,
      headers: { cookie: staffCookie },
    })
    expect(del.statusCode).toBe(204)
    expect(walkFiles(storageDir).some((file) => path.basename(file) === notesRow.id)).toBe(false)
    const auditRows = await db
      .select()
      .from(audit)
      .where(eq(audit.action, 'attachment.delete'))
    expect(auditRows).toHaveLength(1)
    expect(auditRows[0].entityId).toBe(notesRow.id)
    expect(auditRows[0].meta).toMatchObject({ filename: 'notes.txt' })
    const res = await app.inject({
      method: 'GET',
      url: `/api/attachments/${notesRow.id}`,
      headers: { cookie: staffCookie },
    })
    expect(res.statusCode).toBe(404)
  })

  it('forbids deletion by contacts', async () => {
    const boundary = `kbtest${randomUUID().replace(/-/g, '')}`
    const upload = await app.inject({
      method: 'POST',
      url: `/api/tickets/${ticketA}/updates`,
      headers: {
        cookie: contactACookie,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartBody(boundary, [
        { name: 'body', content: 'a file from the portal' },
        { name: 'files', filename: 'mine.txt', contentType: 'text/plain', content: 'hello' },
      ]),
    })
    expect(upload.statusCode).toBe(201)
    // contact uploads are forced public even if the field says otherwise
    const detail = await app.inject({
      method: 'GET',
      url: `/api/tickets/${ticketA}`,
      headers: { cookie: staffCookie },
    })
    const row = detail.json().updates.find((u: { id: string }) => u.id === upload.json().id)
    expect(row.kind).toBe('public')
    const fileId = row.attachments[0].id
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/attachments/${fileId}`,
      headers: { cookie: contactACookie },
    })
    expect(del.statusCode).toBe(403)
  })

  it('rejects oversized files with 413 and leaves no rows or orphan files', async () => {
    const before = { count: (await db.select().from(attachments)).length, files: walkFiles(storageDir) }
    process.env.ATTACHMENT_MAX_MB = '1'
    try {
      const boundary = `kbtest${randomUUID().replace(/-/g, '')}`
      const res = await app.inject({
        method: 'POST',
        url: `/api/tickets/${ticketA}/updates`,
        headers: {
          cookie: staffCookie,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: multipartBody(boundary, [
          { name: 'body', content: 'too big' },
          {
            name: 'files',
            filename: 'big.bin',
            contentType: 'application/octet-stream',
            content: Buffer.alloc(1024 * 1024 + 1),
          },
        ]),
      })
      expect(res.statusCode).toBe(413)
      expect(res.json().error).toBe('file_too_large')
      expect(String(res.json().message)).toContain('1MB')
    } finally {
      delete process.env.ATTACHMENT_MAX_MB
    }
    expect((await db.select().from(attachments)).length).toBe(before.count)
    expect(walkFiles(storageDir).sort()).toEqual(before.files.sort())
  })

  it('strips path components from the filename and serves from the storage dir', async () => {
    // Defense in depth: busboy already reduces the client filename to its base
    // name (defense 1); the disk path uses only the server-generated id
    // (defense 2). Either alone is sufficient — the name never reaches a path.
    const boundary = `kbtest${randomUUID().replace(/-/g, '')}`
    const upload = await app.inject({
      method: 'POST',
      url: `/api/tickets/${ticketA}/updates`,
      headers: {
        cookie: staffCookie,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartBody(boundary, [
        { name: 'body', content: 'traversal attempt' },
        { name: 'files', filename: '../../evil.png', contentType: 'image/png', content: pngBytes },
      ]),
    })
    expect(upload.statusCode).toBe(201)
    const detail = await app.inject({
      method: 'GET',
      url: `/api/tickets/${ticketA}`,
      headers: { cookie: staffCookie },
    })
    const row = detail.json().updates.find((u: { id: string }) => u.id === upload.json().id)
    const file = row.attachments[0]
    expect(file.filename).toBe('evil.png')
    const onDisk = walkFiles(storageDir)
    expect(onDisk).toContain(path.join(storageDir, file.id.slice(0, 2), file.id))
    const res = await app.inject({
      method: 'GET',
      url: `/api/attachments/${file.id}`,
      headers: { cookie: staffCookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.rawPayload.equals(pngBytes)).toBe(true)
    expect(statSync(path.join(storageDir, file.id.slice(0, 2), file.id)).size).toBe(
      pngBytes.length,
    )
  })

  it('rejects more than ten files on one update', async () => {
    const boundary = `kbtest${randomUUID().replace(/-/g, '')}`
    const parts: Part[] = [{ name: 'body', content: 'too many' }]
    for (let i = 0; i < 11; i++) {
      parts.push({ name: 'files', filename: `f${i}.txt`, contentType: 'text/plain', content: 'x' })
    }
    const res = await app.inject({
      method: 'POST',
      url: `/api/tickets/${ticketA}/updates`,
      headers: {
        cookie: staffCookie,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartBody(boundary, parts),
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().error).toBe('bad_request')
  })

  it('keeps the JSON-only update path working (no attachments)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/tickets/${ticketA}/updates`,
      headers: { cookie: staffCookie, 'content-type': 'application/json' },
      payload: { kind: 'public', body: 'plain text reply, no files' },
    })
    expect(res.statusCode).toBe(201)
    const detail = await app.inject({
      method: 'GET',
      url: `/api/tickets/${ticketA}`,
      headers: { cookie: staffCookie },
    })
    const row = detail.json().updates.find((u: { id: string }) => u.id === res.json().id)
    expect(row.attachments).toEqual([])
  })
})
