import { asc, eq, ne } from 'drizzle-orm'
import { UserClientPatch } from '@kipple/shared'
import type { FastifyInstance } from 'fastify'
import { badRequest, notFound, requireRole } from '../access'
import { logAudit } from '../audit'
import { db } from '../db'
import { clients, users } from '../db/schema'

export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/users', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    return db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        presence: users.presence,
        image: users.image,
        clientId: users.clientId,
        clientName: clients.name,
      })
      .from(users)
      .leftJoin(clients, eq(users.clientId, clients.id))
      .where(ne(users.role, 'contact'))
      .orderBy(asc(users.name))
  })

  // Staff-to-client association (UI triage 09-02 item 11). Superuser-only:
  // managing who belongs to which client is company management. Association
  // only — staff client RESTRICTION is a separate row and stays untouched.
  app.patch('/api/users/:id', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const { id } = request.params as { id: string }
    const parsed = UserClientPatch.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    const [target] = await db
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(eq(users.id, id))
    if (!target) return reply.code(404).send(notFound())
    if (target.role === 'contact') {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'contacts belong to clients via their portal accounts, not here' })
    }
    if (parsed.data.clientId != null) {
      const [client] = await db
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.id, parsed.data.clientId))
      if (!client) return reply.code(404).send(notFound())
    }
    await db.update(users).set({ clientId: parsed.data.clientId }).where(eq(users.id, id))
    await logAudit(session.user.id, 'user.client', 'user', id, { clientId: parsed.data.clientId })
    return { id, clientId: parsed.data.clientId }
  })
}
