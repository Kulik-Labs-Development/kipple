import { mkdir, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { UploadSettings, mimeAllowed } from '@kipple/shared'
import { and, eq, inArray, lt, ne } from 'drizzle-orm'
import { db } from './db'
import { settings, uploads } from './db/schema'
import { attachmentPath, envMaxAttachmentMb, storageDir } from './storage'

export type UploadSettingsView = { maxMb: number; allowedMimes: string[] }

// 415 for a MIME type the instance does not allow (row 18 part 1). Thrown
// from the multipart path in tickets.ts, mapped there; the tus POST checks
// inline.
export class MimeNotAllowedError extends Error {
  constructor(public readonly mime: string) {
    super(`mime type not allowed: ${mime}`)
    this.name = 'MimeNotAllowedError'
  }
}

export function mimeNotAllowedBody(mime: string) {
  return {
    error: 'mime_not_allowed',
    message: `${mime || 'unknown'} is not an allowed attachment type`,
  }
}

// Unconsumed uploads are swept on create; UPLOAD_EXPIRY_HOURS (default 24).
export function uploadExpiryHours(): number {
  const raw = process.env.UPLOAD_EXPIRY_HOURS
  const hours = raw ? Number.parseInt(raw, 10) : 24
  if (!Number.isFinite(hours) || hours < 1) return 24
  return hours
}

// Temp staging file for a chunked upload. Like attachment paths, the id is
// server-generated so client data never touches the path.
export function uploadTempPath(id: string): string {
  return path.join(storageDir(), 'uploads-temp', id)
}

// Effective upload settings: the instance settings row ('uploads') beats the
// env default; absent row = env ATTACHMENT_MAX_MB + open MIME allowlist.
// A malformed row degrades to the defaults rather than 500-ing every upload.
export async function effectiveUploadSettings(): Promise<{
  maxBytes: number
  allowedMimes: string[]
  view: UploadSettingsView
}> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, 'uploads'))
  const parsed = row?.value ? UploadSettings.safeParse(row.value) : null
  const view: UploadSettingsView = parsed?.success
    ? { maxMb: parsed.data.maxMb, allowedMimes: parsed.data.allowedMimes }
    : { maxMb: envMaxAttachmentMb(), allowedMimes: [] }
  return {
    maxBytes: view.maxMb * 1024 * 1024,
    allowedMimes: view.allowedMimes,
    view,
  }
}

// Delete expired unconsumed rows + their temp files. Called lazily on upload
// create (part 1 has no worker tick for this).
export async function sweepExpiredUploads(): Promise<number> {
  const now = new Date()
  const expired = await db
    .select({ id: uploads.id })
    .from(uploads)
    .where(and(lt(uploads.expiresAt, now), ne(uploads.status, 'consumed')))
  for (const row of expired) {
    await db.delete(uploads).where(eq(uploads.id, row.id))
    await unlink(uploadTempPath(row.id)).catch(() => undefined)
  }
  return expired.length
}

export type ConsumeableUpload = {
  id: string
  filename: string
  mime: string
  size: number
}

// Validate a batch of staged uploads for consumption by a ticket update:
// all must exist, belong to the acting user, be complete, unexpired, and
// still on disk. A foreign/unknown id 404s (no existence leaks); state
// problems 400 with a per-row message.
export async function resolveUploadsForConsume(
  ids: string[],
  userId: string,
): Promise<{ rows: ConsumeableUpload[]; error: { status: number; error: string; message: string } | null }> {
  if (ids.length === 0) return { rows: [], error: null }
  if (new Set(ids).size !== ids.length) {
    return {
      rows: [],
      error: { status: 400, error: 'bad_request', message: 'duplicate upload ids' },
    }
  }
  const found = await db.select().from(uploads).where(inArray(uploads.id, ids))
  const byId = new Map(found.map((row) => [row.id, row]))
  const now = new Date()
  const rows: ConsumeableUpload[] = []
  for (const id of ids) {
    const row = byId.get(id)
    if (!row || row.userId !== userId) {
      return {
        rows: [],
        error: { status: 404, error: 'not_found', message: 'upload not found' },
      }
    }
    if (row.status === 'consumed') {
      return {
        rows: [],
        error: {
          status: 400,
          error: 'upload_consumed',
          message: `upload ${row.filename} was already attached`,
        },
      }
    }
    if (row.status !== 'complete' || row.offset < row.size) {
      return {
        rows: [],
        error: {
          status: 400,
          error: 'upload_incomplete',
          message: `upload ${row.filename} has not finished transferring`,
        },
      }
    }
    if (row.expiresAt < now) {
      return {
        rows: [],
        error: {
          status: 400,
          error: 'upload_expired',
          message: `upload ${row.filename} expired — transfer it again`,
        },
      }
    }
    const info = await stat(uploadTempPath(id)).catch(() => null)
    if (!info || info.size !== row.size) {
      return {
        rows: [],
        error: {
          status: 400,
          error: 'upload_missing',
          message: `upload ${row.filename} is no longer available`,
        },
      }
    }
    rows.push({ id: row.id, filename: row.filename, mime: row.mime, size: row.size })
  }
  return { rows, error: null }
}

// Move a staged temp file to the sharded final location for `newKey`
// (the new attachment id). The caller owns cleanup on transaction failure.
export async function moveUploadToFinal(uploadId: string, newKey: string): Promise<void> {
  const target = attachmentPath(newKey)
  await mkdir(path.dirname(target), { recursive: true })
  await rename(uploadTempPath(uploadId), target)
}

// Flip the staging rows to consumed. Call inside the same transaction that
// inserts the attachment rows, so the two can't drift.
export async function markUploadsConsumed(
  tx: Pick<typeof db, 'update'>,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return
  await tx
    .update(uploads)
    .set({ status: 'consumed', consumedAt: new Date() })
    .where(inArray(uploads.id, ids))
}

export { mimeAllowed }
