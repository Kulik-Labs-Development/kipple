import { HoldSettings } from '@kipple/shared'
import type { FastifyInstance } from 'fastify'
import { badRequest, requireRole } from '../access'
import { logAudit } from '../audit'
import { loadHoldSettings, saveHoldSettings } from '../holds'

// Instance hold settings (issue #30): how long a held ticket survives before
// auto-close, and the pre-close warning window. Staff can read, superuser
// writes. The POST body is the FULL settings object — the web UI always
// sends both keys.
export async function registerHoldRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/holds', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    return loadHoldSettings()
  })

  app.post('/api/holds', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const parsed = HoldSettings.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    const { autoCloseDays, warnDays } = parsed.data
    // cross-field rules the zod object can't express (raw 400s — house pattern)
    if (warnDays !== undefined && warnDays !== null) {
      if (autoCloseDays === undefined || autoCloseDays === null) {
        return reply.code(400).send({
          error: 'bad_request',
          message: 'warning days require an auto-close day count',
        })
      }
      if (warnDays >= autoCloseDays) {
        return reply.code(400).send({
          error: 'bad_request',
          message: 'warning days must be less than auto-close days',
        })
      }
    }
    const view = { autoCloseDays: autoCloseDays ?? null, warnDays: warnDays ?? null }
    await saveHoldSettings(view)
    await logAudit(session.user.id, 'hold.settings', 'instance', undefined, view)
    return view
  })
}
