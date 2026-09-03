import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { notFound, requireRole, requireUser } from '../access'
import { logAudit } from '../audit'
import { db } from '../db'
import { settings, users } from '../db/schema'
import {
  AttachmentSizeError,
  attachmentFileSize,
  deleteAttachmentFile,
  maxAvatarBytes,
  streamImageFile,
  writeAttachmentFile,
} from '../storage'

// User settings page (UI triage 09-02 item 6): self-service profile edits
// (name/email/phone/address/office), avatar upload (one file per user; the
// users table stores the storage key only — the content type is magic-sniffed
// on the way out), and /api/users/:id/avatar for staff lists. Password
// changes go through better-auth's own /api/auth/change-password route.
const AVATAR_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

function avatarKey(userId: string): string {
  return `avatar-${userId}`
}

async function loadProfile(userId: string) {
  const [row] = await db
    .select({
      name: users.name,
      email: users.email,
      phone: users.phone,
      address: users.address,
      office: users.office,
      image: users.image,
    })
    .from(users)
    .where(eq(users.id, userId))
  return row ?? null
}

export async function registerProfileRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/me/profile', async (request, reply) => {
    const session = await requireUser(request, reply)
    if (!session) return null
    const body = (request.body ?? {}) as Record<string, unknown>
    const patch: {
      name?: string
      email?: string
      phone?: string | null
      address?: string | null
      office?: string | null
    } = {}
    if (typeof body.name === 'string') {
      const name = body.name.trim()
      if (!name || name.length > 120) {
        return reply.code(400).send({ error: 'bad_request', message: 'name must be 1-120 characters' })
      }
      patch.name = name
    }
    if (typeof body.email === 'string') {
      const email = body.email.trim().toLowerCase()
      if (!email || !email.includes('@') || email.length > 255) {
        return reply.code(400).send({ error: 'bad_request', message: 'email is invalid' })
      }
      const [taken] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, email))
      if (taken && taken.id !== session.user.id) {
        return reply.code(409).send({ error: 'conflict', message: 'that email is already in use' })
      }
      patch.email = email
    }
    for (const field of ['phone', 'address', 'office'] as const) {
      const value = body[field]
      if (value === null) {
        patch[field] = null
      } else if (typeof value === 'string') {
        const trimmed = value.trim()
        const max = field === 'phone' ? 50 : 300
        if (trimmed.length > max) {
          return reply.code(400).send({ error: 'bad_request', message: `${field} is too long (max ${max})` })
        }
        patch[field] = trimmed
      }
    }
    if (Object.keys(patch).length === 0) {
      return reply.code(400).send({ error: 'bad_request', message: 'provide at least one field' })
    }
    await db.update(users).set(patch).where(eq(users.id, session.user.id))
    await logAudit(session.user.id, 'profile.update', 'user', session.user.id, {
      fields: Object.keys(patch),
    })
    return { profile: await loadProfile(session.user.id) }
  })

  // Self-service magic-link login for staff (issue #98): off by default,
  // per-account opt-in. Contacts never toggle this (their portal flow always
  // sends), and org-wide SSO hides the toggle + 400s it.
  app.post('/api/me/magic-link', async (request, reply) => {
    const session = await requireUser(request, reply)
    if (!session) return null
    const body = (request.body ?? {}) as Record<string, unknown>
    if (typeof body.enabled !== 'boolean') {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'enabled must be a boolean' })
    }
    if (session.user.role === 'contact') {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'magic-link self-service is for staff accounts' })
    }
    const [ssoRow] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'sso'))
    if (((ssoRow?.value as { enabled?: boolean } | null) ?? {}).enabled === true) {
      return reply
        .code(400)
        .send({
          error: 'bad_request',
          message: 'SSO is enabled for this instance — magic-link login is unavailable',
        })
    }
    await db
      .update(users)
      .set({ magicLinkEnabled: body.enabled })
      .where(eq(users.id, session.user.id))
    await logAudit(session.user.id, 'auth.magic_link', 'user', session.user.id, {
      enabled: body.enabled,
    })
    return { enabled: body.enabled }
  })

  app.post('/api/me/avatar', async (request, reply) => {
    const session = await requireUser(request, reply)
    if (!session) return null
    if (!request.isMultipart()) {
      return reply.code(415).send({ error: 'bad_request', message: 'expected a multipart image file' })
    }
    const storageKey = avatarKey(session.user.id)
    try {
      for await (const part of request.parts()) {
        if (part.type !== 'file' || part.fieldname !== 'file') {
          if (part.type === 'file') part.file.destroy()
          continue
        }
        if (!AVATAR_MIME_TYPES.has((part.mimetype || '').toLowerCase())) {
          part.file.destroy()
          return reply
            .code(415)
            .send({ error: 'bad_request', message: 'the avatar must be a png, jpeg, webp, or gif image' })
        }
        await writeAttachmentFile(storageKey, part.file, maxAvatarBytes())
        break
      }
    } catch (error) {
      await deleteAttachmentFile(storageKey)
      if (error instanceof AttachmentSizeError) {
        return reply
          .code(413)
          .send({ error: 'file_too_large', message: 'avatar exceeds the size limit' })
      }
      throw error
    }
    await db.update(users).set({ image: storageKey }).where(eq(users.id, session.user.id))
    await logAudit(session.user.id, 'profile.avatar', 'user', session.user.id, { storageKey })
    return { image: storageKey }
  })

  app.delete('/api/me/avatar', async (request, reply) => {
    const session = await requireUser(request, reply)
    if (!session) return null
    const [row] = await db
      .select({ image: users.image })
      .from(users)
      .where(eq(users.id, session.user.id))
    if (!row?.image) return { image: null }
    await deleteAttachmentFile(row.image)
    await db.update(users).set({ image: null }).where(eq(users.id, session.user.id))
    await logAudit(session.user.id, 'profile.avatar', 'user', session.user.id, { storageKey: null })
    return { image: null }
  })

  app.get('/api/me/avatar', async (request, reply) => {
    const session = await requireUser(request, reply)
    if (!session) return null
    const [row] = await db
      .select({ image: users.image })
      .from(users)
      .where(eq(users.id, session.user.id))
    if (!row?.image || (await attachmentFileSize(row.image)) === null) {
      return reply.code(404).send(notFound())
    }
    return streamImageFile(reply, row.image)
  })

  app.get('/api/users/:id/avatar', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    const { id } = request.params as { id: string }
    const [row] = await db.select({ image: users.image }).from(users).where(eq(users.id, id))
    if (!row?.image || (await attachmentFileSize(row.image)) === null) {
      return reply.code(404).send(notFound())
    }
    return streamImageFile(reply, row.image)
  })
}
