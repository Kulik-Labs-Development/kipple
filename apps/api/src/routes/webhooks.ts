import type { FastifyInstance } from 'fastify'
import { WebhookCreate, WebhookUpdate } from '@kipple/shared'
import { badRequest, notFound, requireRole } from '../access'
import {
  createWebhook,
  deleteWebhook,
  listDeliveries,
  listWebhooks,
  retryDelivery,
  testWebhook,
  updateWebhook,
} from '../webhooks'

// Webhooks are instance-scoped (AGENTS data-isolation rules): staff surfaces
// only. The payload never leaves the API — the delivery list returns a
// preview.
const STAFF = ['superuser', 'admin', 'agent']

export async function registerWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/webhooks', async (request, reply) => {
    const session = await requireRole(request, reply, STAFF)
    if (!session) return null
    return listWebhooks()
  })

  app.post('/api/webhooks', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const parsed = WebhookCreate.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    return reply.code(201).send(await createWebhook(parsed.data, session.user.id))
  })

  app.patch('/api/webhooks/:id', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const { id } = request.params as { id: string }
    const parsed = WebhookUpdate.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    const row = await updateWebhook(id, parsed.data, session.user.id)
    if (!row) return reply.code(404).send(notFound())
    return row
  })

  app.delete('/api/webhooks/:id', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const { id } = request.params as { id: string }
    const ok = await deleteWebhook(id, session.user.id)
    if (!ok) return reply.code(404).send(notFound())
    return reply.code(204).send()
  })

  app.post('/api/webhooks/:id/test', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const { id } = request.params as { id: string }
    const deliveryId = await testWebhook(id, session.user.id)
    if (!deliveryId) return reply.code(404).send(notFound())
    return reply.code(202).send({ id: deliveryId, status: 'queued' })
  })

  app.get('/api/webhooks/deliveries', async (request, reply) => {
    const session = await requireRole(request, reply, STAFF)
    if (!session) return null
    const query = request.query as Record<string, string | undefined>
    const limit = Math.min(Number(query.limit) || 100, 500)
    return listDeliveries({
      webhookId: query.webhookId,
      status: query.status,
      limit,
    })
  })

  app.post('/api/webhooks/deliveries/:id/retry', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const { id } = request.params as { id: string }
    const row = await retryDelivery(id, session.user.id)
    if (!row) return reply.code(404).send(notFound())
    return row
  })
}
