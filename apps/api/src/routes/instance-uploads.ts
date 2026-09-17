import { UploadSettingsPatch, type UploadSettings } from '@kipple/shared'
import type { FastifyInstance } from 'fastify'
import { badRequest, requireRole } from '../access'
import { logAudit } from '../audit'
import { db } from '../db'
import { settings } from '../db/schema'
import { effectiveUploadSettings } from '../uploads'

// Superuser upload settings (plan row 18 part 1): max file size + the
// editable MIME allowlist. One settings row ('uploads'); absent = env
// defaults + open allowlist. Every change is audit-logged old -> new.

const KEY = 'uploads'

export async function registerInstanceUploadRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/instance/uploads', async (_request, reply) => {
    const session = await requireRole(_request, reply, ['superuser'])
    if (!session) return null
    const { view } = await effectiveUploadSettings()
    return view
  })

  app.post('/api/instance/uploads', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const parsed = UploadSettingsPatch.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))

    const from = await effectiveUploadSettings()
    const to: UploadSettings = {
      maxMb: parsed.data.maxMb ?? from.view.maxMb,
      allowedMimes: parsed.data.allowedMimes ?? from.view.allowedMimes,
    }
    await db
      .insert(settings)
      .values({ key: KEY, value: to })
      .onConflictDoUpdate({ target: settings.key, set: { value: to } })
    await logAudit(session.user.id, 'instance.uploads', 'instance', undefined, {
      from: from.view,
      to,
    })
    return to
  })
}
