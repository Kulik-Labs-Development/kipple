import { fromNodeHeaders } from 'better-auth/node'
import type { FastifyInstance } from 'fastify'
import { auth } from './auth'
import { db } from './db'
import { users } from './db/schema'

async function instanceHasUsers(): Promise<boolean> {
  const [row] = await db.select({ id: users.id }).from(users).limit(1)
  return row !== undefined
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    async handler(request, reply) {
      const url = new URL(request.url, `http://${request.headers.host ?? 'localhost'}`)

      // Public self-signup closes once the instance has any user (the
      // setup wizard creates the first one). Staff-provisioned accounts go
      // through the api directly, never through this endpoint.
      if (request.method === 'POST' && url.pathname === '/api/auth/sign-up/email') {
        if (await instanceHasUsers()) {
          return reply
            .code(403)
            .send({ error: 'forbidden', message: 'Signups are closed on this instance' })
        }
      }

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
