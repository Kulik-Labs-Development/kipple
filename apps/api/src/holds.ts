import { randomUUID } from 'node:crypto'
import { and, eq, isNotNull } from 'drizzle-orm'
import pino from 'pino'
import { type HoldSettings } from '@kipple/shared'
import { logAudit } from './audit'
import { db } from './db'
import { settings, tickets, updates } from './db/schema'
import { markTicketResolved } from './sla'
import { notifyTicketEvent } from './notifications'
import { runRules, ticketSnapshot } from './rules'

const log = pino({ name: 'holds' })

const DAY_MS = 86_400_000
const SETTINGS_KEY = 'hold'

export interface HoldSettingsView {
  autoCloseDays: number | null
  warnDays: number | null
}

export async function loadHoldSettings(): Promise<HoldSettingsView> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, SETTINGS_KEY))
  const value = (row?.value as { autoCloseDays?: number; warnDays?: number } | null) ?? {}
  return { autoCloseDays: value.autoCloseDays ?? null, warnDays: value.warnDays ?? null }
}

export async function saveHoldSettings(view: HoldSettingsView): Promise<void> {
  await db
    .insert(settings)
    .values({ key: SETTINGS_KEY, value: view })
    .onConflictDoUpdate({ target: settings.key, set: { value: view } })
}

export interface HoldTransition {
  holdOn: string | null
  holdSince: Date | null
  holdWarnedAt: Date | null
}

// Compute the hold fields for a ticket update. Rules (documented decisions):
// entering hold starts the episode (hold_since=now, one warning allowed,
// reason defaults to 'client'); leaving hold clears all three; switching the
// reason while on hold keeps hold_since — total hold time is the timer.
export function applyHoldTransition(
  existing: { status: string; holdOn: string | null; holdSince: Date | null; holdWarnedAt: Date | null } | null,
  nextStatus: string | undefined,
  holdOnInput: string | null | undefined,
  now: Date = new Date(),
): HoldTransition | null {
  if (nextStatus === undefined) {
    // no status change: allow a reason switch while already on hold
    if (existing?.status === 'hold' && holdOnInput) {
      return { holdOn: holdOnInput, holdSince: existing.holdSince, holdWarnedAt: existing.holdWarnedAt }
    }
    return null
  }
  const wasHold = existing?.status === 'hold'
  if (nextStatus === 'hold' && !wasHold) {
    return { holdOn: holdOnInput ?? 'client', holdSince: now, holdWarnedAt: null }
  }
  if (wasHold && nextStatus !== 'hold') {
    return { holdOn: null, holdSince: null, holdWarnedAt: null }
  }
  // hold -> hold (same status, new reason): keep the episode's start
  if (nextStatus === 'hold' && wasHold && holdOnInput) {
    return { holdOn: holdOnInput, holdSince: existing!.holdSince, holdWarnedAt: existing!.holdWarnedAt }
  }
  return null
}

// Staff-only computed value for the ticket detail: when the held ticket
// auto-closes (calendar days from hold_since), or null.
export function computeHoldAutoCloseAt(
  ticket: { status: string; holdSince: Date | null },
  view: HoldSettingsView,
): string | null {
  if (ticket.status !== 'hold' || !ticket.holdSince || view.autoCloseDays === null) return null
  return new Date(ticket.holdSince.getTime() + view.autoCloseDays * DAY_MS).toISOString()
}

export interface HoldTickResult {
  closed: number
  warned: number
}

// Worker tick: walks the held tickets and fires the pre-close warning (once
// per episode) or the auto-close (status -> closed, hold fields cleared).
// Calendar days, not business hours (documented decision).
export async function tickHolds(now: Date = new Date()): Promise<HoldTickResult> {
  const result: HoldTickResult = { closed: 0, warned: 0 }
  const view = await loadHoldSettings()
  if (view.autoCloseDays === null) return result
  const rows = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.status, 'hold'), isNotNull(tickets.holdSince)))
  for (const ticket of rows) {
    const holdSince = ticket.holdSince!
    const dueAt = new Date(holdSince.getTime() + view.autoCloseDays * DAY_MS)
    if (now >= dueAt) {
      await autoCloseHold(ticket, view.autoCloseDays, now)
      result.closed++
    } else if (
      view.warnDays !== null &&
      ticket.holdWarnedAt === null &&
      now >= new Date(dueAt.getTime() - view.warnDays * DAY_MS)
    ) {
      await warnHold(ticket, view.autoCloseDays, now, dueAt)
      result.warned++
    }
  }
  if (result.closed > 0 || result.warned > 0) {
    log.info({ closed: result.closed, warned: result.warned }, 'hold tick emitted events')
  }
  return result
}

async function autoCloseHold(ticket: typeof tickets.$inferSelect, days: number, now: Date) {
  await db
    .update(tickets)
    .set({ status: 'closed', holdOn: null, holdSince: null, holdWarnedAt: null })
    .where(eq(tickets.id, ticket.id))
  // settle the resolve SLA like a manual close would (holds do not pause SLA)
  await markTicketResolved(ticket.id, now, null)
  await db.insert(updates).values({
    id: randomUUID(),
    ticketId: ticket.id,
    authorId: null,
    kind: 'system',
    body: `auto-closed after ${days} days on hold (waiting on ${ticket.holdOn ?? 'client'})`,
  })
  await logAudit(null, 'ticket.hold_auto_close', 'ticket', ticket.id, {
    ticketNumber: ticket.number,
    holdOn: ticket.holdOn,
    holdSince: ticket.holdSince?.toISOString() ?? null,
    days,
  })
  const [fresh] = await db.select().from(tickets).where(eq(tickets.id, ticket.id))
  if (fresh) {
    const actor = { id: null, name: 'system', role: 'system' }
    await runRules({
      type: 'ticket.status_changed',
      ticket: ticketSnapshot(fresh),
      fromStatus: 'hold',
      actor,
    })
    await notifyTicketEvent({
      type: 'ticket.status_changed',
      ticket: ticketSnapshot(fresh),
      fromStatus: 'hold',
      actor,
    })
  }
}

async function warnHold(
  ticket: typeof tickets.$inferSelect,
  days: number,
  now: Date,
  dueAt: Date,
) {
  const daysLeft = Math.max(1, Math.ceil((dueAt.getTime() - now.getTime()) / DAY_MS))
  await db.insert(updates).values({
    id: randomUUID(),
    ticketId: ticket.id,
    authorId: null,
    kind: 'system',
    body: `pre-close warning — auto-closes in ${daysLeft} days (${days} days on hold, waiting on ${ticket.holdOn ?? 'client'})`,
  })
  await logAudit(null, 'ticket.hold_warning', 'ticket', ticket.id, {
    ticketNumber: ticket.number,
    holdOn: ticket.holdOn,
    dueAt: dueAt.toISOString(),
  })
  await db.update(tickets).set({ holdWarnedAt: now }).where(eq(tickets.id, ticket.id))
  const [fresh] = await db.select().from(tickets).where(eq(tickets.id, ticket.id))
  if (fresh) {
    const actor = { id: null, name: 'system', role: 'system' }
    await runRules({ type: 'ticket.hold_warning', ticket: ticketSnapshot(fresh), actor })
    await notifyTicketEvent({
      type: 'ticket.hold_warning',
      ticket: ticketSnapshot(fresh),
      actor,
      daysUntilAutoClose: daysLeft,
    })
  }
}

export type { HoldSettings }
