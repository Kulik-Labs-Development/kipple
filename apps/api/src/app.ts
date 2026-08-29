import { existsSync } from 'node:fs'
import path from 'node:path'
import fastifyStatic from '@fastify/static'
import Fastify, { type FastifyInstance } from 'fastify'
import { toErrorBody } from '@kipple/shared'

function spaRoot(): string | null {
  const cwd = process.cwd()
  const candidates = [
    process.env.SPA_ROOT,
    path.resolve(cwd, 'public'),
    path.resolve(cwd, 'apps/web/dist'),
  ].filter((value): value is string => Boolean(value))
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false })

  app.get('/healthz', async () => ({ ok: true, service: 'api' }))

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
