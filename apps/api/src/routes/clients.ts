import { randomUUID } from 'node:crypto'
import { eq, inArray, sql } from 'drizzle-orm'
import { ClientCreate, ClientUpdate } from '@kipple/shared'
import type { FastifyInstance } from 'fastify'
import { badRequest, clientScope, inScope, notFound, requireRole, requireUser } from '../access'
import { logAudit } from '../audit'
import { db } from '../db'
import { clients, tickets } from '../db/schema'

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
    const [row] = await db
      .insert(clients)
      .values({ id: randomUUID(), name: parsed.data.name, domain: parsed.data.domain || null })
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
    const [row] = await db
      .update(clients)
      .set({
        name: parsed.data.name ?? undefined,
        domain: parsed.data.domain !== undefined ? parsed.data.domain || null : undefined,
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
