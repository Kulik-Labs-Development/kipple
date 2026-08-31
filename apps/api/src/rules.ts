import { createHmac, randomUUID } from 'node:crypto'
import { desc, eq } from 'drizzle-orm'
import { RuleAction, RuleMatch, type RuleEventName } from '@kipple/shared'
import { logAudit } from './audit'
import { db } from './db'
import { ruleRuns, rules, tickets } from './db/schema'
import { enqueueOutbox, loadEmailSettings, resolveClientContactEmail } from './mail'
import { markTicketResolved } from './sla'
import { buildTemplateVars, getEnabledTemplate, renderTemplate } from './templates'

export interface RuleTicketSnapshot {
  id: string
  number: number
  subject: string
  status: string
  priority: string
  clientId: string
  alias: string | null
  tags: string[]
  assignedTo: string | null
  createdAt: Date
}

export interface RuleEvent {
  type: RuleEventName
  ticket: RuleTicketSnapshot
  // previous status for ticket.status_changed
  fromStatus?: string
  actor: { id: string | null; name: string | null; role: string }
  // the staff message that triggered the event, when there is one
  body?: string
}

export function ticketSnapshot(
  t: Pick<
    typeof tickets.$inferSelect,
    | 'id'
    | 'number'
    | 'subject'
    | 'status'
    | 'priority'
    | 'clientId'
    | 'alias'
    | 'tags'
    | 'assignedTo'
    | 'createdAt'
  >,
): RuleTicketSnapshot {
  return {
    id: t.id,
    number: t.number,
    subject: t.subject,
    status: t.status,
    priority: t.priority,
    clientId: t.clientId,
    alias: t.alias,
    tags: t.tags,
    assignedTo: t.assignedTo,
    createdAt: t.createdAt,
  }
}

export function matchRule(match: RuleMatch, event: RuleEvent): boolean {
  if (match.event !== event.type) return false
  if (match.status && event.ticket.status !== match.status) return false
  if (match.fromStatus && event.fromStatus !== match.fromStatus) return false
  if (match.priority && event.ticket.priority !== match.priority) return false
  if (match.clientId && event.ticket.clientId !== match.clientId) return false
  if (match.tags && !match.tags.every((tag) => event.ticket.tags.includes(tag))) return false
  if (match.staffOnly && event.actor.role === 'contact') return false
  return true
}

interface ActionOutcome {
  result: 'ok' | 'noop' | 'error'
  error?: string
  meta?: Record<string, unknown>
}

async function runAction(action: RuleAction, event: RuleEvent): Promise<ActionOutcome> {
  switch (action.type) {
    case 'send_template': {
      const template = await getEnabledTemplate(action.templateKey)
      if (!template) return { result: 'noop', meta: { reason: 'template missing or disabled' } }
      const settingsValue = await loadEmailSettings()
      if (!settingsValue?.smtp) return { result: 'noop', meta: { reason: 'email not configured' } }
      const recipient = await resolveClientContactEmail(event.ticket.clientId)
      if (!recipient) return { result: 'noop', meta: { reason: 'no contact email' } }
      const vars = await buildTemplateVars({
        ticket: {
          id: event.ticket.id,
          number: event.ticket.number,
          subject: event.ticket.subject,
          status: event.ticket.status,
          priority: event.ticket.priority,
          alias: event.ticket.alias,
          createdAt: event.ticket.createdAt,
        },
        agentName: event.actor.name ?? undefined,
        body: event.body,
        clientId: event.ticket.clientId,
      })
      const id = await enqueueOutbox({
        ticketId: event.ticket.id,
        to: recipient.email,
        from: settingsValue.smtp.from,
        fromName: settingsValue.smtp.fromName || null,
        subject: renderTemplate(template.subject, vars),
        body: renderTemplate(template.body, vars),
        replyTo: event.ticket.alias,
        messageId: `<${randomUUID()}@${settingsValue.domain}>`,
      })
      return { result: 'ok', meta: { outboxId: id, to: recipient.email } }
    }
    case 'assign': {
      await db
        .update(tickets)
        .set({ assignedTo: action.userId })
        .where(eq(tickets.id, event.ticket.id))
      return { result: 'ok', meta: { assignedTo: action.userId } }
    }
    case 'add_tag': {
      const [current] = await db
        .select({ tags: tickets.tags })
        .from(tickets)
        .where(eq(tickets.id, event.ticket.id))
      if (!current) return { result: 'noop', meta: { reason: 'ticket gone' } }
      const tags = [...new Set([...current.tags, ...action.tags])]
      await db.update(tickets).set({ tags }).where(eq(tickets.id, event.ticket.id))
      return { result: 'ok', meta: { tags } }
    }
    case 'set_status': {
      const [current] = await db
        .select({ status: tickets.status })
        .from(tickets)
        .where(eq(tickets.id, event.ticket.id))
      if (!current) return { result: 'noop', meta: { reason: 'ticket gone' } }
      await db
        .update(tickets)
        .set({ status: action.status })
        .where(eq(tickets.id, event.ticket.id))
      if (action.status === 'closed' && current.status !== 'closed') {
        await markTicketResolved(event.ticket.id, new Date(), event.actor.id)
      }
      return { result: 'ok', meta: { status: action.status } }
    }
    case 'webhook': {
      const payload = JSON.stringify({
        event: event.type,
        firedAt: new Date().toISOString(),
        ticket: {
          id: event.ticket.id,
          number: event.ticket.number,
          subject: event.ticket.subject,
          status: event.ticket.status,
          priority: event.ticket.priority,
          clientId: event.ticket.clientId,
        },
      })
      const headers: Record<string, string> = { 'content-type': 'application/json' }
      if (action.secret) {
        headers['x-kipple-signature'] = createHmac('sha256', action.secret)
          .update(payload)
          .digest('hex')
      }
      const res = await fetch(action.url, {
        method: 'POST',
        headers,
        body: payload,
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) return { result: 'error', error: `webhook responded ${res.status}` }
      return { result: 'ok', meta: { status: res.status } }
    }
  }
}

// Evaluate all enabled rules against one ticket event and run the matching
// actions. Every execution (ok/noop/error) is logged to rule_runs.
export async function runRules(event: RuleEvent): Promise<number> {
  const enabled = await db.select().from(rules).where(eq(rules.enabled, true))
  let fired = 0
  for (const rule of enabled) {
    if (!matchRule(rule.match as RuleMatch, event)) continue
    fired++
    let outcome: ActionOutcome = { result: 'error', error: 'invalid action' }
    try {
      outcome = await runAction(rule.action as RuleAction, event)
    } catch (error) {
      outcome = { result: 'error', error: error instanceof Error ? error.message : String(error) }
    }
    await db
      .insert(ruleRuns)
      .values({
        id: randomUUID(),
        ruleId: rule.id,
        event: event.type,
        ticketId: event.ticket.id,
        result: outcome.result,
        error: outcome.error ?? null,
        meta: outcome.meta ?? null,
      })
    await logAudit(event.actor.id, 'rule.fire', 'ticket', event.ticket.id, {
      ruleId: rule.id,
      rule: rule.name,
      action: (rule.action as RuleAction).type,
      result: outcome.result,
      error: outcome.error ?? undefined,
    })
  }
  return fired
}

// Dry run for the "test rule" preview: which rules (enabled or not) would
// fire for this ticket + event. Never executes, never logs.
export async function previewRules(
  ticketId: string,
  type: RuleEventName,
  opts: { fromStatus?: string; actorRole?: string } = {},
): Promise<
  Array<{
    ruleId: string
    name: string
    enabled: boolean
    matches: boolean
    match: RuleMatch
    action: RuleAction
  }>
> {
  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId))
  if (!ticket) return []
  const event: RuleEvent = {
    type,
    ticket: ticketSnapshot(ticket),
    fromStatus: opts.fromStatus,
    actor: { id: null, name: null, role: opts.actorRole ?? 'agent' },
  }
  const rows = await db.select().from(rules)
  return rows
    .map((rule) => ({
      ruleId: rule.id,
      name: rule.name,
      enabled: rule.enabled,
      matches: matchRule(rule.match as RuleMatch, event),
      match: rule.match as RuleMatch,
      action: rule.action as RuleAction,
    }))
    .filter((rule) => rule.matches)
}

export async function listRuleRuns(opts: { ruleId?: string; limit?: number } = {}) {
  const limit = Math.min(opts.limit ?? 100, 500)
  return db
    .select()
    .from(ruleRuns)
    .where(opts.ruleId ? eq(ruleRuns.ruleId, opts.ruleId) : undefined)
    .orderBy(desc(ruleRuns.createdAt))
    .limit(limit)
}
