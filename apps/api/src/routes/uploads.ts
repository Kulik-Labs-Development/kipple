import { randomUUID } from 'node:crypto'
import { mkdir, open, truncate, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { FastifyInstance } from 'fastify'
import { eq, and } from 'drizzle-orm'
import { requireUser } from '../access'
import { logAudit } from '../audit'
import { db } from '../db'
import { uploads } from '../db/schema'
import { cleanFilename } from '../storage'
import {
  effectiveUploadSettings,
  mimeAllowed,
  mimeNotAllowedBody,
  sweepExpiredUploads,
  uploadExpiryHours,
  uploadTempPath,
} from '../uploads'

// Chunked (tus-compatible) upload staging, plan row 18 part 1. The endpoints
// implement the minimum of the tus 1.0 protocol kipple needs: creation via
// POST + Upload-Metadata, resume via Upload-Offset (HEAD/GET + PATCH with
// application/offset+octet-stream), and DELETE. No CORS, no cross-origin
// preflight (same-origin web app), no concurrency extension. Files stage in
// <STORAGE_DIR>/uploads-temp/<id> until a ticket update consumes them.

const TUS_REVERSABLE = '1.0.0'
const CHUNK_CONTENT_TYPE = 'application/offset+octet-stream'

export async function registerUploadRoutes(app: FastifyInstance): Promise<void> {
  // Fastify rejects bodies of unregistered media types before any handler
  // runs (FST_ERR_CTP_INVALID_MEDIA_TYPE); the tus chunk type is the one the
  // PATCH handler streams from request.raw, so register a pass-through parser
  // that never consumes the payload.
  app.addContentTypeParser(CHUNK_CONTENT_TYPE, (_request, _payload, done) => {
    done(null, undefined)
  })
  // Capability advertisement. Unauthenticated on purpose: it exposes only
  // protocol constants + the effective max size (not user data).
  app.options('/api/uploads', async (_request, reply) => {
    const { maxBytes } = await effectiveUploadSettings()
    reply.header('Tus-Resumable', TUS_REVERSABLE)
    reply.header('Tus-Version', '1.0.0')
    reply.header('Tus-Extension', 'creation, expiration')
    reply.header('Tus-Max-Size', String(maxBytes))
    return reply.code(200).send({ ok: true })
  })

  // Create a staged upload. Upload-Length declares the total size; the
  // MIME comes from Upload-Metadata (base64 values, tus creation extension)
  // and is checked against the instance allowlist.
  app.post('/api/uploads', async (request, reply) => {
    const session = await requireUser(request, reply)
    if (!session) return null
    const { maxBytes, allowedMimes } = await effectiveUploadSettings()
    await sweepExpiredUploads()

    const rawLength = request.headers['upload-length']
    const size = typeof rawLength === 'string' ? Number.parseInt(rawLength, 10) : Number.NaN
    if (!Number.isFinite(size) || size <= 0) {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'Upload-Length header is required' })
    }
    if (size > maxBytes) {
      const mb = Math.max(1, Math.round(maxBytes / (1024 * 1024)))
      return reply
        .code(413)
        .send({ error: 'file_too_large', message: `attachment exceeds the ${mb}MB limit` })
    }

    let filename = ''
    let mime = 'application/octet-stream'
    const rawMeta = request.headers['upload-metadata']
    if (typeof rawMeta === 'string' && rawMeta.length > 0) {
      // tus 1.0 creation extension: "key base64value,key2 base64value"
      for (const pair of rawMeta.split(',')) {
        const spaceIdx = pair.indexOf(' ')
        if (spaceIdx < 1) continue
        const key = pair.slice(0, spaceIdx).trim()
        let value = ''
        try {
          value = Buffer.from(pair.slice(spaceIdx + 1).trim(), 'base64').toString('utf8')
        } catch {
          value = ''
        }
        if (key === 'filename') filename = value
        else if (key === 'mime') mime = value
      }
    }
    filename = cleanFilename(filename)
    mime = mime.trim().slice(0, 128) || 'application/octet-stream'
    if (!mimeAllowed(mime, allowedMimes)) {
      return reply.code(415).send(mimeNotAllowedBody(mime))
    }

    const id = randomUUID()
    await mkdir(path.dirname(uploadTempPath(id)), { recursive: true })
    const expiresAt = new Date(Date.now() + uploadExpiryHours() * 3600 * 1000)
    await db.insert(uploads).values({
      id,
      userId: session.user.id,
      filename,
      mime,
      size,
      offset: 0,
      status: 'open',
      expiresAt,
    })
    await logAudit(session.user.id, 'upload.create', 'upload', id, {
      filename,
      mime,
      size,
    })
    reply.header('Tus-Resumable', TUS_REVERSABLE)
    return reply
      .code(201)
      .header('Location', `/api/uploads/${id}`)
      .send({ status: 'created', id, expiresAt })
  })

  // Resume state. GET = JSON (the web client's resume path); HEAD = tus
  // protocol shape (Upload-Offset + Upload-Length + Tus-Resumable, empty
  // body) — fastify auto-routes HEAD to the GET handler and strips the body.
  app.get('/api/uploads/:id', async (request, reply) => {
    const session = await requireUser(request, reply)
    if (!session) return null
    const { id } = request.params as { id: string }
    const [row] = await db.select().from(uploads).where(eq(uploads.id, id))
    if (!row || row.userId !== session.user.id) {
      return reply.code(404).send({ error: 'not_found', message: 'upload not found' })
    }
    reply.header('Tus-Resumable', TUS_REVERSABLE)
    if (request.method === 'HEAD') {
      reply.header('Upload-Offset', String(row.offset))
      reply.header('Upload-Length', String(row.size))
      return reply.code(200).send()
    }
    return {
      id: row.id,
      filename: row.filename,
      mime: row.mime,
      size: row.size,
      offset: row.offset,
      status: row.status,
      expiresAt: row.expiresAt,
    }
  })

  // Append bytes. Upload-Offset must equal the server's offset (409 on
  // mismatch — the client re-fetches and resumes). The request stream is
  // appended as it arrives; a chunk that would overshoot the declared size
  // 413s and the partial append is rolled back (truncate to the pre-chunk
  // offset).
  app.patch('/api/uploads/:id', async (request, reply) => {
    const session = await requireUser(request, reply)
    if (!session) return null
    const { id } = request.params as { id: string }
    const [row] = await db.select().from(uploads).where(eq(uploads.id, id))
    if (!row || row.userId !== session.user.id) {
      return reply.code(404).send({ error: 'not_found', message: 'upload not found' })
    }
    if (row.status !== 'open') {
      return reply
        .code(409)
        .send({ error: 'upload_finished', message: 'upload is not accepting more bytes' })
    }
    if (row.expiresAt < new Date()) {
      return reply
        .code(410)
        .send({ error: 'upload_expired', message: 'upload expired — create a new one' })
    }
    const contentType = String(request.headers['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase()
    if (contentType !== CHUNK_CONTENT_TYPE) {
      return reply
        .code(415)
        .send({
          error: 'bad_request',
          message: `content-type must be ${CHUNK_CONTENT_TYPE}`,
        })
    }
    const rawOffset = request.headers['upload-offset']
    const offset = typeof rawOffset === 'string' ? Number.parseInt(rawOffset, 10) : Number.NaN
    if (!Number.isFinite(offset) || offset !== row.offset) {
      return reply.code(409).send({
        error: 'offset_mismatch',
        message: `expected Upload-Offset ${row.offset}`,
      })
    }

    const remaining = row.size - row.offset
    const temp = uploadTempPath(id)
    const handle = await open(temp, 'a+')
    let written = 0
    let overshot = false
    try {
      for await (const chunk of request.raw) {
        const buf = chunk as Buffer
        written += buf.length
        if (written > remaining) {
          overshot = true
          break
        }
        await handle.write(buf)
      }
    } finally {
      await handle.close().catch(() => undefined)
    }
    if (overshot) {
      await truncate(temp, row.offset).catch(() => undefined)
      return reply.code(413).send({
        error: 'file_too_large',
        message: 'chunk exceeds the declared file size',
      })
    }

    const newOffset = row.offset + written
    const complete = newOffset >= row.size
    await db
      .update(uploads)
      .set({ offset: newOffset, status: complete ? 'complete' : 'open' })
      .where(and(eq(uploads.id, id), eq(uploads.offset, row.offset)))
    reply.header('Tus-Resumable', TUS_REVERSABLE)
    reply.header('Upload-Offset', String(newOffset))
    return reply.code(204).send()
  })

  // Abandon a staged upload (not consumed yet).
  app.delete('/api/uploads/:id', async (request, reply) => {
    const session = await requireUser(request, reply)
    if (!session) return null
    const { id } = request.params as { id: string }
    const [row] = await db.select().from(uploads).where(eq(uploads.id, id))
    if (!row || row.userId !== session.user.id) {
      return reply.code(404).send({ error: 'not_found', message: 'upload not found' })
    }
    if (row.status === 'consumed') {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'upload already attached' })
    }
    await db.delete(uploads).where(eq(uploads.id, id))
    await unlink(uploadTempPath(id)).catch(() => undefined)
    await logAudit(session.user.id, 'upload.delete', 'upload', id, {
      filename: row.filename,
      size: row.size,
    })
    return reply.code(204).send()
  })
}
