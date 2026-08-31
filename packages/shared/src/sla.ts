import { z } from 'zod'

// SLA core (PLAN item 10). Pure business-hours math so the api, worker tick,
// and web countdown all agree. All targets are BUSINESS minutes; the
// instance's business-hours config (timezone + per-day windows) decides
// which wall-clock minutes count.

export const SLA_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
export type SlaPriority = (typeof SLA_PRIORITIES)[number]

export const SLA_AT_RISK_FRACTION = 0.25

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/

export const BusinessWindow = z.object({
  // 1 = Monday ... 7 = Sunday
  day: z.number().int().min(1).max(7),
  start: z.string().refine((value) => TIME.test(value), 'HH:MM expected'),
  end: z.string().refine((value) => TIME.test(value), 'HH:MM expected'),
})
export type BusinessWindow = z.infer<typeof BusinessWindow>

export const BusinessHours = z.object({
  timezone: z.string().min(1),
  windows: z
    .array(BusinessWindow)
    .min(1)
    .max(7)
    .refine(
      (windows) => new Set(windows.map((w) => w.day)).size === windows.length,
      'one window per day',
    ),
})
export type BusinessHours = z.infer<typeof BusinessHours>

export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  timezone: 'UTC',
  windows: [1, 2, 3, 4, 5].map((day) => ({ day, start: '09:00', end: '17:00' })),
}

const MAX_TARGET_MINUTES = 90 * 24 * 60

const targetMinutes = z.number().int().min(5).max(MAX_TARGET_MINUTES)
const targetSet = z.object({
  low: targetMinutes,
  normal: targetMinutes,
  high: targetMinutes,
  urgent: targetMinutes,
})

export const SlaTargets = z.object({
  responseMinutes: targetSet,
  resolveMinutes: targetSet,
})
export type SlaTargets = z.infer<typeof SlaTargets>

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const formatterCache = new Map<string, Intl.DateTimeFormat>()

function wallClock(date: Date, timeZone: string): { day: number; minutes: number } {
  let format = formatterCache.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    formatterCache.set(timeZone, format)
  }
  let day = 0
  let hour = 0
  let minute = 0
  for (const part of format.formatToParts(date)) {
    if (part.type === 'weekday') {
      const idx = WEEKDAYS.indexOf(part.value)
      day = idx === 0 ? 7 : idx // ISO: 1=Monday .. 7=Sunday
    } else if (part.type === 'hour') hour = part.value === '24' ? 0 : Number(part.value)
    else if (part.type === 'minute') minute = Number(part.value)
  }
  return { day, minutes: hour * 60 + minute }
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':')
  return Number(h) * 60 + Number(m)
}

const MINUTE_MS = 60_000

// A whole minute [m, m+1) is counted as elapsed when it overlaps the range
// by at least half a minute, so boundaries are exact for minute-aligned
// instants (which all due times are) and `now` is rounded at the 30s mark.
function countsIn(fromMs: number, toMs: number, minuteStartMs: number, hours: BusinessHours) {
  const overlap = Math.min(toMs, minuteStartMs + MINUTE_MS) - Math.max(fromMs, minuteStartMs)
  if (overlap < MINUTE_MS / 2) return false
  return isBusinessMinute(new Date(minuteStartMs + MINUTE_MS / 2), hours)
}

export function isBusinessMinute(date: Date, hours: BusinessHours): boolean {
  const { day, minutes } = wallClock(date, hours.timezone)
  for (const window of hours.windows) {
    if (window.day !== day) continue
    if (minutes >= toMinutes(window.start) && minutes < toMinutes(window.end)) return true
  }
  return false
}

// Business minutes elapsed in [from, to]. 0 when to <= from. Minute stepping
// keeps DST transitions exact.
export function businessMinutesBetween(from: Date, to: Date, hours: BusinessHours): number {
  const fromMs = from.getTime()
  const toMs = to.getTime()
  if (toMs <= fromMs) return 0
  let count = 0
  const first = Math.floor(fromMs / MINUTE_MS) * MINUTE_MS
  const last = Math.floor((toMs - 1) / MINUTE_MS) * MINUTE_MS
  for (let m = first; m <= last; m += MINUTE_MS) {
    if (countsIn(fromMs, toMs, m, hours)) count++
  }
  return count
}

// The smallest t with businessMinutesBetween(from, t) >= minutes. Minute
// stepping keeps DST transitions exact.
export function addBusinessMinutes(from: Date, minutes: number, hours: BusinessHours): Date {
  const target = Math.max(0, Math.round(minutes))
  if (target === 0) return new Date(from.getTime())
  const fromMs = from.getTime()
  let count = 0
  let m = Math.floor(fromMs / MINUTE_MS) * MINUTE_MS
  while (count < target) {
    m += MINUTE_MS
    if (countsIn(fromMs, m, m - MINUTE_MS, hours)) count++
  }
  return new Date(m)
}
