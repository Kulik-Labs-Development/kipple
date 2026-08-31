import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { RULE_EVENTS, RuleCreate, RuleUpdate } from '@kipple/shared'
import type { FastifyInstance } from 'fastify'
import { badRequest, notFound, requireRole } from '../access'
import { logAudit } from '../audit'
import { db } from '../db'
import { rules } from '../db/schema'
import { listRuleRuns, previewRules } from '../rules'

const TestRequest = {
  parse(body: unknown) {
    const b = (body ?? {}) as Record<string, unknown>
    return {
      ok:
        typeof b.ticketId === 'string' &&
        typeof b.event === 'string' &&
        (RULE_EVENTS as readonly string[]).includes(b.event),
      ticketId: b.ticketId as string | undefined,
      event: b.event,
      fromStatus: typeof b.fromStatus === 'string' ? b.fromStatus : undefined,
      actorRole: typeof b.actorRole === 'string' ? b.actorRole : 'agent',
    }
  },
}

export async function registerRuleRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/rules', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    return db.select().from(rules).orderBy(rules.name)
  })

  app.post('/api/rules', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const parsed = RuleCreate.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    const [row] = await db
      .insert(rules)
      .values({ id: randomUUID(), ...parsed.data })
      .returning()
    await logAudit(session.user.id, 'rule.create', 'rule', row.id, {
      name: row.name,
      enabled: row.enabled,
    })
    return reply.code(201).send(row)
  })

  app.patch('/api/rules/:id', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const { id } = request.params as { id: string }
    const parsed = RuleUpdate.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    const [row] = await db
      .update(rules)
      .set(parsed.data)
      .where(eq(rules.id, id))
      .returning()
    if (!row) return reply.code(404).send(notFound())
    await logAudit(session.user.id, 'rule.update', 'rule', id, {
      fields: Object.keys(parsed.data),
    })
    return row
  })

  app.delete('/api/rules/:id', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const { id } = request.params as { id: string }
    const [row] = await db.delete(rules).where(eq(rules.id, id)).returning()
    if (!row) return reply.code(404).send(notFound())
    await logAudit(session.user.id, 'rule.delete', 'rule', id, { name: row.name })
    return reply.code(204).send()
  })

  // Dry-run preview: which rules would fire for this ticket + event.
  app.post('/api/rules/test', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    const parsed = TestRequest.parse(request.body)
    if (!parsed.ok) {
      return reply
        .code(400)
        .send({
          error: 'bad_request',
          message: 'ticketId and a valid event are required',
        })
    }
    const matches = await previewRules(parsed.ticketId as string, parsed.event as never, {
      fromStatus: parsed.fromStatus,
      actorRole: parsed.actorRole,
    })
    return { ticketId: parsed.ticketId, event: parsed.event, matches }
  })

  app.get('/api/rules/runs', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    const query = request.query as Record<string, string | undefined>
    return listRuleRuns({
      ruleId: query.ruleId,
      limit: query.limit ? Number(query.limit) : undefined,
    })
  })
}
