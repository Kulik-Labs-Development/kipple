import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { requireUser } from '../access'
import { db } from '../db'
import { users } from '../db/schema'
import { listNotifications, markRead, unreadCount } from '../notifications'
import { sendPresenceEvent } from '../events'

const PresenceValues = ['online', 'away', 'busy', 'offline'] as const

export async function registerNotificationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/notifications', async (request, reply) => {
    const session = await requireUser(request, reply)
    if (!session) return null
    const query = request.query as Record<string, string | undefined>
    return listNotifications(session.user.id, {
      limit: query.limit ? Number(query.limit) : undefined,
      unread: query.unread === '1' || query.unread === 'true',
    })
  })

  app.get('/api/notifications/count', async (request, reply) => {
    const session = await requireUser(request, reply)
    if (!session) return null
    return { unread: await unreadCount(session.user.id) }
  })

  app.post('/api/notifications/read', async (request, reply) => {
    const session = await requireUser(request, reply)
    if (!session) return null
    const body = (request.body ?? {}) as { ids?: string[]; all?: boolean }
    const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === 'string') : null
    const updated = await markRead(session.user.id, body.all ? null : ids)
    return { updated, unread: await unreadCount(session.user.id) }
  })
}

export async function registerPresenceRoutes(app: FastifyInstance): Promise<void> {
  // Self-service presence: online | away | busy | offline (PLAN §dashboard).
  app.patch('/api/me/presence', async (request, reply) => {
    const session = await requireUser(request, reply)
    if (!session) return null
    const body = (request.body ?? {}) as { presence?: string }
    const nextPresence = body.presence as (typeof PresenceValues)[number] | undefined
    if (!nextPresence || !PresenceValues.includes(nextPresence)) {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: `presence must be one of: ${PresenceValues.join(', ')}` })
    }
    await db.update(users).set({ presence: nextPresence }).where(eq(users.id, session.user.id))
    // fan out to connected workspaces (issue #96) — presence is the first
    // event type on the SSE channel
    sendPresenceEvent(session.user.id, nextPresence)
    return { presence: nextPresence }
  })
}
