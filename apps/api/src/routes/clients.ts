import { randomUUID } from 'node:crypto'
import { eq, inArray, sql } from 'drizzle-orm'
import {
  ClientCreate,
  ClientUpdate,
  isPortalTheme,
  type ClientBranding,
} from '@kipple/shared'
import type { FastifyInstance } from 'fastify'
import { badRequest, clientScope, inScope, notFound, requireRole, requireUser } from '../access'
import { logAudit } from '../audit'
import { db } from '../db'
import { clients, tickets } from '../db/schema'
import {
  AttachmentSizeError,
  attachmentFileSize,
  deleteAttachmentFile,
  maxLogoBytes,
  streamImageFile,
  writeAttachmentFile,
} from '../storage'

export function normalizeBranding(
  branding: ClientBranding | null | undefined,
): ClientBranding | null {
  if (!branding) return null
  const out: ClientBranding = {}
  if (branding.themeId) out.themeId = branding.themeId
  if (branding.accent) out.accent = branding.accent
  if (branding.logoUrl) out.logoUrl = branding.logoUrl
  return Object.keys(out).length > 0 ? out : null
}

function brandingValidationError(
  branding: ClientBranding | null | undefined,
): string | null {
  if (branding?.themeId && !isPortalTheme(branding.themeId)) {
    return `branding.themeId must be a portal theme, got ${branding.themeId}`
  }
  return null
}

const LOGO_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

// Uploaded logos live in the sharded STORAGE_DIR under a server-generated
// key; branding.logoUrl holds that key (never a filename — traversal-safe).
// A full URL in branding.logoUrl stays external and untouched; the portal
// resolves key -> GET /api/clients/:id/logo, URL -> as-is.
function clientLogoKey(clientId: string): string {
  return `client-logo-${clientId}`
}

export function isLogoKey(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^client-logo-[a-z0-9-]{6,64}$/.test(value)
}

export async function registerClientRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/clients', async (request, reply) => {
    const session = await requireUser(request, reply)
    if (!session) return null
    const scope = await clientScope(session.user)
    if (scope.kind === 'clients' && scope.ids.length === 0) return []
    return db
      .select()
      .from(clients)
      .where(scope.kind === 'clients' ? inArray(clients.id, scope.ids) : undefined)
      .orderBy(clients.name)
  })

  app.post('/api/clients', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    const parsed = ClientCreate.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    const brandingError = brandingValidationError(parsed.data.branding)
    if (brandingError) {
      return reply.code(400).send({ error: 'bad_request', message: brandingError })
    }
    const [row] = await db
      .insert(clients)
      .values({
        id: randomUUID(),
        name: parsed.data.name,
        domain: parsed.data.domain || null,
        slaPolicyId: parsed.data.slaPolicyId ?? null,
        branding: normalizeBranding(parsed.data.branding),
      })
      .returning()
    await logAudit(session.user.id, 'client.create', 'client', row.id, { name: row.name })
    return reply.code(201).send(row)
  })

  app.get('/api/clients/:id', async (request, reply) => {
    const session = await requireUser(request, reply)
    if (!session) return null
    const { id } = request.params as { id: string }
    const scope = await clientScope(session.user)
    const [row] = await db.select().from(clients).where(eq(clients.id, id))
    if (!row || !inScope(scope, id)) {
      return reply.code(404).send(notFound())
    }
    return row
  })

  app.patch('/api/clients/:id', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    const { id } = request.params as { id: string }
    const parsed = ClientUpdate.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    const brandingError = brandingValidationError(parsed.data.branding)
    if (brandingError) {
      return reply.code(400).send({ error: 'bad_request', message: brandingError })
    }
    const [existing] = await db
      .select({ branding: clients.branding })
      .from(clients)
      .where(eq(clients.id, id))
    const [row] = await db
      .update(clients)
      .set({
        name: parsed.data.name ?? undefined,
        domain: parsed.data.domain !== undefined ? parsed.data.domain || null : undefined,
        slaPolicyId:
          parsed.data.slaPolicyId !== undefined ? parsed.data.slaPolicyId : undefined,
        branding:
          parsed.data.branding !== undefined ? normalizeBranding(parsed.data.branding) : undefined,
      })
      .where(eq(clients.id, id))
      .returning()
    if (!row) return reply.code(404).send(notFound())
    // File lifecycle: an uploaded logo (key-form logoUrl) that this patch
    // replaces or clears has its stored file removed too.
    const oldLogo = normalizeBranding(existing?.branding as ClientBranding | null)?.logoUrl
    if (
      oldLogo &&
      isLogoKey(oldLogo) &&
      parsed.data.branding !== undefined &&
      parsed.data.branding?.logoUrl !== oldLogo
    ) {
      await deleteAttachmentFile(oldLogo)
    }
    await logAudit(session.user.id, 'client.update', 'client', id, {
      fields: Object.keys(parsed.data),
    })
    return row
  })

  app.delete('/api/clients/:id', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin'])
    if (!session) return null
    const { id } = request.params as { id: string }
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(tickets)
      .where(eq(tickets.clientId, id))
    if (Number(count) > 0) {
      return reply
        .code(409)
        .send({ error: 'conflict', message: 'client still has tickets' })
    }
    const [row] = await db.delete(clients).where(eq(clients.id, id)).returning()
    if (!row) return reply.code(404).send(notFound())
    const oldLogo = normalizeBranding(row.branding as ClientBranding | null)?.logoUrl
    if (oldLogo && isLogoKey(oldLogo)) await deleteAttachmentFile(oldLogo)
    await logAudit(session.user.id, 'client.delete', 'client', id)
    return reply.code(204).send()
  })

  // Uploaded portal logos (UI triage 09-02 item 9). House multipart pattern
  // from the avatar/attachment routes: one file part named "file", the mime
  // allowlist checked on upload, the content type magic-sniffed on the way
  // out. branding.logoUrl holds the storage key (external URLs untouched).
  app.post('/api/clients/:id/logo', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    const { id } = request.params as { id: string }
    const scope = await clientScope(session.user)
    const [row] = await db
      .select({ id: clients.id, branding: clients.branding })
      .from(clients)
      .where(eq(clients.id, id))
    if (!row || !inScope(scope, id)) {
      return reply.code(404).send(notFound())
    }
    if (!request.isMultipart()) {
      return reply
        .code(415)
        .send({ error: 'bad_request', message: 'expected a multipart image file' })
    }
    const storageKey = clientLogoKey(id)
    let received = false
    try {
      for await (const part of request.parts()) {
        if (part.type !== 'file' || part.fieldname !== 'file') {
          if (part.type === 'file') part.file.destroy()
          continue
        }
        received = true
        if (!LOGO_MIME_TYPES.has((part.mimetype || '').toLowerCase())) {
          part.file.destroy()
          return reply
            .code(415)
            .send({
              error: 'bad_request',
              message: 'the logo must be a png, jpeg, webp, or gif image',
            })
        }
        await writeAttachmentFile(storageKey, part.file, maxLogoBytes())
        break
      }
    } catch (error) {
      await deleteAttachmentFile(storageKey)
      if (error instanceof AttachmentSizeError) {
        return reply
          .code(413)
          .send({ error: 'file_too_large', message: 'logo exceeds the size limit' })
      }
      throw error
    }
    if (!received) {
      await deleteAttachmentFile(storageKey)
      return reply
        .code(415)
        .send({ error: 'bad_request', message: 'expected a multipart image file' })
    }
    const branding: ClientBranding = {
      ...(normalizeBranding(row.branding as ClientBranding | null) ?? {}),
      logoUrl: storageKey,
    }
    await db.update(clients).set({ branding }).where(eq(clients.id, id))
    await logAudit(session.user.id, 'client.logo', 'client', id, { storageKey })
    return { logoUrl: storageKey }
  })

  app.get('/api/clients/:id/logo', async (request, reply) => {
    const session = await requireUser(request, reply)
    if (!session) return null
    const { id } = request.params as { id: string }
    const scope = await clientScope(session.user)
    const [row] = await db
      .select({ id: clients.id, branding: clients.branding })
      .from(clients)
      .where(eq(clients.id, id))
    const logo = normalizeBranding(row?.branding as ClientBranding | null)?.logoUrl
    if (
      !row ||
      !inScope(scope, id) ||
      !isLogoKey(logo) ||
      (await attachmentFileSize(logo)) === null
    ) {
      return reply.code(404).send(notFound())
    }
    return streamImageFile(reply, logo)
  })

  app.delete('/api/clients/:id/logo', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    const { id } = request.params as { id: string }
    const scope = await clientScope(session.user)
    const [row] = await db
      .select({ id: clients.id, branding: clients.branding })
      .from(clients)
      .where(eq(clients.id, id))
    if (!row || !inScope(scope, id)) {
      return reply.code(404).send(notFound())
    }
    const logo = normalizeBranding(row.branding as ClientBranding | null)?.logoUrl
    if (!logo) return { logoUrl: null }
    if (!isLogoKey(logo)) {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'no uploaded logo to remove' })
    }
    await deleteAttachmentFile(logo)
    const branding: ClientBranding = {
      ...(normalizeBranding(row.branding as ClientBranding | null) ?? {}),
    }
    delete branding.logoUrl
    await db
      .update(clients)
      .set({ branding: normalizeBranding(branding) })
      .where(eq(clients.id, id))
    await logAudit(session.user.id, 'client.logo', 'client', id, { storageKey: null })
    return { logoUrl: null }
  })
}
