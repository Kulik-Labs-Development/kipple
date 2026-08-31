import type { TicketRow } from './api'

export const TICKET_STATUSES = ['open', 'pending', 'hold', 'closed'] as const
export type StatusFilter = 'all' | (typeof TICKET_STATUSES)[number]
export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const

export function statusLedClass(status: string): string {
  switch (status) {
    case 'open':
      return 'bg-accent'
    case 'pending':
      return 'bg-warn'
    case 'hold':
      return 'bg-fg'
    case 'closed':
      return 'bg-ok'
    case 'deleted':
      return 'bg-danger'
    default:
      return 'bg-line'
  }
}

export function priorityClass(priority: string): string {
  switch (priority) {
    case 'urgent':
      return 'border-danger text-danger'
    case 'high':
      return 'border-warn text-warn'
    default:
      return 'border-line text-dim'
  }
}

export function relativeTime(iso: string, now: Date = new Date()): string {
  const diff = Math.max(0, now.getTime() - new Date(iso).getTime())
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'now'
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d`
  return new Date(iso).toISOString().slice(0, 10)
}

export function formatStamp(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}`
}

export interface QueueStats {
  assignedToMe: number
  inQueue: number
  openedToday: number
  closedToday: number
}

export function queueStats(tickets: TicketRow[], me: string, now: Date = new Date()): QueueStats {
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  let assignedToMe = 0
  let inQueue = 0
  let openedToday = 0
  let closedToday = 0
  for (const ticket of tickets) {
    const active = ticket.status === 'open' || ticket.status === 'pending' || ticket.status === 'hold'
    if (active && ticket.assignedTo === me) assignedToMe++
    if (ticket.status === 'open') inQueue++
    if (new Date(ticket.createdAt) >= startOfToday) openedToday++
    if (ticket.status === 'closed' && new Date(ticket.updatedAt) >= startOfToday) closedToday++
  }
  return { assignedToMe, inQueue, openedToday, closedToday }
}

export interface PortalFilters {
  status: StatusFilter
  q: string
}

export function filterPortalTickets(tickets: TicketRow[], filters: PortalFilters): TicketRow[] {
  const query = filters.q.trim().toLowerCase()
  return tickets.filter((ticket) => {
    if (filters.status !== 'all' && ticket.status !== filters.status) return false
    if (query && !ticket.subject.toLowerCase().includes(query)) return false
    return true
  })
}

export function parseTags(input: string): string[] {
  const seen = new Set<string>()
  const tags: string[] = []
  for (const raw of input.split(',')) {
    const tag = raw.trim().toLowerCase()
    if (tag && !seen.has(tag)) {
      seen.add(tag)
      tags.push(tag)
    }
  }
  return tags.slice(0, 20)
}
