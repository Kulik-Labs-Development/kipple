import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import {
  isS3Configured,
  s3DeleteObject,
  s3GetObject,
  s3HeadObject,
  s3PutObject,
} from './s3'

// Attachment storage (plan item 13, v1). Two backends share one surface:
// local disk sharded under STORAGE_DIR by the first two characters of the
// storage key (default) and the S3-compatible object store (when configured,
// see s3.ts). The storage key is always a server-generated id, so
// client-supplied filenames never touch the path or object key
// (traversal-safe by construction).

export const MAX_ATTACHMENTS_PER_UPDATE = 10

export class AttachmentSizeError extends Error {
  constructor(public readonly limitBytes: number) {
    super('attachment exceeds size limit')
    this.name = 'AttachmentSizeError'
  }

  get limitMb(): number {
    return Math.max(1, Math.round(this.limitBytes / (1024 * 1024)))
  }
}

// Resolved on every call so tests (and config reloads) can point it at a
// different directory without restarting.
export function storageDir(): string {
  return path.resolve(process.env.STORAGE_DIR || path.join(process.cwd(), 'storage'))
}

// Active backend, resolved on every call so tests (and config reloads) can
// flip it without restarting. 's3' only when all S3 env vars are set and
// valid — otherwise local disk (see s3Config()).
export function storageBackend(): 's3' | 'local' {
  return isS3Configured() ? 's3' : 'local'
}

// Per-file cap in MB; read fresh on every call (tests override the env).
export function maxAttachmentBytes(): number {
  const raw = process.env.ATTACHMENT_MAX_MB
  const mb = raw ? Number.parseInt(raw, 10) : 25
  if (!Number.isFinite(mb) || mb <= 0) return 25 * 1024 * 1024
  return mb * 1024 * 1024
}

export function attachmentPath(storageKey: string): string {
  const shard = storageKey.slice(0, 2)
  return path.join(storageDir(), shard, storageKey)
}

// Display-name sanitizer: control characters out, trimmed, capped at 255.
// The result is stored/displayed as-is; it is never used in a file path.
// eslint-disable-next-line no-control-regex -- the point is to strip control characters
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g

export function cleanFilename(raw: string): string {
  const cleaned = raw.replace(CONTROL_CHARS, '').trim().slice(0, 255)
  return cleaned || 'file'
}

// Stream `stream` to the sharded location for `storageKey`, counting bytes.
// Overflowing `maxBytes` or any I/O error removes the partial file and
// throws; the caller only sees the final size on success.
export async function writeAttachmentFile(
  storageKey: string,
  stream: Readable,
  maxBytes: number,
): Promise<number> {
  if (storageBackend() === 's3') {
    // Buffer with the same size count, then PUT: the S3 object is written
    // with a known Content-Length + payload hash, and overflow semantics are
    // identical — nothing is persisted when the cap is exceeded.
    const chunks: Buffer[] = []
    let bytes = 0
    for await (const chunk of stream) {
      bytes += (chunk as Buffer).length
      if (bytes > maxBytes) throw new AttachmentSizeError(maxBytes)
      chunks.push(chunk as Buffer)
    }
    await s3PutObject(storageKey, Buffer.concat(chunks))
    return bytes
  }
  const target = attachmentPath(storageKey)
  await mkdir(path.dirname(target), { recursive: true })
  let bytes = 0
  try {
    const handle = await open(target, 'w')
    for await (const chunk of stream) {
      bytes += (chunk as Buffer).length
      if (bytes > maxBytes) {
        await handle.close()
        throw new AttachmentSizeError(maxBytes)
      }
      await handle.write(chunk)
    }
    await handle.close()
  } catch (error) {
    await unlink(target).catch(() => undefined)
    throw error
  }
  return bytes
}

// Avatar cap in MB (user settings page), separate from the attachment cap.
export function maxAvatarBytes(): number {
  const raw = process.env.AVATAR_MAX_MB
  const mb = raw ? Number.parseInt(raw, 10) : 2
  if (!Number.isFinite(mb) || mb <= 0) return 2 * 1024 * 1024
  return mb * 1024 * 1024
}

// Client-logo cap in MB, separate from the attachment cap.
export function maxLogoBytes(): number {
  const raw = process.env.LOGO_MAX_MB
  const mb = raw ? Number.parseInt(raw, 10) : 2
  if (!Number.isFinite(mb) || mb <= 0) return 2 * 1024 * 1024
  return mb * 1024 * 1024
}

// Magic-sniff an image's content type from its bytes (avatars + client logos
// are served with this, never with a client-supplied or stored mime type).
// Returns null for anything that is not a recognized image.
export function sniffImageMime(bytes: Buffer): string | null {
  if (bytes.length > 8 && bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) {
    return 'image/png'
  }
  if (bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (
    bytes.length > 11 &&
    bytes.subarray(0, 4).equals(Buffer.from('RIFF')) &&
    bytes.subarray(8, 12).equals(Buffer.from('WEBP'))
  ) {
    return 'image/webp'
  }
  if (
    bytes.length > 6 &&
    (bytes.subarray(0, 6).equals(Buffer.from('GIF87a')) ||
      bytes.subarray(0, 6).equals(Buffer.from('GIF89a')))
  ) {
    return 'image/gif'
  }
  return null
}

export async function attachmentFileSize(storageKey: string): Promise<number | null> {
  if (storageBackend() === 's3') {
    const head = await s3HeadObject(storageKey)
    return head ? head.size : null
  }
  try {
    const info = await stat(attachmentPath(storageKey))
    return info.size
  } catch {
    return null
  }
}

export async function deleteAttachmentFile(storageKey: string): Promise<void> {
  if (storageBackend() === 's3') {
    await s3DeleteObject(storageKey).catch(() => undefined)
    return
  }
  await unlink(attachmentPath(storageKey)).catch(() => undefined)
}

// Serve a stored image with its content type magic-sniffed from the bytes
// (avatars, client logos). The file must exist — the caller 404s otherwise.
export async function streamImageFile(
  reply: { header: (name: string, value: string) => void; send: (body: Buffer) => unknown },
  storageKey: string,
): Promise<unknown> {
  let bytes: Buffer
  if (storageBackend() === 's3') {
    const found = await s3GetObject(storageKey)
    if (!found) throw new Error(`s3 object not found: ${storageKey}`)
    bytes = found
  } else {
    bytes = await readFile(attachmentPath(storageKey))
  }
  const mime = sniffImageMime(bytes)
  if (mime) reply.header('content-type', mime)
  return reply.send(bytes)
}
