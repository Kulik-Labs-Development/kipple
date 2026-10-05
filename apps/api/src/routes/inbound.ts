import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { NMS_SOURCES, type NmsSource } from '@kipple/shared'
import { badRequest, notFound, requireRole } from '../access'
import {
  describeInboundWebhooks,
  enableInboundSource,
  handleVendorAlert,
  rotateInboundSource,
  setDefaultInboundClient,
} from '../inbound'
import { db } from '../db'
import { clients } from '../db/schema'

// The admin surface mirrors the outbound webhook RBAC: staff can read the
// inbound config, superusers write it. The vendor POST below is
// unauthenticated — the per-source secret riding the URL path is the
// credential (documented ceiling, docs/DEPLOYMENT.md).
const STAFF = ['superuser', 'admin', 'agent']

export async function registerInboundRoutes(app: FastifyInstance): Promise<void> {
  // Vendor endpoint, in its own context with a raw-body parser: the secret
  // check and the vendor parsers work on the RAW text (JSON or
  // form-encoded — UptimeRobot posts form params), so the body must survive
  // the middleware as a string. Encapsulation keeps this override local to
  // this one route; every other /api route keeps the default JSON parser.
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      ['application/json', 'application/x-www-form-urlencoded', 'text/plain'],
      { parseAs: 'string' },
      (request, body, done) => {
        const raw = typeof body === 'string' ? body : Buffer.from(body as Uint8Array).toString('utf8')
        void request
        done(null, raw)
      },
    )
    scope.post('/api/webhooks/inbound/:source/:secret', async (request, reply) => {
      const params = request.params as { source: string; secret: string }
      const rawBody = typeof request.body === 'string' ? request.body : ''
      const result = await handleVendorAlert(params.source, params.secret, rawBody)
      switch (result.kind) {
        case 'unknown_source':
          return reply.code(404).send(notFound())
        case 'unauthorized':
          // Deliberately generic: "source disabled" and "wrong secret" are
          // indistinguishable on purpose (no enablement oracle).
          return reply.code(401).send({ error: 'unauthorized', message: 'invalid credentials' })
        case 'bad_payload':
          return reply.code(400).send({ error: 'bad_request', message: 'unrecognized alert payload' })
        case 'no_default_client':
          return reply
            .code(409)
            .send({ error: 'conflict', message: 'no default client configured for inbound alerts' })
        default:
          return reply
            .code(200)
            .send({ status: result.status, ticketId: result.ticketId, number: result.number })
      }
    })
  })

  app.get('/api/webhooks/inbound', async (request, reply) => {
    const session = await requireRole(request, reply, STAFF)
    if (!session) return null
    return describeInboundWebhooks()
  })

  // POST /api/webhooks/inbound — set the default client: { clientId } or
  // { clientId: null }.
  app.post('/api/webhooks/inbound', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const body = (request.body ?? {}) as { clientId?: unknown }
    const clientId = body.clientId
    if (clientId !== undefined && clientId !== null && typeof clientId !== 'string') {
      return reply
        .code(400)
        .send(badRequest({ issues: [{ message: 'clientId must be a client id or null' }] }))
    }
    if (clientId !== undefined && clientId !== null) {
      const [client] = await db
        .select({ id: clients.id })
        .from(clients)
        .where(eq(clients.id, clientId))
      if (!client) return reply.code(404).send(notFound())
    }
    const updated = await setDefaultInboundClient(clientId ?? null, session.user.id)
    return { defaultClientId: updated.defaultClientId ?? null }
  })

  // POST /api/webhooks/inbound/:source — { enabled: boolean } or
  // { rotate: true }. Returns the source view (full URL when enabled).
  app.post('/api/webhooks/inbound/:source', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const params = request.params as { source: string }
    if (!NMS_SOURCES.includes(params.source as NmsSource)) {
      return reply.code(404).send(notFound())
    }
    const body = (request.body ?? {}) as { enabled?: unknown; rotate?: unknown }
    if (body.rotate === true) {
      const view = await rotateInboundSource(params.source, session.user.id)
      if (!view) return reply.code(404).send(notFound())
      return view
    }
    if (typeof body.enabled !== 'boolean') {
      return reply
        .code(400)
        .send(badRequest({ issues: [{ message: 'body must be { enabled: boolean } or { rotate: true }' }] }))
    }
    const view = await enableInboundSource(params.source, body.enabled, session.user.id)
    if (!view) return reply.code(404).send(notFound())
    return view
  })
}
