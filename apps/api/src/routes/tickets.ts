import { randomUUID } from 'node:crypto'
import { and, desc, eq, ilike, inArray, ne } from 'drizzle-orm'
import { TicketCreate, TicketUpdate, UpdateCreate } from '@kipple/shared'
import { ticketAliasAddress } from '@kipple/mail'
import type { FastifyInstance } from 'fastify'
import {
  badRequest,
  clientScope,
  inScope,
  notFound,
  requireRole,
  requireUser,
} from '../access'
import { logAudit } from '../audit'
import { db } from '../db'
import { clients, tickets, updates, users } from '../db/schema'
import { loadEmailSettings, queueTicketReply } from '../mail'
import {
  applySlaToTicket,
  loadSlaEnabled,
  markTicketResponded,
  markTicketResolved,
} from '../sla'

// SLA internals are staff data; portal views never leak due times/states.
type SlaFields = Pick<
  typeof tickets.$inferSelect,
  | 'slaPolicyId'
  | 'slaResponseDueAt'
  | 'slaResolveDueAt'
  | 'slaResponseAt'
  | 'slaResolvedAt'
  | 'slaResponseState'
  | 'slaResolveState'
>

function ticketView<T extends SlaFields>(ticket: T, role: string) {
  if (role !== 'contact') return ticket
  const {
    slaPolicyId: _slaPolicyId,
    slaResponseDueAt: _slaResponseDueAt,
    slaResolveDueAt: _slaResolveDueAt,
    slaResponseAt: _slaResponseAt,
    slaResolvedAt: _slaResolvedAt,
    slaResponseState: _slaResponseState,
    slaResolveState: _slaResolveState,
    ...visible
  } = ticket
  return visible
}

async function emailDomain(): Promise<string> {
  return (await loadEmailSettings())?.domain ?? 'kipple.local'
}

async function loadTicket(id: string, role: string) {
  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, id))
  if (!ticket) return null
  const updateFilter =
    role === 'contact' ? and(eq(updates.ticketId, id), eq(updates.kind, 'public')) : eq(updates.ticketId, id)
  const ticketUpdates = await db
    .select({
      id: updates.id,
      ticketId: updates.ticketId,
      authorId: updates.authorId,
      authorName: users.name,
      kind: updates.kind,
      body: updates.body,
      createdAt: updates.createdAt,
    })
    .from(updates)
    .leftJoin(users, eq(updates.authorId, users.id))
    .where(updateFilter)
    .orderBy(updates.createdAt)
  const [client] = await db
    .select({ name: clients.name })
    .from(clients)
    .where(eq(clients.id, ticket.clientId))
  let assignedName: string | null = null
  if (ticket.assignedTo) {
    const [assignee] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, ticket.assignedTo))
    assignedName = assignee?.name ?? null
  }
  return { ...ticket, clientName: client?.name ?? null, assignedName, updates: ticketUpdates }
}

export async function registerTicketRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/tickets', async (request, reply) => {
    const session = await requireUser(request, reply)
    if (!session) return null
    const scope = await clientScope(session.user)
    if (scope.kind === 'clients' && scope.ids.length === 0) return []
    const { status, priority, clientId, assignedTo, q } = request.query as Record<
      string,
      string | undefined
    >
    const filters = []
    if (scope.kind === 'clients') filters.push(inArray(tickets.clientId, scope.ids))
    if (session.user.role === 'contact') filters.push(ne(tickets.status, 'deleted'))
    if (status) filters.push(eq(tickets.status, status))
    if (priority) filters.push(eq(tickets.priority, priority))
    if (clientId) filters.push(eq(tickets.clientId, clientId))
    if (assignedTo) filters.push(eq(tickets.assignedTo, assignedTo))
    if (q) filters.push(ilike(tickets.subject, `%${q}%`))
    const rows = await db
      .select()
      .from(tickets)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(tickets.updatedAt))
      .limit(200)
    return rows.map((row) => ticketView(row, session.user.role))
  })

  app.post('/api/tickets', async (request, reply) => {
    const session = await requireUser(request, reply)
    if (!session) return null
    const parsed = TicketCreate.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    const scope = await clientScope(session.user)
    if (!inScope(scope, parsed.data.clientId)) {
      return reply.code(404).send(notFound())
    }
    const [ticket] = await db
      .insert(tickets)
      .values({
        id: randomUUID(),
        clientId: parsed.data.clientId,
        subject: parsed.data.subject,
        priority: parsed.data.priority,
        assignedTo: parsed.data.assignedTo ?? null,
        tags: parsed.data.tags,
        createdBy: session.user.id,
      })
      .returning()
    const alias = ticketAliasAddress(ticket.number, await emailDomain())
    const [updated] = await db
      .update(tickets)
      .set({ alias })
      .where(eq(tickets.id, ticket.id))
      .returning()
    if (await loadSlaEnabled()) await applySlaToTicket(updated.id, new Date(), session.user.id)
    if (parsed.data.body) {
      await db.insert(updates).values({
        id: randomUUID(),
        ticketId: updated.id,
        authorId: session.user.id,
        kind: 'public',
        body: parsed.data.body,
      })
      if (session.user.role !== 'contact') {
        await queueTicketReply({ ticket: updated, body: parsed.data.body, isReply: false })
        await markTicketResponded(updated.id, new Date(), session.user.id)
      }
    }
    // re-read: the SLA steps above updated the row after the insert
    const [created] = await db.select().from(tickets).where(eq(tickets.id, updated.id))
    await logAudit(session.user.id, 'ticket.create', 'ticket', updated.id, {
      clientId: updated.clientId,
      number: updated.number,
      subject: updated.subject,
    })
    return reply.code(201).send(ticketView(created, session.user.role))
  })

  app.get('/api/tickets/:id', async (request, reply) => {
    const session = await requireUser(request, reply)
    if (!session) return null
    const { id } = request.params as { id: string }
    const ticket = await loadTicket(id, session.user.role)
    if (!ticket) return reply.code(404).send(notFound())
    const scope = await clientScope(session.user)
    if (!inScope(scope, ticket.clientId)) return reply.code(404).send(notFound())
    if (session.user.role === 'contact' && ticket.status === 'deleted') {
      return reply.code(404).send(notFound())
    }
    if (session.user.role === 'contact') {
      return { ...ticketView(ticket, 'contact'), updates: ticket.updates }
    }
    return ticket
  })

  app.patch('/api/tickets/:id', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    const { id } = request.params as { id: string }
    const parsed = TicketUpdate.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    const scope = await clientScope(session.user)
    if (parsed.data.clientId && !inScope(scope, parsed.data.clientId)) {
      return reply.code(404).send(notFound())
    }
    const [existing] = await db.select().from(tickets).where(eq(tickets.id, id))
    const wasClosed = existing?.status === 'closed'
    const [patched] = await db
      .update(tickets)
      .set({
        clientId: parsed.data.clientId ?? undefined,
        slaPolicyId: parsed.data.slaPolicyId !== undefined ? parsed.data.slaPolicyId : undefined,
        subject: parsed.data.subject ?? undefined,
        status: parsed.data.status ?? undefined,
        priority: parsed.data.priority ?? undefined,
        assignedTo: parsed.data.assignedTo !== undefined ? parsed.data.assignedTo : undefined,
        tags: parsed.data.tags ?? undefined,
      })
      .where(eq(tickets.id, id))
      .returning()
    if (!patched) return reply.code(404).send(notFound())
    let row = patched
    const slaChanged =
      (await loadSlaEnabled()) &&
      (parsed.data.slaPolicyId !== undefined ||
        (parsed.data.priority !== undefined && parsed.data.priority !== existing?.priority))
    const slaTouched =
      (parsed.data.status === 'closed' && !wasClosed) ||
      (slaChanged && row.status !== 'closed' && row.status !== 'deleted')
    if (slaTouched) {
      if (parsed.data.status === 'closed' && !wasClosed) {
        await markTicketResolved(id, new Date(), session.user.id)
      }
      if (slaChanged && row.status !== 'closed' && row.status !== 'deleted') {
        await applySlaToTicket(id, new Date(), session.user.id)
      }
      // re-read: the SLA steps above updated the row after the patch
      const [fresh] = await db.select().from(tickets).where(eq(tickets.id, id))
      if (fresh) row = fresh
    }
    await logAudit(session.user.id, 'ticket.update', 'ticket', id, {
      fields: Object.keys(parsed.data),
    })
    return row
  })

  app.post('/api/tickets/:id/updates', async (request, reply) => {
    const session = await requireUser(request, reply)
    if (!session) return null
    const { id } = request.params as { id: string }
    const parsed = UpdateCreate.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, id))
    if (!ticket) return reply.code(404).send(notFound())
    const scope = await clientScope(session.user)
    if (!inScope(scope, ticket.clientId)) return reply.code(404).send(notFound())
    const kind = session.user.role === 'contact' ? 'public' : parsed.data.kind
    const [row] = await db
      .insert(updates)
      .values({
        id: randomUUID(),
        ticketId: id,
        authorId: session.user.id,
        kind,
        body: parsed.data.body,
      })
      .returning()
    if (kind === 'public' && session.user.role !== 'contact') {
      await queueTicketReply({ ticket, body: parsed.data.body, isReply: true })
      await markTicketResponded(id, new Date(), session.user.id)
    }
    await logAudit(session.user.id, 'update.create', 'update', row.id, {
      ticketId: id,
      kind,
    })
    return reply.code(201).send(row)
  })

  app.delete('/api/tickets/:id', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    const { id } = request.params as { id: string }
    const [row] = await db
      .update(tickets)
      .set({ status: 'deleted' })
      .where(eq(tickets.id, id))
      .returning()
    if (!row) return reply.code(404).send(notFound())
    await logAudit(session.user.id, 'ticket.delete', 'ticket', id)
    return reply.code(204).send()
  })
}
