import { describe, expect, it } from 'vitest'
import {
  DEFAULT_BUSINESS_HOURS,
  addBusinessMinutes,
  businessMinutesBetween,
  isBusinessMinute,
  type BusinessHours,
} from './sla'

// Reference: Mon-Fri 09:00-17:00 UTC (the default).
const hours = DEFAULT_BUSINESS_HOURS
const mon = (h: number, m = 0) => new Date(Date.UTC(2026, 7, 31, h, m)) // Mon 2026-08-31

describe('isBusinessMinute', () => {
  it('counts minutes inside windows, exclusive of the end', () => {
    expect(isBusinessMinute(mon(9, 0), hours)).toBe(true)
    expect(isBusinessMinute(mon(16, 59), hours)).toBe(true)
    expect(isBusinessMinute(mon(17, 0), hours)).toBe(false)
    expect(isBusinessMinute(mon(8, 59), hours)).toBe(false)
  })

  it('rejects weekends and nights', () => {
    const saturday = new Date(Date.UTC(2026, 7, 1, 12, 0))
    const sunday = new Date(Date.UTC(2026, 7, 2, 12, 0))
    expect(isBusinessMinute(saturday, hours)).toBe(false)
    expect(isBusinessMinute(sunday, hours)).toBe(false)
    expect(isBusinessMinute(mon(23, 0), hours)).toBe(false)
  })

  it('supports custom timezones and windows', () => {
    const berlin: BusinessHours = {
      timezone: 'Europe/Berlin',
      windows: [{ day: 1, start: '09:00', end: '17:00' }],
    }
    // Mon 2026-08-31 09:00 Berlin = 07:00 UTC (summer, UTC+2)
    expect(isBusinessMinute(new Date(Date.UTC(2026, 7, 31, 7, 0)), berlin)).toBe(true)
    expect(isBusinessMinute(new Date(Date.UTC(2026, 7, 31, 5, 0)), berlin)).toBe(false)
    // a Tuesday is outside a Monday-only policy
    expect(isBusinessMinute(new Date(Date.UTC(2026, 8, 1, 7, 0)), berlin)).toBe(false)
  })
})

describe('addBusinessMinutes', () => {
  it('stays in the day when it fits', () => {
    expect(addBusinessMinutes(mon(9, 0), 60, hours).toISOString()).toBe(mon(10, 0).toISOString())
  })

  it('spans days and skips weekends', () => {
    expect(addBusinessMinutes(mon(16, 0), 120, hours).toISOString()).toBe(
      new Date(Date.UTC(2026, 8, 1, 10, 0)).toISOString(), // Tue 10:00
    )
    expect(addBusinessMinutes(mon(16, 0), 60, hours).toISOString()).toBe(mon(17, 0).toISOString())
    // from end of business Friday Sep 4, the next business minute is Mon Sep 7 09:00
    const fridayEod = new Date(Date.UTC(2026, 8, 4, 17, 0))
    expect(addBusinessMinutes(fridayEod, 60, hours).toISOString()).toBe(
      new Date(Date.UTC(2026, 8, 7, 10, 0)).toISOString(), // Mon 10:00
    )
  })

  it('starts from the next business minute when starting out of hours', () => {
    expect(addBusinessMinutes(mon(17, 30), 60, hours).toISOString()).toBe(
      new Date(Date.UTC(2026, 8, 1, 10, 0)).toISOString(),
    )
    expect(addBusinessMinutes(mon(0, 0), 30, hours).toISOString()).toBe(mon(9, 30).toISOString())
  })

  it('does not move for zero or negative targets', () => {
    expect(addBusinessMinutes(mon(10, 0), 0, hours).toISOString()).toBe(mon(10, 0).toISOString())
    expect(addBusinessMinutes(mon(10, 0), -5, hours).toISOString()).toBe(mon(10, 0).toISOString())
  })
})

describe('businessMinutesBetween', () => {
  it('is 0 when to <= from', () => {
    expect(businessMinutesBetween(mon(10, 0), mon(9, 0), hours)).toBe(0)
    expect(businessMinutesBetween(mon(10, 0), mon(10, 0), hours)).toBe(0)
  })

  it('counts partial and full windows', () => {
    expect(businessMinutesBetween(mon(16, 0), mon(17, 0), hours)).toBe(60)
    expect(businessMinutesBetween(mon(17, 0), mon(17, 30), hours)).toBe(0)
    expect(businessMinutesBetween(mon(16, 30), new Date(Date.UTC(2026, 8, 1, 9, 30)), hours)).toBe(
      60, // 30 Mon + 30 Tue
    )
  })

  it('skips the weekend entirely', () => {
    const friday = new Date(Date.UTC(2026, 8, 4, 16, 0))
    const monday = new Date(Date.UTC(2026, 8, 7, 10, 0)) // Mon Sep 7 10:00
    expect(businessMinutesBetween(friday, monday, hours)).toBe(60 + 60)
  })

  it('round-trips with addBusinessMinutes', () => {
    for (const minutes of [1, 59, 480, 1000, 24 * 60 * 3]) {
      const from = mon(14, 37)
      const to = addBusinessMinutes(from, minutes, hours)
      expect(businessMinutesBetween(from, to, hours)).toBe(minutes)
    }
  })

  it('handles the European DST fall-back weekend', () => {
    // 2026-10-25 is the fall-back Sunday in Europe/Berlin; a full business
    // day on Monday 2026-10-26 is still 480 business minutes.
    const berlin: BusinessHours = {
      timezone: 'Europe/Berlin',
      windows: [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '17:00' })),
    }
    const monday = new Date('2026-10-26T09:00:00+01:00')
    const mondayEod = new Date('2026-10-26T17:00:00+01:00')
    const tuesday = new Date('2026-10-27T09:00:00+01:00')
    expect(businessMinutesBetween(monday, mondayEod, berlin)).toBe(480)
    expect(addBusinessMinutes(monday, 480, berlin).toISOString()).toBe(mondayEod.toISOString())
    // Monday 09:00 -> Tuesday 09:00 covers exactly the Monday business day
    expect(businessMinutesBetween(monday, tuesday, berlin)).toBe(480)
  })
})
