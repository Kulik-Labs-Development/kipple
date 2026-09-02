import { eq, ilike } from 'drizzle-orm'
import type { ClientBranding } from '@kipple/shared'
import type { FastifyInstance } from 'fastify'
import { notFound } from '../access'
import { db } from '../db'
import { clients, contactClients, users } from '../db/schema'
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

export async function registerPortalRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/portal/branding', async (request, reply) => {
    const email = (request.body as { email?: unknown } | null)?.email
    if (!validEmail(email)) {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'a valid email is required' })
    }
    const hit = await brandingForEmail(email)
    if (!hit) return { clientName: null, logoUrl: null }
    const logo = hit.branding?.logoUrl?.trim()
    const logoUrl =
      !logo || logo === ''
        ? null
        : isLogoKey(logo)
          ? `/api/portal/logo?email=${encodeURIComponent(email)}`
          : logo
    return { clientName: hit.name, logoUrl }
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
