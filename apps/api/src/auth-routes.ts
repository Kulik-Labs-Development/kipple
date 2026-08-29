import { fromNodeHeaders } from 'better-auth/node'
import type { FastifyInstance } from 'fastify'
import { auth } from './auth'

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    async handler(request, reply) {
      const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`)
      const headers = fromNodeHeaders(request.headers)
      const req = new Request(url.toString(), {
        method: request.method,
        headers,
        ...(request.body ? { body: JSON.stringify(request.body) } : {}),
      })

      try {
        const response = await auth.handler(req)
        reply.status(response.status)
        response.headers.forEach((value, key) => reply.header(key, value))
        return reply.send(response.body ? await response.text() : null)
      } catch (error) {
        app.log.error({ err: error }, 'auth handler error')
        return reply.code(500).send({ error: 'internal', message: 'internal server error' })
      }
    },
  })
}
