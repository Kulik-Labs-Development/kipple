import { eq } from 'drizzle-orm'
import { PreferencesPatch, SetupRequest, type ClientBranding } from '@kipple/shared'
import type { FastifyInstance } from 'fastify'
import { badRequest, requireUser } from './access'
import { auth } from './auth'
import { db } from './db'
import { clients, contactClients, settings, users } from './db/schema'
import { registerAttachmentRoutes } from './routes/attachments'
import { normalizeBranding, registerClientRoutes } from './routes/clients'
import { registerContactRoutes } from './routes/contacts'
import { registerDefaultRoutes } from './routes/defaults'
import { registerHoldRoutes } from './routes/holds'
import { registerEmailRoutes } from './routes/email'
import { registerEventRoutes } from './routes/events'
import { registerNotificationRoutes, registerPresenceRoutes } from './routes/notifications'
import { registerPortalRoutes } from './routes/portal'
import { registerProfileRoutes } from './routes/profile'
import { registerRuleRoutes } from './routes/rules'
import { registerSlaRoutes } from './routes/sla'
import { registerTicketRoutes } from './routes/tickets'
import { registerTimeRoutes } from './routes/time'
import { registerUserRoutes } from './routes/users'
import { seedDefaultTemplates } from './templates'

async function instanceSetupRequired(): Promise<boolean> {
  const [row] = await db.select({ id: users.id }).from(users).limit(1)
  return row === undefined
}

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/setup/status', async () => ({
    setupRequired: await instanceSetupRequired(),
  }))

  app.post('/api/setup', async (request, reply) => {
    const parsed = SetupRequest.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send(badRequest(parsed.error))
    }
    const { instanceName, ownerName, ownerEmail, password } = parsed.data

    if (!(await instanceSetupRequired())) {
      return reply
        .code(409)
        .send({ error: 'conflict', message: 'instance already set up' })
    }

    await db
      .insert(settings)
      .values({ key: 'instance', value: { name: instanceName } })
      .onConflictDoNothing()

    // default email templates, all disabled — nothing auto-sends until the
    // admin enables one (PLAN item 11)
    await seedDefaultTemplates()

    const { response, headers: responseHeaders } = await auth.api.signUpEmail({
      body: { name: ownerName, email: ownerEmail, password },
      context: { headers: new Headers() },
      returnHeaders: true,
    })

    await db.update(users).set({ role: 'superuser' }).where(eq(users.email, ownerEmail))

    for (const cookie of responseHeaders.getSetCookie()) {
      reply.header('set-cookie', cookie)
    }
    return reply.code(200).send({ user: response.user })
  })

  app.get('/api/me', async (request, reply) => {
    const session = await requireUser(request, reply)
    if (!session) return null
    const [prefs] = await db
      .select({ theme: users.theme, colorMode: users.colorMode, contactId: users.contactId })
      .from(users)
      .where(eq(users.id, session.user.id))
    const [themeSetting] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'theme'))
    const instanceTheme =
      ((themeSetting?.value as { id?: string } | null) ?? {}).id ?? 'slate'
    const [agentThemeSetting] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'agentTheme'))
    const agentDefaultTheme =
      ((agentThemeSetting?.value as { id?: string } | null) ?? {}).id ?? 'console'
    let primaryClient: {
      id: string
      name: string
      domain: string | null
      branding: ClientBranding | null
    } | null = null
    if (session.user.role === 'contact' && prefs?.contactId) {
      const links = await db
        .select({ clientId: contactClients.clientId, isPrimary: contactClients.isPrimary })
        .from(contactClients)
        .where(eq(contactClients.contactId, prefs.contactId))
      const primary = links.find((link) => link.isPrimary) ?? links[0]
      if (primary) {
        const [client] = await db
          .select()
          .from(clients)
          .where(eq(clients.id, primary.clientId))
        if (client) {
          primaryClient = {
            id: client.id,
            name: client.name,
            domain: client.domain,
            // the contact's own primary client only — no cross-client data
            branding: normalizeBranding(client.branding as ClientBranding | null),
          }
        }
      }
    }
    return {
      user: session.user,
      sessionId: session.session.id,
      instanceTheme,
      agentDefaultTheme,
      contactId: prefs?.contactId ?? null,
      primaryClient,
      preferences: {
        theme: prefs?.theme ?? null,
        colorMode: prefs?.colorMode ?? 'system',
      },
    }
  })

  app.patch('/api/preferences', async (request, reply) => {
    const session = await requireUser(request, reply)
    if (!session) return null
    const parsed = PreferencesPatch.safeParse(request.body ?? {})
    if (!parsed.success) {
      return reply.code(400).send(badRequest(parsed.error))
    }
    const patch: { theme?: string | null; colorMode?: string } = {}
    if (parsed.data.theme !== undefined) patch.theme = parsed.data.theme
    if (parsed.data.colorMode !== undefined) patch.colorMode = parsed.data.colorMode
    await db.update(users).set(patch).where(eq(users.id, session.user.id))
    const [row] = await db
      .select({ theme: users.theme, colorMode: users.colorMode })
      .from(users)
      .where(eq(users.id, session.user.id))
    return { theme: row?.theme ?? null, colorMode: row?.colorMode ?? 'system' }
  })

  await registerAttachmentRoutes(app)
  await registerClientRoutes(app)
  await registerContactRoutes(app)
  await registerDefaultRoutes(app)
  await registerHoldRoutes(app)
  await registerEmailRoutes(app)
  await registerEventRoutes(app)
  await registerNotificationRoutes(app)
  await registerPresenceRoutes(app)
  await registerPortalRoutes(app)
  await registerProfileRoutes(app)
  await registerRuleRoutes(app)
  await registerSlaRoutes(app)
  await registerTicketRoutes(app)
  await registerTimeRoutes(app)
  await registerUserRoutes(app)
}
