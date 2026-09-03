import { DEFAULT_BUSINESS_HOURS } from '@kipple/shared/sla'
import { describe, expect, it } from 'vitest'
import type { TicketRow } from './api'
import { formatRemainingMinutes, queueSlaState, slaRemainingMinutes } from './sla'

function ticket(overrides: Partial<TicketRow>): TicketRow {
  return {
    id: 't1',
    number: 1,
    clientId: 'c1',
    alias: null,
    subject: 'x',
    status: 'open',
    priority: 'normal',
    assignedTo: null,
    tags: [],
    createdAt: '2026-08-31T10:00:00.000Z',
    updatedAt: '2026-08-31T10:00:00.000Z',
    slaPolicyId: null,
    slaResponseDueAt: null,
    slaResolveDueAt: null,
    slaResponseAt: null,
    slaResolvedAt: null,
    slaResponseState: 'pending',
    slaResolveState: 'pending',
    holdOn: null,
    holdSince: null,
    ...overrides,
  }
}

describe('queueSlaState', () => {
  it('returns null for closed or SLA-less tickets', () => {
    expect(queueSlaState(ticket({}))).toBeNull()
    expect(
      queueSlaState(
        ticket({
          status: 'closed',
          slaResponseDueAt: '2026-08-31T12:00:00.000Z',
          slaResponseState: 'breached',
        }),
      ),
    ).toBeNull()
  })

  it('ranks breached over at_risk over pending', () => {
    const withDue = {
      slaResponseDueAt: '2026-08-31T12:00:00.000Z',
      slaResolveDueAt: '2026-08-31T18:00:00.000Z',
    }
    expect(
      queueSlaState(ticket({ ...withDue, slaResolveState: 'at_risk', slaResponseState: 'breached' })),
    ).toBe('breached')
    expect(
      queueSlaState(ticket({ ...withDue, slaResolveState: 'at_risk', slaResponseState: 'met' })),
    ).toBe('at_risk')
    expect(queueSlaState(ticket(withDue))).toBe('pending')
  })
})

describe('slaRemainingMinutes', () => {
  it('is null without a due time and clamps at 0', () => {
    expect(slaRemainingMinutes(null, DEFAULT_BUSINESS_HOURS)).toBeNull()
    const past = new Date('2026-08-31T09:00:00.000Z')
    expect(
      slaRemainingMinutes('2026-08-31T08:00:00.000Z', DEFAULT_BUSINESS_HOURS, past),
    ).toBe(0)
  })

  it('counts business minutes', () => {
    const now = new Date('2026-08-31T14:00:00.000Z')
    expect(slaRemainingMinutes('2026-08-31T16:30:00.000Z', DEFAULT_BUSINESS_HOURS, now)).toBe(150)
  })
})

describe('formatRemainingMinutes', () => {
  it('formats days, hours, and minutes', () => {
    expect(formatRemainingMinutes(0)).toBe('due')
    expect(formatRemainingMinutes(45)).toBe('45m')
    expect(formatRemainingMinutes(180)).toBe('3h')
    expect(formatRemainingMinutes(200)).toBe('3h 20m')
    expect(formatRemainingMinutes(1440)).toBe('1d')
    expect(formatRemainingMinutes(1440 * 2 + 120)).toBe('2d 2h')
  })
})
