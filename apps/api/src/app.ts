import { existsSync } from 'node:fs'
import path from 'node:path'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { toErrorBody } from '@kipple/shared'
import { and, eq } from 'drizzle-orm'
import { getSession } from './access'
import { db } from './db'
import { twoFactor, users } from './db/schema'
import { registerAuthRoutes } from './auth-routes'
import { registerApiRoutes } from './routes'

function spaRoot(): string | null {
  const cwd = process.cwd()
  const candidates = [
    process.env.SPA_ROOT,
    path.resolve(cwd, 'public'),
    path.resolve(cwd, 'apps/web/dist'),
    path.resolve(cwd, '../web/dist'),
  ].filter((value): value is string => Boolean(value))
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  app.get('/healthz', async () => ({ ok: true, service: 'api' }))

  // MFA on first login (issue #32): an invited staff account that has not
  // yet enrolled a TOTP device is locked to the two-factor setup endpoints
  // (+ /api/me, so the UI can render that screen). The flag is one-shot —
  // once a verified device exists the gate clears it, and disabling 2FA
  // later does not re-arm it ("MFA on first login", not a standing mandate).
  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return
    const session = await getSession(request)
    if (!session?.session) return
    if (session.user.role === 'contact') return
    if (!session.user.mfaRequired) return
    const [twoFactorRow] = await db
      .select({ id: twoFactor.id, verified: twoFactor.verified })
      .from(twoFactor)
      .where(eq(twoFactor.userId, session.user.id))
    if (twoFactorRow?.verified) {
      // self-heal: setup completed (possibly on another replica) — the flag
      // is one-shot and no longer gates anything. The no-op WHERE keeps this
      // a pure no-op once the column is already clear (the session payload
      // keeps the stale flag until the next sign-in).
      await db
        .update(users)
        .set({ mfaRequired: false })
        .where(and(eq(users.id, session.user.id), eq(users.mfaRequired, true)))
      return
    }
    const path = request.url.split('?')[0]
    // /api/me (the UI reads it to render this screen) and the two-factor
    // setup endpoints are reachable; everything else is gated.
    const pass =
      path === '/api/me' ||
      path === '/api/auth/two-factor/enable' ||
      path === '/api/auth/two-factor/verify-totp'
    if (pass) return
    return reply
      .code(403)
      .send({ error: 'mfa_required', message: 'set up two-factor authentication to continue' })
  })

  await registerAuthRoutes(app)
  // Multipart parsing for attachment uploads (plan item 13). The plugin's
  // own file cap is deliberately high — the limit that actually applies is
  // ATTACHMENT_MAX_MB, enforced byte-by-byte in storage.ts.
  await app.register(multipart, {
    limits: { fileSize: 512 * 1024 * 1024 },
  })
  await registerApiRoutes(app)

  const root = spaRoot()
  if (root) {
    await app.register(fastifyStatic, { root })
    app.setNotFoundHandler((req, reply) => {
      const wantsHtml = (req.headers.accept ?? '').includes('text/html')
      if (req.method === 'GET' && !req.url.startsWith('/api') && wantsHtml) {
        return reply.sendFile('index.html')
      }
      return reply.code(404).send({ error: 'not_found', message: 'not found' })
    })
  }

  app.setErrorHandler((error, _req, reply) => {
    reply.code(500).send(toErrorBody(error))
  })

  return app
}
