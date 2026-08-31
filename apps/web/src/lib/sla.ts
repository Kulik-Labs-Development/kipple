import { businessMinutesBetween, type BusinessHours } from '@kipple/shared/sla'
import type { TicketRow } from './api'

export type SlaState = 'pending' | 'at_risk' | 'breached' | 'met'

// The state worth alarming on in the queue: breached > at_risk > open,
// ignoring lines without a due time. Closed/deleted tickets show nothing.
export function queueSlaState(ticket: TicketRow): SlaState | null {
  const active =
    ticket.status === 'open' || ticket.status === 'pending' || ticket.status === 'hold'
  if (!active) return null
  const lines = [
    ticket.slaResponseDueAt ? (ticket.slaResponseState as SlaState) : null,
    ticket.slaResolveDueAt ? (ticket.slaResolveState as SlaState) : null,
  ].filter((state): state is SlaState => Boolean(state))
  if (lines.includes('breached')) return 'breached'
  if (lines.includes('at_risk')) return 'at_risk'
  return lines.length > 0 ? 'pending' : null
}

export interface SlaLine {
  state: SlaState
  dueAt: string | null
  doneAt: string | null
}

// Business minutes left until a due time, clamped at 0 (null = no due time).
export function slaRemainingMinutes(
  dueAt: string | null,
  businessHours: BusinessHours,
  now: Date = new Date(),
): number | null {
  if (!dueAt) return null
  const remaining = businessMinutesBetween(now, new Date(dueAt), businessHours)
  return Math.max(0, remaining)
}

// The state an agent should act on: the worse of response/resolve while the
// ticket is open; the resolve outcome once closed.
export function effectiveSlaState(line: SlaLine | null | undefined): SlaState | null {
  if (!line || !line.dueAt) return null
  return line.state
}

export function slaStateClass(state: SlaState): string {
  switch (state) {
    case 'met':
      return 'border-ok text-ok'
    case 'at_risk':
      return 'border-warn text-warn'
    case 'breached':
      return 'border-danger text-danger'
    default:
      return 'border-line text-dim'
  }
}

export function slaStateLabel(state: SlaState): string {
  switch (state) {
    case 'met':
      return 'met'
    case 'at_risk':
      return 'at risk'
    case 'breached':
      return 'breached'
    default:
      return 'open'
  }
}

export function formatRemainingMinutes(mins: number): string {
  if (mins <= 0) return 'due'
  const days = Math.floor(mins / 1440)
  const hours = Math.floor((mins % 1440) / 60)
  const rest = mins % 60
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`
  if (hours > 0) return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`
  return `${rest}m`
}
