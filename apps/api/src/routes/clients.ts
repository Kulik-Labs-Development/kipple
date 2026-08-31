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
    await logAudit(session.user.id, 'client.delete', 'client', id)
    return reply.code(204).send()
  })
}
