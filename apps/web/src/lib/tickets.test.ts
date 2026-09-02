import { describe, expect, it } from 'vitest'
import type { TicketRow } from './api'
import {
  dailySeries,
  filterPortalTickets,
  formatClock,
  formatDuration,
  formatStamp,
  parseTags,
  priorityClass,
  queueStats,
  relativeTime,
  shortDate,
  statusLedClass,
} from './tickets'

function ticket(overrides: Partial<TicketRow>): TicketRow {
  return {
    id: 't1',
    number: 1,
    clientId: 'c1',
    alias: 'support+1@kipple.local',
    subject: 'test',
    status: 'open',
    priority: 'normal',
    assignedTo: null,
    tags: [],
    createdAt: '2026-08-30T08:00:00Z',
    updatedAt: '2026-08-30T08:00:00Z',
    slaPolicyId: null,
    slaResponseDueAt: null,
    slaResolveDueAt: null,
    slaResponseAt: null,
    slaResolvedAt: null,
    slaResponseState: 'pending',
    slaResolveState: 'pending',
    ...overrides,
  }
}

const now = new Date('2026-08-30T15:00:00Z')

describe('statusLedClass', () => {
  it('maps every status to a semantic token', () => {
    expect(statusLedClass('open')).toBe('bg-accent')
    expect(statusLedClass('pending')).toBe('bg-warn')
    expect(statusLedClass('hold')).toBe('bg-fg')
    expect(statusLedClass('closed')).toBe('bg-ok')
    expect(statusLedClass('deleted')).toBe('bg-danger')
    expect(statusLedClass('bogus')).toBe('bg-line')
  })
})

describe('priorityClass', () => {
  it('highlights urgent and high', () => {
    expect(priorityClass('urgent')).toContain('danger')
    expect(priorityClass('high')).toContain('warn')
    expect(priorityClass('normal')).toBe('border-line text-dim')
    expect(priorityClass('low')).toBe('border-line text-dim')
  })
})

describe('relativeTime', () => {
  it('buckets elapsed time', () => {
    expect(relativeTime('2026-08-30T14:59:30Z', now)).toBe('now')
    expect(relativeTime('2026-08-30T14:30:00Z', now)).toBe('30m')
    expect(relativeTime('2026-08-30T12:00:00Z', now)).toBe('3h')
    expect(relativeTime('2026-08-28T15:00:00Z', now)).toBe('2d')
    expect(relativeTime('2026-07-01T00:00:00Z', now)).toBe('2026-07-01')
  })
})

describe('formatStamp', () => {
  it('renders a local readable stamp', () => {
    const stamp = formatStamp('2026-08-30T15:07:00Z')
    expect(stamp).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })
})

describe('shortDate', () => {
  it('renders the compact MM-DD created date (matches formatStamp)', () => {
    const iso = '2026-08-30T15:07:00Z'
    const stamp = formatStamp(iso)
    expect(shortDate(iso)).toBe(stamp.slice(5, 10))
    expect(shortDate(iso)).toMatch(/^\d{2}-\d{2}$/)
  })
})

describe('queueStats', () => {
  it('counts assigned, in queue, opened and closed today', () => {
    const startOfToday = new Date(now)
    startOfToday.setHours(0, 0, 0, 0)
    const at = (hours: number) => new Date(startOfToday.getTime() + hours * 3_600_000).toISOString()
    const tickets = [
      ticket({ id: 'a', status: 'open', assignedTo: 'me', createdAt: at(2), updatedAt: at(2) }),
      ticket({ id: 'b', status: 'open', assignedTo: 'someone', createdAt: at(3), updatedAt: at(3) }),
      ticket({ id: 'c', status: 'hold', assignedTo: 'me', createdAt: at(4), updatedAt: at(4) }),
      ticket({
        id: 'd',
        status: 'closed',
        createdAt: at(-20),
        updatedAt: at(6),
      }),
      ticket({ id: 'e', status: 'pending', assignedTo: 'me', createdAt: at(26), updatedAt: at(26) }),
    ]
    expect(queueStats(tickets, 'me', now)).toEqual({
      assignedToMe: 3,
      inQueue: 2,
      openedToday: 4,
      closedToday: 1,
      overdue: 0,
    })
  })

  it('counts active tickets with a breached SLA line as overdue', () => {
    const tickets = [
      ticket({ id: 'a', status: 'open', slaResponseState: 'breached' }),
      ticket({ id: 'b', status: 'hold', slaResolveState: 'breached' }),
      ticket({ id: 'c', status: 'closed', slaResponseState: 'breached' }), // closed: not overdue
      ticket({ id: 'd', status: 'open', slaResponseState: 'at_risk' }), // at risk: not yet
    ]
    expect(queueStats(tickets, 'me', now).overdue).toBe(2)
  })
})

describe('dailySeries', () => {
  it('buckets opened by createdAt and closed by updatedAt over the last N days', () => {
    // now = 2026-08-30T15:00Z -> 14-day window ends on 2026-08-30
    const day = (offset: number) =>
      new Date(Date.UTC(2026, 7, 30) - offset * 86_400_000).toISOString()
    const tickets = [
      ticket({ id: 'a', createdAt: day(0), updatedAt: day(0) }),
      ticket({ id: 'b', createdAt: day(1), updatedAt: day(1) }),
      ticket({
        id: 'c',
        status: 'closed',
        createdAt: day(3),
        updatedAt: day(0),
      }),
      ticket({ id: 'd', createdAt: day(20), updatedAt: day(20) }), // outside window
    ]
    const { opened, closed } = dailySeries(tickets, 14, now)
    expect(opened).toHaveLength(14)
    expect(opened[13]).toBe(1) // today (index 13 = last)
    expect(opened[12]).toBe(1) // yesterday
    expect(opened[10]).toBe(1) // 3 days ago
    expect(opened.reduce((a, b) => a + b, 0)).toBe(3)
    expect(closed.reduce((a, b) => a + b, 0)).toBe(1)
    expect(closed[13]).toBe(1) // closed today
  })
})

describe('parseTags', () => {
  it('trims, lowercases, dedupes and caps at 20', () => {
    expect(parseTags(' wifi , WIFI, wifi,,')).toEqual(['wifi'])
    const many = Array.from({ length: 25 }, (_, i) => `tag${i}`).join(',')
    expect(parseTags(many)).toHaveLength(20)
    expect(parseTags('  ')).toEqual([])
  })
})

describe('filterPortalTickets', () => {
  const rows = [
    ticket({ id: 't1', subject: 'VPN down', status: 'open' }),
    ticket({ id: 't2', subject: 'Password reset', status: 'pending' }),
    ticket({ id: 't3', subject: 'vpn issue two', status: 'closed' }),
  ]

  it('filters by status', () => {
    expect(filterPortalTickets(rows, { status: 'open', q: '' })).toHaveLength(1)
    expect(filterPortalTickets(rows, { status: 'closed', q: '' })).toHaveLength(1)
    expect(filterPortalTickets(rows, { status: 'all', q: '' })).toHaveLength(3)
  })

  it('filters by case-insensitive subject search', () => {
    expect(filterPortalTickets(rows, { status: 'all', q: 'VPN' })).toHaveLength(2)
    expect(filterPortalTickets(rows, { status: 'all', q: '   ' })).toHaveLength(3)
    expect(filterPortalTickets(rows, { status: 'all', q: 'nope' })).toHaveLength(0)
  })

  it('combines status and search', () => {
    expect(filterPortalTickets(rows, { status: 'open', q: 'vpn' })).toHaveLength(1)
    expect(filterPortalTickets(rows, { status: 'closed', q: 'vpn' })).toHaveLength(1)
    expect(filterPortalTickets(rows, { status: 'pending', q: 'vpn' })).toHaveLength(0)
  })
})

describe('formatClock', () => {
  it('renders mm:ss and h:mm:ss', () => {
    expect(formatClock(0)).toBe('00:00')
    expect(formatClock(5)).toBe('00:05')
    expect(formatClock(305)).toBe('05:05')
    expect(formatClock(3661)).toBe('1:01:01')
    expect(formatClock(-3)).toBe('00:00')
  })
})

describe('formatDuration', () => {
  it('renders compact durations', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(45)).toBe('45s')
    expect(formatDuration(1350)).toBe('22m')
    expect(formatDuration(3600)).toBe('1h')
    expect(formatDuration(5045)).toBe('1h 24m')
  })
})
