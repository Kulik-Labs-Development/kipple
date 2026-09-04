import { existsSync } from 'node:fs'
import path from 'node:path'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { toErrorBody } from '@kipple/shared'
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
    // Fastify rejects bodies of unregistered media types before the route
    // handler runs (e.g. a non-chunk content-type on a tus PATCH). Map that
    // to a proper 415 instead of a 500 — the routing of this error between
    // the default handler and this one varies with the app configuration
    // (present when the SPA static root is found, absent on a fresh
    // checkout), so both paths must yield the same client-visible status.
    if ((error as { code?: string } | null | undefined)?.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      return reply
        .code(415)
        .send({ error: 'unsupported_media_type', message: 'unsupported content-type for this endpoint' })
    }
    reply.code(500).send(toErrorBody(error))
  })

  return app
}
