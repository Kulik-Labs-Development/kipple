import { eq } from 'drizzle-orm'
import { fromNodeHeaders } from 'better-auth/node'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { PreferencesPatch, SetupRequest } from '@kipple/shared'
import { auth } from './auth'
import { db } from './db'
import { settings, users } from './db/schema'

export type SessionUser = {
  id: string
  name: string
  email: string
  emailVerified: boolean
  role: string
  presence: string
  authSource: string
}

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
      const issue = parsed.error.issues[0]
      return reply
        .code(400)
        .send({ error: 'bad_request', message: issue?.message ?? 'invalid body' })
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
      .select({ theme: users.theme, colorMode: users.colorMode })
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
      const issue = parsed.error.issues[0]
      return reply
        .code(400)
        .send({ error: 'bad_request', message: issue?.message ?? 'invalid body' })
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
}
