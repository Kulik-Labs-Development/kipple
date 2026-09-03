import { eq, inArray } from 'drizzle-orm'
import { fromNodeHeaders } from 'better-auth/node'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { auth } from './auth'
import { db } from './db'
import { clients, contactClients, tickets, users } from './db/schema'

export type SessionUser = {
  id: string
  name: string
  email: string
  emailVerified: boolean
  role: string
  presence: string
  authSource: string
}

export type ClientScope = { kind: 'all' } | { kind: 'clients'; ids: string[] }

export async function getSession(request: FastifyRequest) {
  return auth.api.getSession({ headers: fromNodeHeaders(request.headers) })
}

export async function requireUser(request: FastifyRequest, reply: FastifyReply) {
  const session = await getSession(request)
  if (!session) {
    reply.code(401).send({ error: 'unauthorized', message: 'not signed in' })
    return null
  }
  return session
}

export async function requireRole(
  request: FastifyRequest,
  reply: FastifyReply,
  roles: string[],
) {
  const session = await requireUser(request, reply)
  if (!session) return null
  if (!roles.includes(session.user.role)) {
    reply.code(403).send({ error: 'forbidden', message: 'insufficient role' })
    return null
  }
  return session
}

export async function clientScope(user: SessionUser): Promise<ClientScope> {
  // Superusers are unrestricted even when a client association is set —
  // they are the accounts that assign the associations (issue #31).
  if (user.role === 'superuser') return { kind: 'all' }
  const [row] = await db
    .select({ contactId: users.contactId, clientId: users.clientId })
    .from(users)
    .where(eq(users.id, user.id))
  if (user.role === 'contact') {
    if (!row?.contactId) return { kind: 'clients', ids: [] }
    const links = await db
      .select({ clientId: contactClients.clientId })
      .from(contactClients)
      .where(eq(contactClients.contactId, row.contactId))
    return { kind: 'clients', ids: links.map((link) => link.clientId) }
  }
  // Staff (admin/agent): restricted to their assigned client when one is
  // set, unrestricted by default (issue #31).
  return row?.clientId ? { kind: 'clients', ids: [row.clientId] } : { kind: 'all' }
}

export function inScope(scope: ClientScope, clientId: string): boolean {
  return scope.kind === 'all' || scope.ids.includes(clientId)
}

export function clientFilter(scope: ClientScope) {
  if (scope.kind === 'all') return undefined
  return inArray(clients.id, scope.ids)
}

export function ticketClientFilter(scope: ClientScope) {
  if (scope.kind === 'all') return undefined
  return inArray(tickets.clientId, scope.ids)
}

export type ValidationFailure = { issues: Array<{ message?: string }> }

export function badRequest(error: ValidationFailure): { error: string; message: string } {
  const issue = error.issues[0]
  return { error: 'bad_request', message: issue?.message ?? 'invalid body' }
}

export function notFound() {
  return { error: 'not_found', message: 'not found' }
}
