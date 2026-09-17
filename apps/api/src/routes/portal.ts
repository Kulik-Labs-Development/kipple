import { randomBytes, randomUUID } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import { eq, ilike } from 'drizzle-orm'
import { emailDomainMatches, type ClientBranding } from '@kipple/shared'
import type { FastifyInstance } from 'fastify'
import { notFound } from '../access'
import { logAudit } from '../audit'
import { db } from '../db'
import { accounts, clients, contactClients, contacts, users } from '../db/schema'
import { attachmentFileSize, streamImageFile } from '../storage'
import { isLogoKey, normalizeBranding } from './clients'

// Pre-sign-in portal branding (the login screen). Resolution is by email:
// email -> contact -> primary client (the same contact_clients link /api/me
// uses, isPrimary first). The exposure is the client's own public login
// branding — never ticket or contact data. The logo serve route re-resolves
// the email on every request, so stored files are never addressable by path
// (the storage key is server-generated and never appears in the URL).

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

function validEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 254 && EMAIL_RE.test(value)
}

async function brandingForEmail(email: string): Promise<{
  name: string
  branding: ClientBranding | null
} | null> {
  const [user] = await db
    .select({ role: users.role, contactId: users.contactId })
    .from(users)
    .where(ilike(users.email, email))
  if (!user || user.role !== 'contact' || !user.contactId) return null
  const links = await db
    .select({ clientId: contactClients.clientId, isPrimary: contactClients.isPrimary })
    .from(contactClients)
    .where(eq(contactClients.contactId, user.contactId))
  const primary = links.find((link) => link.isPrimary) ?? links[0]
  if (!primary) return null
  const [client] = await db
    .select({ name: clients.name, branding: clients.branding })
    .from(clients)
    .where(eq(clients.id, primary.clientId))
  if (!client) return null
  return { name: client.name, branding: normalizeBranding(client.branding as ClientBranding | null) }
}

// Client self-registration (issue #33): the first client (deterministic id
// order) whose allowed email domains include the email's domain. A null or
// empty list means self-registration is off for that client, so an email
// matching no enabled client is never registered.
async function selfRegClientForEmail(email: string): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: clients.id, selfRegDomains: clients.selfRegDomains })
    .from(clients)
    .orderBy(clients.id)
  for (const row of rows) {
    if (row.selfRegDomains && emailDomainMatches(email, row.selfRegDomains)) return row
  }
  return null
}

export async function registerPortalRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/portal/branding', async (request, reply) => {
    const email = (request.body as { email?: unknown } | null)?.email
    if (!validEmail(email)) {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'a valid email is required' })
    }
    const hit = await brandingForEmail(email)
    // Self-registration affordance (issue #33): only when no account exists
    // yet AND the email's domain is on an enabled client's allowed list. A
    // known contact (hit) always has an account, so the flag is false there.
    // Reveals the client's self-reg config, never account state.
    let selfRegister = false
    if (!hit) {
      const [userRow] = await db
        .select({ id: users.id })
        .from(users)
        .where(ilike(users.email, email))
        .limit(1)
      if (!userRow) selfRegister = (await selfRegClientForEmail(email)) !== null
    }
    if (!hit) return { clientName: null, logoUrl: null, selfRegister }
    const logo = hit.branding?.logoUrl?.trim()
    const logoUrl =
      !logo || logo === ''
        ? null
        : isLogoKey(logo)
          ? `/api/portal/logo?email=${encodeURIComponent(email)}`
          : logo
    return { clientName: hit.name, logoUrl, selfRegister }
  })

  // Unauthenticated client self-registration (issue #33), gated by the
  // per-client allowed email domains (off by default). The response is
  // always {status:true}: whether anything happened is not observable from
  // the response, so the endpoint cannot be used to probe accounts or
  // clients. When an account IS created, the web client chains the normal
  // magic-link sign-in request - the only mail this flow sends, and it
  // goes through the existing contact gate in sendMagicLinkEmail.
  app.post('/api/portal/self-register', async (request, reply) => {
    const body = request.body as { email?: unknown; name?: unknown } | null
    const email = typeof body?.email === 'string' ? body.email.trim() : ''
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!validEmail(email) || name.length < 1 || name.length > 120) {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'a valid email and name are required' })
    }

    // Idempotent re-request: an existing account (any role) is never
    // duplicated. For existing contact accounts the chained magic-link
    // request still delivers a sign-in link.
    const [existingUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(ilike(users.email, email))
      .limit(1)
    if (existingUser) return { status: true }

    const client = await selfRegClientForEmail(email)
    if (!client) return { status: true }

    let [contact] = await db.select().from(contacts).where(ilike(contacts.email, email))
    if (contact) {
      const links = await db
        .select({ clientId: contactClients.clientId })
        .from(contactClients)
        .where(eq(contactClients.contactId, contact.id))
      // Never re-home or duplicate a staff-created contact: if it is not
      // linked to the matched client, an admin resolves it.
      if (!links.some((link) => link.clientId === client.id)) return { status: true }
    } else {
      const [created] = await db
        .insert(contacts)
        .values({ id: randomUUID(), name, email })
        .returning()
      contact = created
      await db
        .insert(contactClients)
        .values({ contactId: contact.id, clientId: client.id, isPrimary: true })
    }

    const userId = randomUUID()
    const password = randomBytes(24).toString('base64url')
    await db
      .insert(users)
      .values({
        id: userId,
        name,
        email: contact.email,
        role: 'contact',
        contactId: contact.id,
        // Verified by construction: an app-provisioned portal account (the
        // password is a random one nobody knows). An unverified account
        // would have better-auth revoke its sessions + credential account
        // on the next magic-link verify.
        emailVerified: true,
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
    await logAudit(null, 'contact.self_register', 'contact', contact.id, {
      clientId: client.id,
    })
    return { status: true }
  })

  app.get('/api/portal/logo', async (request, reply) => {
    const { email } = request.query as { email?: string }
    if (!validEmail(email)) {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'a valid email is required' })
    }
    const hit = await brandingForEmail(email)
    const logo = hit?.branding?.logoUrl?.trim()
    if (!hit || !logo || !isLogoKey(logo) || (await attachmentFileSize(logo)) === null) {
      return reply.code(404).send(notFound())
    }
    return streamImageFile(reply, logo)
  })
}
