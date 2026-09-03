import { randomUUID } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import { asc, eq, ne } from 'drizzle-orm'
import { UserClientPatch, UserCreate } from '@kipple/shared'
import type { FastifyInstance } from 'fastify'
import { badRequest, notFound, requireRole } from '../access'
import { logAudit } from '../audit'
import { db } from '../db'
import { accounts, clients, users } from '../db/schema'

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

  // Company settings (UI triage 09-02 item 15). The account is a standard
  // better-auth credential account (the same shape the setup wizard and the
  // tests create), so sign-in, 2FA and sessions all work unchanged. Role is
  // admin or agent only — superusers come from the setup wizard.
  app.post('/api/users', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const parsed = UserCreate.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    const name = parsed.data.name.trim()
    const email = parsed.data.email.trim().toLowerCase()
    const { password, role } = parsed.data
    const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, email))
    if (taken) {
      return reply.code(409).send({ error: 'conflict', message: 'that email is already in use' })
    }
    const id = randomUUID()
    await db.insert(users).values({ id, name, email, role })
    await db.insert(accounts).values({
      id: randomUUID(),
      providerId: 'credential',
      issuer: 'local:credential',
      accountId: id,
      userId: id,
      password: await hashPassword(password),
    })
    await logAudit(session.user.id, 'user.create', 'user', id, { name, email, role })
    return { id, name, email, role }
  })

  // Company settings (UI triage 09-02 item 15). Sessions, credential
  // accounts, 2FA and notifications cascade with the user; their tickets and
  // updates survive with the author/assignee unattributed (migration 0011:
  // ON DELETE SET NULL), and the audit trail keeps every action but loses
  // the actor (audit.actor_id is set null).
  app.delete('/api/users/:id', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const { id } = request.params as { id: string }
    if (id === session.user.id) {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'you cannot remove your own account' })
    }
    const [target] = await db
      .select({ id: users.id, name: users.name, email: users.email, role: users.role })
      .from(users)
      .where(eq(users.id, id))
    if (!target) return reply.code(404).send(notFound())
    if (target.role === 'contact') {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'contacts belong to clients via their portal accounts, not here' })
    }
    await db.delete(users).where(eq(users.id, id))
    await logAudit(session.user.id, 'user.delete', 'user', id, { name: target.name, email: target.email, role: target.role })
    return { id, deleted: true }
  })
}
