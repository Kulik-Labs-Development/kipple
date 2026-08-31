import { randomBytes, randomUUID } from 'node:crypto'
import { and, eq, inArray, ilike, ne } from 'drizzle-orm'
import { hashPassword } from 'better-auth/crypto'
import { ContactClientLink, ContactCreate, ContactUpdate } from '@kipple/shared'
import type { FastifyInstance } from 'fastify'
import { badRequest, clientScope, inScope, notFound, requireRole, requireUser } from '../access'
import { logAudit } from '../audit'
import { db } from '../db'
import { accounts, clients, contactClients, contacts, users } from '../db/schema'

async function clientExists(id: string): Promise<boolean> {
  const [row] = await db.select({ id: clients.id }).from(clients).where(eq(clients.id, id))
  return row !== undefined
}

export async function registerContactRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/clients/:clientId/contacts', async (request, reply) => {
    const session = await requireUser(request, reply)
    if (!session) return null
    const { clientId } = request.params as { clientId: string }
    const scope = await clientScope(session.user)
    if (!(await clientExists(clientId)) || !inScope(scope, clientId)) {
      return reply.code(404).send(notFound())
    }
    const links = await db
      .select({ contactId: contactClients.contactId })
      .from(contactClients)
      .where(eq(contactClients.clientId, clientId))
    if (links.length === 0) return []
    return db
      .select()
      .from(contacts)
      .where(inArray(contacts.id, links.map((link) => link.contactId)))
      .orderBy(contacts.name)
  })

  app.post('/api/clients/:clientId/contacts', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    const { clientId } = request.params as { clientId: string }
    const scope = await clientScope(session.user)
    if (!(await clientExists(clientId)) || !inScope(scope, clientId)) {
      return reply.code(404).send(notFound())
    }
    const parsed = ContactCreate.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    const [contact] = await db
      .insert(contacts)
      .values({
        id: randomUUID(),
        name: parsed.data.name,
        email: parsed.data.email,
        phone: parsed.data.phone || null,
      })
      .returning()
    await db
      .insert(contactClients)
      .values({ contactId: contact.id, clientId, isPrimary: true })
    await logAudit(session.user.id, 'contact.create', 'contact', contact.id, {
      clientId,
      name: contact.name,
    })
    return reply.code(201).send(contact)
  })

  app.get('/api/contacts/:id', async (request, reply) => {
    const session = await requireUser(request, reply)
    if (!session) return null
    const { id } = request.params as { id: string }
    const scope = await clientScope(session.user)
    const [contact] = await db.select().from(contacts).where(eq(contacts.id, id))
    if (!contact) return reply.code(404).send(notFound())
    const links = await db
      .select({ clientId: contactClients.clientId, isPrimary: contactClients.isPrimary })
      .from(contactClients)
      .where(eq(contactClients.contactId, id))
    const visible = links.filter((link) => inScope(scope, link.clientId))
    if (visible.length === 0) return reply.code(404).send(notFound())
    return { ...contact, clientLinks: visible }
  })

  app.patch('/api/contacts/:id', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    const { id } = request.params as { id: string }
    const parsed = ContactUpdate.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    const [row] = await db
      .update(contacts)
      .set({
        name: parsed.data.name ?? undefined,
        email: parsed.data.email ?? undefined,
        phone: parsed.data.phone !== undefined ? parsed.data.phone || null : undefined,
      })
      .where(eq(contacts.id, id))
      .returning()
    if (!row) return reply.code(404).send(notFound())
    await logAudit(session.user.id, 'contact.update', 'contact', id, {
      fields: Object.keys(parsed.data),
    })
    return row
  })

  app.post('/api/contacts/:id/clients', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    const { id } = request.params as { id: string }
    const scope = await clientScope(session.user)
    const parsed = ContactClientLink.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    const { clientId, isPrimary } = parsed.data
    const [contact] = await db.select({ id: contacts.id }).from(contacts).where(eq(contacts.id, id))
    if (!contact || !(await clientExists(clientId)) || !inScope(scope, clientId)) {
      return reply.code(404).send(notFound())
    }
    if (isPrimary) {
      await db
        .update(contactClients)
        .set({ isPrimary: false })
        .where(and(eq(contactClients.contactId, id), ne(contactClients.clientId, clientId)))
    }
    await db
      .insert(contactClients)
      .values({ contactId: id, clientId, isPrimary: Boolean(isPrimary) })
      .onConflictDoNothing()
    await logAudit(session.user.id, 'contact.link_client', 'contact', id, { clientId })
    return { ok: true }
  })

  // Give a contact a portal account (magic-link sign-in). The credential
  // account stores a random password so email+password sign-in can never
  // work; only the magic link does.
  app.post('/api/contacts/:id/portal', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    const { id } = request.params as { id: string }
    const scope = await clientScope(session.user)
    const [contact] = await db.select().from(contacts).where(eq(contacts.id, id))
    if (!contact) return reply.code(404).send(notFound())
    const links = await db
      .select({ clientId: contactClients.clientId })
      .from(contactClients)
      .where(eq(contactClients.contactId, id))
    if (!links.some((link) => inScope(scope, link.clientId))) {
      return reply.code(404).send(notFound())
    }
    const [existing] = await db.select().from(users).where(ilike(users.email, contact.email))
    if (existing) {
      if (existing.role === 'contact' && existing.contactId === contact.id) {
        return { userId: existing.id, email: existing.email, name: existing.name, existing: true }
      }
      return reply
        .code(409)
        .send({ error: 'conflict', message: 'a user with this email already exists' })
    }
    const userId = randomUUID()
    const password = randomBytes(24).toString('base64url')
    await db
      .insert(users)
      .values({
        id: userId,
        name: contact.name,
        email: contact.email,
        role: 'contact',
        contactId: contact.id,
      })
    await db
      .insert(accounts)
      .values({
        id: randomUUID(),
        providerId: 'credential',
        issuer: 'local:credential',
        accountId: userId,
        userId,
        password: await hashPassword(password),
      })
    await logAudit(session.user.id, 'contact.portal_provision', 'contact', contact.id, { userId })
    return reply
      .code(201)
      .send({ userId, email: contact.email, name: contact.name, existing: false })
  })

  app.delete('/api/contacts/:id/clients/:clientId', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    const { id, clientId } = request.params as { id: string; clientId: string }
    const scope = await clientScope(session.user)
    if (!inScope(scope, clientId)) return reply.code(404).send(notFound())
    const [row] = await db
      .delete(contactClients)
      .where(and(eq(contactClients.contactId, id), eq(contactClients.clientId, clientId)))
      .returning()
    if (!row) return reply.code(404).send(notFound())
    await logAudit(session.user.id, 'contact.unlink_client', 'contact', id, { clientId })
    return reply.code(204).send()
  })
}
