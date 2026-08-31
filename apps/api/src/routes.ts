import { eq } from 'drizzle-orm'
import { PreferencesPatch, SetupRequest } from '@kipple/shared'
import type { FastifyInstance } from 'fastify'
import { badRequest, requireUser } from './access'
import { auth } from './auth'
import { db } from './db'
import { settings, users } from './db/schema'
import { registerClientRoutes } from './routes/clients'
import { registerContactRoutes } from './routes/contacts'
import { registerEmailRoutes } from './routes/email'
import { registerTicketRoutes } from './routes/tickets'
import { registerUserRoutes } from './routes/users'

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
    return {
      user: session.user,
      sessionId: session.session.id,
      instanceTheme,
      contactId: prefs?.contactId ?? null,
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

  await registerClientRoutes(app)
  await registerContactRoutes(app)
  await registerEmailRoutes(app)
  await registerTicketRoutes(app)
  await registerUserRoutes(app)
}
