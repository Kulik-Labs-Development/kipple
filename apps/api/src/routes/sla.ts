import {
  BusinessHours,
  SlaPolicyCreate,
  SlaPolicyUpdate,
  SlaSettings,
} from '@kipple/shared'
import type { FastifyInstance } from 'fastify'
import { badRequest, notFound, requireRole } from '../access'
import { logAudit } from '../audit'
import {
  createSlaPolicy,
  deleteSlaPolicy,
  listSlaPolicies,
  loadBusinessHours,
  loadSlaEnabled,
  saveBusinessHours,
  saveSlaSettings,
  updateSlaPolicy,
} from '../sla'

export async function registerSlaRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/sla/config', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    return {
      enabled: await loadSlaEnabled(),
      businessHours: await loadBusinessHours(),
      policies: await listSlaPolicies(),
    }
  })

  app.post('/api/sla/settings', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const parsed = SlaSettings.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    await saveSlaSettings(parsed.data.enabled)
    await logAudit(session.user.id, 'sla.settings', 'instance', undefined, {
      enabled: parsed.data.enabled,
    })
    return { enabled: parsed.data.enabled }
  })

  app.post('/api/sla/business-hours', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const parsed = BusinessHours.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    await saveBusinessHours(parsed.data)
    await logAudit(session.user.id, 'sla.business_hours', 'instance', undefined, {
      timezone: parsed.data.timezone,
      windows: parsed.data.windows.length,
    })
    return parsed.data
  })

  app.get('/api/sla/policies', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    return listSlaPolicies()
  })

  app.post('/api/sla/policies', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const parsed = SlaPolicyCreate.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    try {
      const policy = await createSlaPolicy(parsed.data, session.user.id)
      return reply.code(201).send(policy)
    } catch (error) {
      // drizzle wraps the postgres error in .cause
      const cause = (error as { cause?: { code?: string; message?: string } })?.cause
      if (cause?.code === '23505' || cause?.message?.includes('sla_policies_name')) {
        return reply
          .code(409)
          .send({ error: 'conflict', message: 'a policy with this name already exists' })
      }
      throw error
    }
  })

  app.patch('/api/sla/policies/:id', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const { id } = request.params as { id: string }
    const parsed = SlaPolicyUpdate.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    const policy = await updateSlaPolicy(id, parsed.data, session.user.id)
    if (!policy) return reply.code(404).send(notFound())
    return policy
  })

  app.delete('/api/sla/policies/:id', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const { id } = request.params as { id: string }
    const deleted = await deleteSlaPolicy(id, session.user.id)
    if (!deleted) return reply.code(404).send(notFound())
    return reply.code(204).send()
  })
}
