import { mkdir, open, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'

// Local-disk attachment storage (plan item 13, v1). Files are sharded under
// STORAGE_DIR by the first two characters of the storage key; the storage key
// is always a server-generated id, so client-supplied filenames never touch
// the path (traversal-safe by construction). A later backend (S3 adapter,
// chunked/tus uploads) swaps in behind this same surface.

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
  try {
    const info = await stat(attachmentPath(storageKey))
    return info.size
  } catch {
    return null
  }
}

export async function deleteAttachmentFile(storageKey: string): Promise<void> {
  await unlink(attachmentPath(storageKey)).catch(() => undefined)
}

// Serve a stored image with its content type magic-sniffed from the bytes
// (avatars, client logos). The file must exist — the caller 404s otherwise.
export async function streamImageFile(
  reply: { header: (name: string, value: string) => void; send: (body: Buffer) => unknown },
  storageKey: string,
): Promise<unknown> {
  const { readFile } = await import('node:fs/promises')
  const bytes = await readFile(attachmentPath(storageKey))
  const mime = sniffImageMime(bytes)
  if (mime) reply.header('content-type', mime)
  return reply.send(bytes)
}
