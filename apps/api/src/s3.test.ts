import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { db } from './db'
import { runMigrations } from './db/migrate'
import {
  attachments,
  audit,
  clients,
  contactClients,
  contacts,
  settings,
  tickets,
  updates,
  users,
} from './db/schema'
import {
  EMPTY_SHA256,
  isS3Configured,
  s3DeleteObject,
  s3GetObject,
  s3HeadObject,
  s3PresignGet,
  s3PutObject,
} from './s3'
import {
  AttachmentSizeError,
  attachmentFileSize,
  attachmentPath,
  deleteAttachmentFile,
  streamImageFile,
  storageBackend,
  writeAttachmentFile,
} from './storage'

// S3 adapter tests (plan row 18, part 2 — issue #34). Three layers:
//   1. the SigV4 client against a local mock S3 — the mock RECOMPUTES the
//      expected signature from the wire bytes (independent implementation of
//      the canonical-request/string-to-sign), so a wrong client fails the
//      mock's auth check, not just a happy-path assert.
//   2. the storage seam — write/read/head/delete/image-serve route to S3 when
//      configured and to local disk otherwise.
//   3. the attachment download route — S3 backend 302s to a presigned URL and
//      the direct fetch returns the exact bytes with the DB mime + disposition.
//
// Env hygiene: this file mutates process.env.S3_* + STORAGE_DIR directly (one
// worker per file keeps it contained); every test that needs S3 calls
// setS3Env, and afterEach clears the whole set.

type App = Awaited<ReturnType<typeof buildApp>>

const ACCESS_KEY = 'AKIATEST'
const SECRET_KEY = 'test-secret-key-0904'
const REGION = 'us-east-1'
const BUCKET = 'kipple-test'
const S3_KEYS = [
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_REGION',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_FORCE_PATH_STYLE',
  'S3_PATH_PREFIX',
]

function setS3Env(url: string): void {
  process.env.S3_ENDPOINT = url
  process.env.S3_BUCKET = BUCKET
  process.env.S3_REGION = REGION
  process.env.S3_ACCESS_KEY_ID = ACCESS_KEY
  process.env.S3_SECRET_ACCESS_KEY = SECRET_KEY
  process.env.S3_FORCE_PATH_STYLE = 'true'
}

function clearS3Env(): void {
  for (const key of S3_KEYS) delete process.env[key]
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex')
}

function kSigning(dateStamp: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${SECRET_KEY}`, dateStamp), REGION), 's3'), 'aws4_request')
}

// Header-auth (PUT/GET/HEAD/DELETE): recompute the signature the client
// SHOULD have produced from the headers/body actually received on the wire.
function verifyHeaderSig(
  req: IncomingMessage,
  body: Buffer,
  wirePath: string,
  authorization: string,
): boolean {
  const match =
    /^AWS4-HMAC-SHA256 Credential=([^/,]+)\/(.+), SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/.exec(
      authorization,
    )
  if (!match) return false
  const [, , scope, signedHeaders, signature] = match
  const dateStamp = scope.split('/')[0]
  const xAmzDate = req.headers['x-amz-date']
  if (typeof xAmzDate !== 'string' || xAmzDate.slice(0, 8) !== dateStamp) return false
  const canonicalHeaders = signedHeaders
    .split(';')
    .map((name) => `${name}:${String(req.headers[name] ?? '').trim()}\n`)
    .join('')
  const canonicalRequest = [
    req.method ?? '',
    wirePath,
    '',
    canonicalHeaders,
    signedHeaders,
    sha256(body),
  ].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', xAmzDate, scope, sha256(canonicalRequest)].join('\n')
  return hmac(kSigning(dateStamp), stringToSign).toString('hex') === signature
}

// Query-auth (presigned): the canonical query is the raw wire query minus the
// signature itself (values already single-encoded); only `host` is signed.
function verifyQuerySig(req: IncomingMessage, rawQuery: string, wirePath: string): boolean {
  const params = new URLSearchParams(rawQuery)
  const algorithm = params.get('X-Amz-Algorithm')
  const credential = params.get('X-Amz-Credential')
  const xAmzDate = params.get('X-Amz-Date')
  const signedHeaders = params.get('X-Amz-SignedHeaders')
  const signature = params.get('X-Amz-Signature')
  if (
    algorithm !== 'AWS4-HMAC-SHA256' ||
    !credential ||
    !xAmzDate ||
    signedHeaders !== 'host' ||
    !signature
  ) {
    return false
  }
  const slash = credential.indexOf('/')
  const scope = slash === -1 ? '' : credential.slice(slash + 1)
  const dateStamp = xAmzDate.slice(0, 8)
  // Code-unit (UTF-16) sort by encoded name — the S3 canonical form, and
  // the same order the client's Object.keys().sort() produces (localeCompare
  // is case-insensitive in the default locale and would reorder X-Amz-* vs
  // lowercase params).
  const pairs = rawQuery
    .split('&')
    .filter((pair) => !pair.startsWith('X-Amz-Signature='))
    .sort((a, b) => {
      const nameA = a.split('=')[0]
      const nameB = b.split('=')[0]
      return nameA < nameB ? -1 : nameA > nameB ? 1 : 0
    })
  const canonicalQuery = pairs.join('&')
  const host = String(req.headers['host'] ?? '')
  const canonicalRequest = [
    'GET',
    wirePath,
    canonicalQuery,
    `host:${host}\n`,
    'host',
    EMPTY_SHA256,
  ].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', xAmzDate, scope, sha256(canonicalRequest)].join('\n')
  return hmac(kSigning(dateStamp), stringToSign).toString('hex') === signature
}

type MockS3 = {
  url: string
  objects: Map<string, Buffer>
  signatureFailures: string[]
  close: () => Promise<void>
}

function startMockS3(): Promise<MockS3> {
  return new Promise((resolve) => {
    const objects = new Map<string, Buffer>()
    const signatureFailures: string[] = []
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        const body = Buffer.concat(chunks)
        const rawQuery = (req.url ?? '').split('?')[1] ?? ''
        const wirePath = (req.url ?? '').split('?')[0]
        const parts = wirePath.split('/')
        if (parts[1] !== BUCKET) {
          res.writeHead(404, { 'content-type': 'text/xml' })
          res.end('<Error><Code>NotFound</Code></Error>')
          return
        }
        const key = decodeURIComponent(parts.slice(2).join('/'))
        let valid = false
        const authorization = req.headers['authorization']
        if (typeof authorization === 'string') {
          valid = verifyHeaderSig(req, body, wirePath, authorization)
        } else if (rawQuery.includes('X-Amz-Signature=')) {
          valid = verifyQuerySig(req, rawQuery, wirePath)
        }
        if (!valid) {
          signatureFailures.push(`${req.method} ${wirePath}`)
          res.writeHead(403, { 'content-type': 'text/xml' })
          res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>')
          return
        }
        const overrideType = new URLSearchParams(rawQuery).get('response-content-type')
        const overrideDisposition = new URLSearchParams(rawQuery).get('response-content-disposition')
        if (req.method === 'PUT') {
          objects.set(key, body)
          res.writeHead(200, { etag: '"mock"' })
          res.end()
        } else if (req.method === 'GET') {
          const object = objects.get(key)
          if (!object) {
            res.writeHead(404, { 'content-type': 'text/xml' })
            res.end('<Error><Code>NoSuchKey</Code></Error>')
          } else {
            res.writeHead(200, {
              'content-length': object.length,
              'content-type': overrideType ?? 'application/octet-stream',
              ...(overrideDisposition ? { 'content-disposition': overrideDisposition } : {}),
            })
            res.end(object)
          }
        } else if (req.method === 'HEAD') {
          const object = objects.get(key)
          if (!object) {
            res.writeHead(404)
            res.end()
          } else {
            res.writeHead(200, { 'content-length': object.length })
            res.end()
          }
        } else if (req.method === 'DELETE') {
          objects.delete(key)
          res.writeHead(204)
          res.end()
        } else {
          res.writeHead(405)
          res.end()
        }
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({
        url: `http://127.0.0.1:${port}`,
        objects,
        signatureFailures,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}

let mock: MockS3

beforeAll(async () => {
  mock = await startMockS3()
})

afterAll(async () => {
  clearS3Env()
  await mock.close()
})

afterEach(() => {
  clearS3Env()
})

describe('SigV4 client against the mock S3', () => {
  // getRandomValues caps at 65,536 bytes per call — fill 1 MiB in chunks.
  const big = () => {
    const buf = Buffer.alloc(1024 * 1024)
    for (let offset = 0; offset < buf.length; offset += 65536) {
      crypto.getRandomValues(new Uint8Array(buf.buffer, buf.byteOffset + offset, 65536))
    }
    return buf
  }

  it('isS3Configured tracks the env', () => {
    expect(isS3Configured()).toBe(false)
    expect(storageBackend()).toBe('local')
    setS3Env(mock.url)
    expect(isS3Configured()).toBe(true)
    expect(storageBackend()).toBe('s3')
    delete process.env.S3_SECRET_ACCESS_KEY
    expect(isS3Configured()).toBe(false)
  })

  it('put then get round-trips bytes exactly (mock verified the signature)', async () => {
    setS3Env(mock.url)
    const bytes = big()
    await s3PutObject('obj-1', bytes)
    expect(mock.objects.get('obj-1')).toEqual(bytes)
    const got = await s3GetObject('obj-1')
    expect(got).toEqual(bytes)
    expect(mock.signatureFailures).toEqual([])
  })

  it('head returns size; missing head and get are null', async () => {
    setS3Env(mock.url)
    const bytes = Buffer.from('head-body')
    await s3PutObject('obj-2', bytes)
    expect(await s3HeadObject('obj-2')).toEqual({ size: bytes.length })
    expect(await s3HeadObject('missing')).toBeNull()
    expect(await s3GetObject('missing')).toBeNull()
    expect(mock.signatureFailures).toEqual([])
  })

  it('delete removes; deleting a missing object is a no-op', async () => {
    setS3Env(mock.url)
    await s3PutObject('obj-3', Buffer.from('x'))
    await s3DeleteObject('obj-3')
    expect(mock.objects.has('obj-3')).toBe(false)
    await expect(s3DeleteObject('obj-3')).resolves.toBeUndefined()
  })

  it('S3_PATH_PREFIX namespaces the object keys', async () => {
    setS3Env(mock.url)
    process.env.S3_PATH_PREFIX = 'kipple/prod'
    await s3PutObject('prefixed', Buffer.from('p'))
    expect(mock.objects.has('kipple/prod/prefixed')).toBe(true)
    expect(mock.objects.has('prefixed')).toBe(false)
  })

  it('virtual-host addressing (no network): bucket goes in the host', () => {
    setS3Env('https://s3.example.com')
    process.env.S3_FORCE_PATH_STYLE = 'false'
    const url = s3PresignGet('virtual-key')
    expect(url.startsWith('https://kipple-test.s3.example.com/virtual-key?')).toBe(true)
  })

  it('presigned GET is accepted by the mock and applies the response overrides', async () => {
    setS3Env(mock.url)
    const bytes = Buffer.from('presigned payload')
    await s3PutObject('obj-4', bytes)
    const url = s3PresignGet('obj-4', {
      expiresSec: 600,
      responseContentType: 'text/plain; charset=utf-8',
      responseContentDisposition: 'attachment; filename="vpn log.txt"',
    })
    expect(url).toContain('X-Amz-Signature=')
    const res = await fetch(url)
    expect(res.status).toBe(200)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(bytes))
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="vpn log.txt"')
    expect(mock.signatureFailures).toEqual([])
  })

  it('presigned GET for a missing object 404s', async () => {
    setS3Env(mock.url)
    const res = await fetch(s3PresignGet('ghost-object'))
    expect(res.status).toBe(404)
  })

  it('put without configuration throws', async () => {
    expect(isS3Configured()).toBe(false)
    await expect(s3PutObject('nowhere', Buffer.from('x'))).rejects.toThrow(/not configured/)
    await expect(s3GetObject('nowhere')).rejects.toThrow(/not configured/)
  })
})

describe('storage seam routing', () => {
  let storageDir: string

  beforeAll(() => {
    storageDir = mkdtempSync(path.join(tmpdir(), 'kipple-s3-seam-'))
    process.env.STORAGE_DIR = storageDir
  })

  afterAll(() => {
    delete process.env.STORAGE_DIR
    rmSync(storageDir, { recursive: true, force: true })
  })

  it('writeAttachmentFile goes to S3, not disk', async () => {
    setS3Env(mock.url)
    const partA = Buffer.from('attachment ')
    const partB = Buffer.from('bytes here')
    const size = await writeAttachmentFile('seam-key-1', Readable.from([partA, partB]), 1024)
    expect(size).toBe(partA.length + partB.length)
    expect(mock.objects.get('seam-key-1')).toEqual(Buffer.concat([partA, partB]))
    expect(() => statSync(attachmentPath('seam-key-1'))).toThrow()
  })

  it('size overflow over S3 throws AttachmentSizeError and persists nothing', async () => {
    setS3Env(mock.url)
    const stream = Readable.from([Buffer.alloc(8, 1), Buffer.alloc(8, 2)])
    await expect(writeAttachmentFile('seam-key-2', stream, 10)).rejects.toBeInstanceOf(
      AttachmentSizeError,
    )
    expect(mock.objects.has('seam-key-2')).toBe(false)
  })

  it('attachmentFileSize and deleteAttachmentFile route to S3', async () => {
    setS3Env(mock.url)
    await s3PutObject('seam-key-3', Buffer.from('0123456789'))
    expect(await attachmentFileSize('seam-key-3')).toBe(10)
    expect(await attachmentFileSize('seam-missing')).toBeNull()
    await deleteAttachmentFile('seam-key-3')
    expect(mock.objects.has('seam-key-3')).toBe(false)
  })

  it('streamImageFile serves S3 bytes with the magic-sniffed mime', async () => {
    setS3Env(mock.url)
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6]),
      Buffer.alloc(16),
    ])
    await s3PutObject('seam-img', png)
    const headers: Record<string, string> = {}
    let sent: unknown
    const reply = {
      header: (name: string, value: string) => {
        headers[name] = value
      },
      send: (body: Buffer) => {
        sent = body
        return body
      },
    }
    await streamImageFile(reply, 'seam-img')
    expect(headers['content-type']).toBe('image/png')
    expect(sent).toEqual(png)
  })

  it('local backend still writes sharded disk files', async () => {
    expect(storageBackend()).toBe('local')
    const bytes = Buffer.from('local disk bytes')
    const size = await writeAttachmentFile('abcd1234', Readable.from([bytes]), 1024)
    expect(size).toBe(bytes.length)
    expect(statSync(attachmentPath('abcd1234')).size).toBe(bytes.length)
    expect(await attachmentFileSize('abcd1234')).toBe(bytes.length)
  })
})

describe('attachment download route → presigned 302 (integration)', () => {
  const owner = {
    instanceName: 'S3 Test MSP',
    ownerName: 'Max Kulik',
    ownerEmail: 'max@s3test.dev',
    password: 'correct-horse-battery',
  }

  let app: App
  let storageDir: string
  let ownerCookie: string
  let clientId: string
  let ticketId: string
  let attachmentId: string
  const fileBytes = Buffer.from('s3 attachment payload — bytes survive the hop')

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

  beforeAll(async () => {
    storageDir = mkdtempSync(path.join(tmpdir(), 'kipple-s3-route-'))
    process.env.STORAGE_DIR = storageDir
    setS3Env(mock.url)
    await runMigrations()
    await db.delete(attachments)
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
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: owner.ownerEmail, password: owner.password },
    })
    expect(login.statusCode).toBe(200)
    ownerCookie = cookiesFrom(login)

    const clientRes = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie: ownerCookie },
      payload: { name: 'Acme Corp', domain: 'acme.test' },
    })
    expect(clientRes.statusCode).toBe(201)
    clientId = clientRes.json().id
    const ticketRes = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: ownerCookie },
      payload: { clientId, subject: 'Log attached', body: 'See file.' },
    })
    expect(ticketRes.statusCode).toBe(201)
    ticketId = ticketRes.json().id

    const boundary = 's3-route-test-boundary'
    const upload = await app.inject({
      method: 'POST',
      url: `/api/tickets/${ticketId}/updates`,
      headers: {
        cookie: ownerCookie,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartBody(boundary, [
        { name: 'kind', content: 'public' },
        { name: 'body', content: 'Log attached' },
        { name: 'file', filename: 'vpn log.txt', content: fileBytes },
      ]),
    })
    expect(upload.statusCode).toBe(201)
    const [att] = await db.select({ id: attachments.id }).from(attachments)
    attachmentId = att.id
  })

  afterAll(() => {
    delete process.env.STORAGE_DIR
    rmSync(storageDir, { recursive: true, force: true })
  })

  // The root afterEach clears S3 env between tests — re-stub per test so the
  // backend stays 's3' across the whole suite.
  beforeEach(() => {
    setS3Env(mock.url)
  })

  it('uploads land in the mock S3 (not on disk)', async () => {
    const [row] = await db.select({ storageKey: attachments.storageKey }).from(attachments)
    expect(mock.objects.get(row.storageKey)).toEqual(fileBytes)
    expect(() => statSync(attachmentPath(row.storageKey))).toThrow()
  })

  it('GET /api/attachments/:id 302s to a presigned URL; the direct fetch is byte-exact', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/attachments/${attachmentId}`,
      headers: { cookie: ownerCookie },
    })
    expect(res.statusCode).toBe(302)
    const location = res.headers['location'] as string
    expect(location.startsWith(mock.url)).toBe(true)
    expect(location).toContain('X-Amz-Signature=')
    expect(location).toContain('response-content-type=')
    const direct = await fetch(location)
    expect(direct.status).toBe(200)
    expect(new Uint8Array(await direct.arrayBuffer())).toEqual(new Uint8Array(fileBytes))
    expect(direct.headers.get('content-type')).toBe('text/plain')
    expect(direct.headers.get('content-disposition') ?? '').toContain('filename="vpn log.txt"')
    expect(mock.signatureFailures).toEqual([])
  })

  it('out-of-scope downloads are still 404 (scope check runs before minting)', async () => {
    // The owner is superuser (scope-exempt), so mint a scoped admin on a
    // DIFFERENT client and try to fetch the owner's file.
    const adminCreate = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: ownerCookie },
      payload: {
        name: 'Dana Admin',
        email: 'dana@s3test.dev',
        password: 'dana-pass-0904',
        role: 'admin',
      },
    })
    expect(adminCreate.statusCode).toBe(200)
    const otherClient = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie: ownerCookie },
      payload: { name: 'Globex', domain: 'globex.test' },
    })
    expect(otherClient.statusCode).toBe(201)
    const adminId = adminCreate.json().id
    const scopeRes = await app.inject({
      method: 'PATCH',
      url: `/api/users/${adminId}`,
      headers: { cookie: ownerCookie },
      payload: { clientId: otherClient.json().id },
    })
    expect(scopeRes.statusCode).toBe(200)
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'dana@s3test.dev', password: 'dana-pass-0904' },
    })
    expect(adminLogin.statusCode).toBe(200)
    const res = await app.inject({
      method: 'GET',
      url: `/api/attachments/${attachmentId}`,
      headers: { cookie: cookiesFrom(adminLogin) },
    })
    expect(res.statusCode).toBe(404)
    // No presigned URL was ever minted for the out-of-scope file:
    expect(res.headers['location']).toBeUndefined()
  })
})
