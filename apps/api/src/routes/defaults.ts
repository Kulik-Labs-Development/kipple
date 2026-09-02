import { InstanceDefaults } from '@kipple/shared'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { badRequest, requireRole } from '../access'
import { logAudit } from '../audit'
import { db } from '../db'
import { settings } from '../db/schema'

// Instance-wide theme defaults (UI triage 09-02, batch B). One settings row
// per surface: 'theme' = the portal/instance default (the row /api/me already
// reads), 'agentTheme' = the staff fallback. null = the built-in default
// (console for agents, slate for the portal).
const AGENT_KEY = 'agentTheme'
const PORTAL_KEY = 'theme'

async function loadTheme(key: string): Promise<string | null> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, key))
  return ((row?.value as { id?: string } | null) ?? {}).id ?? null
}

async function saveTheme(key: string, id: string | null): Promise<void> {
  if (id === null) {
    await db.delete(settings).where(eq(settings.key, key))
    return
  }
  await db
    .insert(settings)
    .values({ key, value: { id } })
    .onConflictDoUpdate({ target: settings.key, set: { value: { id } } })
}

export async function registerDefaultRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/instance/defaults', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    return {
      agentTheme: await loadTheme(AGENT_KEY),
      portalTheme: await loadTheme(PORTAL_KEY),
    }
  })

  app.post('/api/instance/defaults', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const parsed = InstanceDefaults.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    if (parsed.data.agentTheme !== undefined) {
      await saveTheme(AGENT_KEY, parsed.data.agentTheme)
    }
    if (parsed.data.portalTheme !== undefined) {
      await saveTheme(PORTAL_KEY, parsed.data.portalTheme)
    }
    await logAudit(session.user.id, 'instance.defaults', 'instance', undefined, parsed.data)
    return {
      agentTheme: await loadTheme(AGENT_KEY),
      portalTheme: await loadTheme(PORTAL_KEY),
    }
  })
}
