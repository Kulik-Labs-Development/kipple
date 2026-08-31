import { randomUUID } from 'node:crypto'
import { and, eq, isNotNull, ne } from 'drizzle-orm'
import pino from 'pino'
import {
  BusinessHours,
  DEFAULT_BUSINESS_HOURS,
  SLA_AT_RISK_FRACTION,
  SlaPolicyCreate,
  SlaPolicyUpdate,
  addBusinessMinutes,
  businessMinutesBetween,
  type SlaTargets,
} from '@kipple/shared'
import { logAudit } from './audit'
import { db } from './db'
import { clients, settings, slaPolicies, tickets, updates } from './db/schema'
import { notifySlaBreach } from './notifications'

const log = pino({ name: 'sla' })

export interface SlaPolicyView {
  id: string
  name: string
  targets: SlaTargets
  isDefault: boolean
}

function policyView(row: typeof slaPolicies.$inferSelect): SlaPolicyView {
  return {
    id: row.id,
    name: row.name,
    targets: row.targets as SlaTargets,
    isDefault: row.isDefault,
  }
}

// ---------------------------------------------------------------- settings

export async function loadSlaEnabled(): Promise<boolean> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, 'sla'))
  return ((row?.value as { enabled?: boolean } | null) ?? {}).enabled === true
}

export async function saveSlaSettings(enabled: boolean): Promise<void> {
  await db
    .insert(settings)
    .values({ key: 'sla', value: { enabled } })
    .onConflictDoUpdate({ target: settings.key, set: { value: { enabled } } })
}

export async function loadBusinessHours(): Promise<BusinessHours> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, 'business_hours'))
  const value = (row?.value as BusinessHours | null) ?? null
  if (!value) return DEFAULT_BUSINESS_HOURS
  return BusinessHours.parse(value)
}

export async function saveBusinessHours(hours: BusinessHours): Promise<void> {
  await db
    .insert(settings)
    .values({ key: 'business_hours', value: hours })
    .onConflictDoUpdate({ target: settings.key, set: { value: hours } })
}

// ---------------------------------------------------------------- policies

export async function listSlaPolicies(): Promise<SlaPolicyView[]> {
  const rows = await db.select().from(slaPolicies)
  return rows.map(policyView)
}

export async function getSlaPolicy(id: string): Promise<SlaPolicyView | null> {
  const [row] = await db.select().from(slaPolicies).where(eq(slaPolicies.id, id))
  return row ? policyView(row) : null
}

export async function createSlaPolicy(input: SlaPolicyCreate, actorId: string) {
  if (input.isDefault) {
    await db.update(slaPolicies).set({ isDefault: false }).where(eq(slaPolicies.isDefault, true))
  }
  const [row] = await db
    .insert(slaPolicies)
    .values({
      id: randomUUID(),
      name: input.name,
      targets: input.targets,
      isDefault: input.isDefault,
    })
    .returning()
  await logAudit(actorId, 'sla_policy.create', 'sla_policy', row.id, { name: input.name })
  return policyView(row)
}

export async function updateSlaPolicy(id: string, input: SlaPolicyUpdate, actorId: string) {
  if (input.isDefault === true) {
    await db
      .update(slaPolicies)
      .set({ isDefault: false })
      .where(and(eq(slaPolicies.isDefault, true), ne(slaPolicies.id, id)))
  }
  const patch: Partial<typeof slaPolicies.$inferInsert> = {}
  if (input.name !== undefined) patch.name = input.name
  if (input.targets !== undefined) patch.targets = input.targets
  if (input.isDefault !== undefined) patch.isDefault = input.isDefault
  const [row] = await db
    .update(slaPolicies)
    .set(patch)
    .where(eq(slaPolicies.id, id))
    .returning()
  if (!row) return null
  await logAudit(actorId, 'sla_policy.update', 'sla_policy', id, {
    fields: Object.keys(input),
  })
  return policyView(row)
}

export async function deleteSlaPolicy(id: string, actorId: string) {
  const [row] = await db.delete(slaPolicies).where(eq(slaPolicies.id, id)).returning()
  if (!row) return false
  await logAudit(actorId, 'sla_policy.delete', 'sla_policy', id, { name: row.name })
  return true
}

// ------------------------------------------------- ticket due-time engine

// Precedence: per-ticket policy override > client policy > instance default.
async function resolvePolicy(clientId: string, ticketPolicyId: string | null) {
  if (ticketPolicyId) {
    const direct = await getSlaPolicy(ticketPolicyId)
    if (direct) return direct
  }
  const [client] = await db
    .select({ slaPolicyId: clients.slaPolicyId })
    .from(clients)
    .where(eq(clients.id, clientId))
  if (client?.slaPolicyId) {
    const fromClient = await getSlaPolicy(client.slaPolicyId)
    if (fromClient) return fromClient
  }
  const [def] = await db
    .select()
    .from(slaPolicies)
    .where(eq(slaPolicies.isDefault, true))
  return def ? policyView(def) : null
}

// (Re)compute the due times for a ticket from `from` using its resolved
// policy. Clears the SLA fields when SLA is off or no policy resolves.
export async function applySlaToTicket(
  ticketId: string,
  from: Date = new Date(),
  actorId?: string | null,
): Promise<void> {
  const enabled = await loadSlaEnabled()
  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId))
  if (!ticket) return

  if (!enabled) {
    await db
      .update(tickets)
      .set({
        slaPolicyId: null,
        slaResponseDueAt: null,
        slaResolveDueAt: null,
        slaResponseState: 'pending',
        slaResolveState: 'pending',
      })
      .where(eq(tickets.id, ticketId))
    return
  }

  const policy = await resolvePolicy(ticket.clientId, ticket.slaPolicyId)
  if (!policy) {
    await db
      .update(tickets)
      .set({
        slaPolicyId: null,
        slaResponseDueAt: null,
        slaResolveDueAt: null,
        slaResponseState: 'pending',
        slaResolveState: 'pending',
      })
      .where(eq(tickets.id, ticketId))
    return
  }

  const businessHours = await loadBusinessHours()
  const priority = ticket.priority as keyof SlaTargets['responseMinutes']
  const responseDue = addBusinessMinutes(from, policy.targets.responseMinutes[priority], businessHours)
  const resolveDue = addBusinessMinutes(from, policy.targets.resolveMinutes[priority], businessHours)
  // A ticket that already got its first reply / a close keeps its timestamp;
  // the state is re-judged against the new due time (no re-emit — the event
  // was already sent when the reply/close happened).
  const responseState = ticket.slaResponseAt
    ? ticket.slaResponseAt > responseDue
      ? 'breached'
      : 'met'
    : 'pending'
  const resolveState = ticket.slaResolvedAt
    ? ticket.slaResolvedAt > resolveDue
      ? 'breached'
      : 'met'
    : 'pending'
  await db
    .update(tickets)
    .set({
      slaPolicyId: policy.id,
      slaResponseDueAt: responseDue,
      slaResolveDueAt: resolveDue,
      slaResponseState: responseState,
      slaResolveState: resolveState,
    })
    .where(eq(tickets.id, ticketId))
  await logAudit(actorId ?? null, 'ticket.sla_recomputed', 'ticket', ticketId, {
    policy: policy.id,
    responseDueAt: responseDue.toISOString(),
    resolveDueAt: resolveDue.toISOString(),
  })
}

async function emitSlaEvent(
  actorId: string | null,
  ticket: { id: string; number: number },
  kind: 'response' | 'resolve',
  state: 'at_risk' | 'breached' | 'met',
  dueAt: Date | null,
) {
  const dueText = dueAt ? dueAt.toISOString() : 'n/a'
  const body =
    state === 'at_risk'
      ? `SLA ${kind} at risk — was due ${dueText}`
      : state === 'breached'
        ? `SLA ${kind} breached — was due ${dueText}`
        : `SLA ${kind} met`
  await db.insert(updates).values({
    id: randomUUID(),
    ticketId: ticket.id,
    authorId: null,
    kind: 'system',
    body,
  })
  await logAudit(actorId, `sla.${kind}.${state}`, 'ticket', ticket.id, {
    ticketNumber: ticket.number,
    dueAt: dueText,
  })
  if (state === 'breached') await notifySlaBreach(ticket.id, ticket.number, kind)
}

function atRiskFrom(
  start: Date,
  dueAt: Date,
  now: Date,
  businessHours: BusinessHours,
): boolean {
  if (now > dueAt) return false // the breach transition takes over
  const total = businessMinutesBetween(start, dueAt, businessHours)
  if (total <= 0) return false
  const elapsed = businessMinutesBetween(start, now, businessHours)
  return elapsed >= total * (1 - SLA_AT_RISK_FRACTION)
}

// First staff reply. Called from the update route (staff public updates) and
// ticket create-with-body.
export async function markTicketResponded(
  ticketId: string,
  at: Date = new Date(),
  actorId: string | null = null,
): Promise<void> {
  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId))
  if (!ticket || ticket.slaResponseAt) return
  if (!ticket.slaResponseDueAt) {
    // no SLA attached yet — just record the timestamp; a later
    // applySlaToTicket/tick will judge it
    await db.update(tickets).set({ slaResponseAt: at }).where(eq(tickets.id, ticketId))
    return
  }
  if (at > ticket.slaResponseDueAt) {
    // late reply: record it; the ticket is still open, so the next tick
    // announces the breach (avoids a double event when the tick already did)
    await db
      .update(tickets)
      .set({ slaResponseAt: at, slaResponseState: 'breached' })
      .where(eq(tickets.id, ticketId))
    return
  }
  await db
    .update(tickets)
    .set({ slaResponseAt: at, slaResponseState: 'met' })
    .where(eq(tickets.id, ticketId))
  await emitSlaEvent(actorId, ticket, 'response', 'met', ticket.slaResponseDueAt)
}

// Ticket reached closed. Called from the ticket patch route.
export async function markTicketResolved(
  ticketId: string,
  at: Date = new Date(),
  actorId: string | null = null,
): Promise<void> {
  const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId))
  if (!ticket || ticket.slaResolvedAt) return
  if (!ticket.slaResolveDueAt) {
    await db.update(tickets).set({ slaResolvedAt: at }).where(eq(tickets.id, ticketId))
    return
  }
  // A closed ticket leaves the tick's scope, so the breach must be
  // announced here even when it was already overdue.
  const state = at > ticket.slaResolveDueAt ? 'breached' : 'met'
  await db
    .update(tickets)
    .set({ slaResolvedAt: at, slaResolveState: state })
    .where(eq(tickets.id, ticketId))
  await emitSlaEvent(actorId, ticket, 'resolve', state, ticket.slaResolveDueAt)
}

// Worker tick: transitions open tickets through at_risk/breached for both
// response and resolve. Returns the number of events emitted.
export async function tickSla(now: Date = new Date()): Promise<number> {
  if (!(await loadSlaEnabled())) return 0
  const businessHours = await loadBusinessHours()
  const rows = await db
    .select()
    .from(tickets)
    .where(
      and(
        ne(tickets.status, 'closed'),
        ne(tickets.status, 'deleted'),
        isNotNull(tickets.slaResponseDueAt),
        isNotNull(tickets.slaResolveDueAt),
      ),
    )
  let emitted = 0
  for (const ticket of rows) {
    // response
    if (['pending', 'at_risk'].includes(ticket.slaResponseState)) {
      if (ticket.slaResponseAt) {
        const state =
          ticket.slaResponseDueAt && ticket.slaResponseAt > ticket.slaResponseDueAt
            ? 'breached'
            : 'met'
        await db
          .update(tickets)
          .set({ slaResponseState: state })
          .where(eq(tickets.id, ticket.id))
        await emitSlaEvent(null, ticket, 'response', state, ticket.slaResponseDueAt)
        emitted++
      } else if (ticket.slaResponseDueAt && now > ticket.slaResponseDueAt) {
        await db
          .update(tickets)
          .set({ slaResponseState: 'breached' })
          .where(eq(tickets.id, ticket.id))
        await emitSlaEvent(null, ticket, 'response', 'breached', ticket.slaResponseDueAt)
        emitted++
      } else if (
        ticket.slaResponseDueAt &&
        ticket.slaResponseState === 'pending' &&
        atRiskFrom(ticket.createdAt, ticket.slaResponseDueAt, now, businessHours)
      ) {
        await db
          .update(tickets)
          .set({ slaResponseState: 'at_risk' })
          .where(eq(tickets.id, ticket.id))
        await emitSlaEvent(null, ticket, 'response', 'at_risk', ticket.slaResponseDueAt)
        emitted++
      }
    }
    // resolve (only while still open; closure itself is handled by
    // markTicketResolved)
    if (['pending', 'at_risk'].includes(ticket.slaResolveState)) {
      if (ticket.slaResolveDueAt && now > ticket.slaResolveDueAt) {
        await db
          .update(tickets)
          .set({ slaResolveState: 'breached' })
          .where(eq(tickets.id, ticket.id))
        await emitSlaEvent(null, ticket, 'resolve', 'breached', ticket.slaResolveDueAt)
        emitted++
      } else if (
        ticket.slaResolveDueAt &&
        ticket.slaResolveState === 'pending' &&
        atRiskFrom(ticket.createdAt, ticket.slaResolveDueAt, now, businessHours)
      ) {
        await db
          .update(tickets)
          .set({ slaResolveState: 'at_risk' })
          .where(eq(tickets.id, ticket.id))
        await emitSlaEvent(null, ticket, 'resolve', 'at_risk', ticket.slaResolveDueAt)
        emitted++
      }
    }
  }
  if (emitted > 0) log.info({ emitted }, 'sla tick emitted events')
  return emitted
}


