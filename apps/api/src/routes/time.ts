import { randomUUID } from 'node:crypto'
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte } from 'drizzle-orm'
import { TimeEntryManual, TimeEntryStart, TimeEntryUpdate } from '@kipple/shared'
import type { FastifyInstance } from 'fastify'
import {
  badRequest,
  clientScope,
  inScope,
  notFound,
  requireRole,
  type SessionUser,
} from '../access'
import { logAudit } from '../audit'
import { db } from '../db'
import { tickets, timeEntries, users } from '../db/schema'

async function ticketInScope(ticketId: string, scope: Awaited<ReturnType<typeof clientScope>>) {
  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId))
  if (!ticket) return null
  if (!inScope(scope, ticket.clientId)) return null
  return ticket
}

function toView(row: typeof timeEntries.$inferSelect, agentName: string | null) {
  return {
    id: row.id,
    ticketId: row.ticketId,
    agentId: row.agentId,
    agentName,
    clientId: row.clientId,
    startedAt: row.startedAt,
    durationS: row.durationS,
    billable: row.billable,
    note: row.note,
  }
}

async function agentName(agentId: string): Promise<string | null> {
  const [agent] = await db.select({ name: users.name }).from(users).where(eq(users.id, agentId))
  return agent?.name ?? null
}

export async function registerTimeRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/time/start', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    const parsed = TimeEntryStart.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    const me: SessionUser = session.user
    const scope = await clientScope(me)
    const ticket = await ticketInScope(parsed.data.ticketId, scope)
    if (!ticket) return reply.code(404).send(notFound())

    const [running] = await db
      .select()
      .from(timeEntries)
      .where(and(eq(timeEntries.agentId, me.id), isNull(timeEntries.durationS)))
    if (running) {
      return reply
        .code(409)
        .send({
          error: 'conflict',
          message: 'a timer is already running',
          entry: toView(running, me.name),
        })
    }

    const [entry] = await db
      .insert(timeEntries)
      .values({
        id: randomUUID(),
        ticketId: ticket.id,
        agentId: me.id,
        clientId: ticket.clientId,
        startedAt: new Date(),
        durationS: null,
        billable: parsed.data.billable,
        note: parsed.data.note,
      })
      .returning()
    await logAudit(me.id, 'time.start', 'time_entry', entry.id, {
      ticketId: ticket.id,
      billable: parsed.data.billable,
    })
    return reply.code(201).send(toView(entry, me.name))
  })

  app.post('/api/time/stop', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    const me: SessionUser = session.user
    const [running] = await db
      .select()
      .from(timeEntries)
      .where(and(eq(timeEntries.agentId, me.id), isNull(timeEntries.durationS)))
    if (!running) {
      return reply
        .code(409)
        .send({ error: 'conflict', message: 'no running timer to stop' })
    }
    const durationS = Math.max(
      1,
      Math.round((Date.now() - running.startedAt.getTime()) / 1000),
    )
    const [stopped] = await db
      .update(timeEntries)
      .set({ durationS })
      .where(eq(timeEntries.id, running.id))
      .returning()
    await logAudit(me.id, 'time.stop', 'time_entry', stopped.id, {
      ticketId: stopped.ticketId,
      durationS,
    })
    return toView(stopped, me.name)
  })

  app.post('/api/time/entries', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    const parsed = TimeEntryManual.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    const me: SessionUser = session.user
    const scope = await clientScope(me)
    const ticket = await ticketInScope(parsed.data.ticketId, scope)
    if (!ticket) return reply.code(404).send(notFound())

    const [entry] = await db
      .insert(timeEntries)
      .values({
        id: randomUUID(),
        ticketId: ticket.id,
        agentId: me.id,
        clientId: ticket.clientId,
        startedAt: parsed.data.startedAt,
        durationS: parsed.data.durationS,
        billable: parsed.data.billable,
        note: parsed.data.note,
      })
      .returning()
    await logAudit(me.id, 'time.entry', 'time_entry', entry.id, {
      ticketId: ticket.id,
      durationS: parsed.data.durationS,
      billable: parsed.data.billable,
    })
    return reply.code(201).send(toView(entry, me.name))
  })

  app.get('/api/time', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent', 'contact'])
    if (!session) return null
    const me: SessionUser = session.user
    const scope = await clientScope(me)
    const query = request.query as Record<string, string | undefined>

    const filters = []
    if (scope.kind === 'clients') {
      if (scope.ids.length === 0) return []
      filters.push(inArray(timeEntries.clientId, scope.ids))
    }
    if (query.ticketId) filters.push(eq(timeEntries.ticketId, query.ticketId))
    if (query.clientId) filters.push(eq(timeEntries.clientId, query.clientId))
    if (query.agentId) filters.push(eq(timeEntries.agentId, query.agentId))
    if (query.running === 'true') filters.push(isNull(timeEntries.durationS))
    if (query.completed === 'true') filters.push(isNotNull(timeEntries.durationS))
    if (query.billable === 'true') filters.push(eq(timeEntries.billable, true))
    if (query.billable === 'false') filters.push(eq(timeEntries.billable, false))
    if (query.from) filters.push(gte(timeEntries.startedAt, new Date(query.from)))
    if (query.to) filters.push(lte(timeEntries.startedAt, new Date(query.to)))

    const rows = await db
      .select()
      .from(timeEntries)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(timeEntries.startedAt))
      .limit(500)
    const names = new Map<string, string | null>()
    for (const row of rows) {
      if (!names.has(row.agentId)) names.set(row.agentId, await agentName(row.agentId))
    }
    return rows.map((row) => toView(row, names.get(row.agentId) ?? null))
  })

  app.get('/api/time/active', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    const me: SessionUser = session.user
    const [running] = await db
      .select()
      .from(timeEntries)
      .where(and(eq(timeEntries.agentId, me.id), isNull(timeEntries.durationS)))
    if (!running) return { entry: null }
    return { entry: toView(running, me.name) }
  })

  app.patch('/api/time/:id', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    const { id } = request.params as { id: string }
    const parsed = TimeEntryUpdate.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    const me: SessionUser = session.user
    const scope = await clientScope(me)

    const [existing] = await db.select().from(timeEntries).where(eq(timeEntries.id, id))
    if (!existing) return reply.code(404).send(notFound())
    if (!inScope(scope, existing.clientId)) return reply.code(404).send(notFound())

    const patch: Partial<typeof timeEntries.$inferInsert> = {}
    if (parsed.data.startedAt) patch.startedAt = parsed.data.startedAt
    if (parsed.data.durationS !== undefined) patch.durationS = parsed.data.durationS
    if (parsed.data.billable !== undefined) patch.billable = parsed.data.billable
    if (parsed.data.note !== undefined) patch.note = parsed.data.note
    const [row] = await db
      .update(timeEntries)
      .set(patch)
      .where(eq(timeEntries.id, id))
      .returning()
    await logAudit(me.id, 'time.update', 'time_entry', id, {
      fields: Object.keys(parsed.data),
    })
    return toView(row, me.name)
  })

  app.delete('/api/time/:id', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    const { id } = request.params as { id: string }
    const me: SessionUser = session.user
    const scope = await clientScope(me)
    const [existing] = await db.select().from(timeEntries).where(eq(timeEntries.id, id))
    if (!existing) return reply.code(404).send(notFound())
    if (!inScope(scope, existing.clientId)) return reply.code(404).send(notFound())
    const [row] = await db.delete(timeEntries).where(eq(timeEntries.id, id)).returning()
    if (!row) return reply.code(404).send(notFound())
    await logAudit(me.id, 'time.delete', 'time_entry', id, { ticketId: row.ticketId })
    return reply.code(204).send()
  })
}
