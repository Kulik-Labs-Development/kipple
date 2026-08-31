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
    return db
      .select()
      .from(tickets)
      .where(filters.length > 0 ? and(...filters) : undefined)
      .orderBy(desc(tickets.updatedAt))
      .limit(200)
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
      }
    }
    await logAudit(session.user.id, 'ticket.create', 'ticket', updated.id, {
      clientId: updated.clientId,
      number: updated.number,
      subject: updated.subject,
    })
    return reply.code(201).send(updated)
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
    const [row] = await db
      .update(tickets)
      .set({
        clientId: parsed.data.clientId ?? undefined,
        subject: parsed.data.subject ?? undefined,
        status: parsed.data.status ?? undefined,
        priority: parsed.data.priority ?? undefined,
        assignedTo: parsed.data.assignedTo !== undefined ? parsed.data.assignedTo : undefined,
        tags: parsed.data.tags ?? undefined,
      })
      .where(eq(tickets.id, id))
      .returning()
    if (!row) return reply.code(404).send(notFound())
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
