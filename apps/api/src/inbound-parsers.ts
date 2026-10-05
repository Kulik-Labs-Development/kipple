import type { NmsSource, NormalizedNmsAlert } from '@kipple/shared'

// Inbound NMS parsers: each maps a vendor payload to the normalized alert
// shape. A parser returns null when the payload is not a recognizable
// down/up alert for that source (the route then answers 400). Parsers are
// pure — the route owns secret checking, dedupe, and ticket writes.
//
// Vendor-shape provenance (see docs/DEPLOYMENT.md for the full recipes):
//   kuma          — Uptime Kuma default webhook body (source-verified from
//                   the uptime-kuma repo: heartbeat {status, monitorID, msg}
//                   + monitor {name, url}).
//   uptimerobot   — UptimeRobot default notification variables (monitorID,
//                   alertType 1=down/2=up/3=SSL, monitorFriendlyName, ...),
//                   delivered as form-encoded POST params or JSON.
//   onlineornot   — OnlineOrNot webhook JSON (event "uptime.down"/"up" /
//                   "heartbeat.down"/"up", name, url, alert_priority).
//   zabbix        — contract (Zabbix webhooks are user-script driven): the
//                   documented JSON built from Zabbix event macros.
//   prtg          — contract (PRTG has no native JSON alert webhook): the
//                   documented JSON built from PRTG notification macros.
//   watcher       — contract: a minimal documented JSON (target/name/status).
//   custom        — fully generic documented JSON (target/name/status/...).

type Severity = NonNullable<NormalizedNmsAlert['severity']>

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return null
}

function str(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value
  return null
}

function numToStr(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return str(value)
}

// Down/up detection helpers ------------------------------------------------

// 'down' = alerting, 'up' = recovery, null = ignore this payload.
function stateFromWords(raw: string | null, down: string[], up: string[]): 'down' | 'up' | null {
  if (!raw) return null
  const value = raw.toLowerCase()
  if (down.includes(value)) return 'down'
  if (up.includes(value)) return 'up'
  return null
}

function severityFromWord(raw: string | null, table: Record<string, Severity>): Severity | undefined {
  if (!raw) return undefined
  return table[raw.toLowerCase()]
}

// --- kuma ------------------------------------------------------------------

// heartbeat.status: 0 = DOWN, 1 = UP, 2 = PENDING, 3 = MAINTENANCE. Pending /
// maintenance are not actionable ticket transitions, so they return null.
export function parseKuma(body: unknown): NormalizedNmsAlert | null {
  const o = asRecord(body)
  if (!o) return null
  const heartbeat = asRecord(o.heartbeat)
  if (!heartbeat) return null
  const state =
    heartbeat.status === 0 ? 'down' : heartbeat.status === 1 ? 'up' : null
  if (!state) return null
  const monitorId = numToStr(heartbeat.monitorID)
  if (!monitorId) return null
  const monitor = asRecord(o.monitor) ?? {}
  return {
    source: 'kuma',
    targetId: monitorId,
    name: str(monitor.name) ?? `Monitor ${monitorId}`,
    state,
    message: str(heartbeat.msg) ?? undefined,
    url: str(monitor.url) ?? undefined,
  }
}

// --- uptimerobot ------------------------------------------------------------

// alertType: 1 = down, 2 = up, 3 = SSL & domain expiry (an alert → down).
export function parseUptimerobot(body: unknown): NormalizedNmsAlert | null {
  const o = asRecord(body)
  if (!o) return null
  const alertType = numToStr(o.alertType)
  const state = alertType === '1' ? 'down' : alertType === '2' ? 'up' : alertType === '3' ? 'down' : null
  if (!state) return null
  const monitorId = numToStr(o.monitorID)
  if (!monitorId) return null
  return {
    source: 'uptimerobot',
    targetId: monitorId,
    name: str(o.monitorFriendlyName) ?? `Monitor ${monitorId}`,
    state,
    message: str(o.alertDetails) ?? undefined,
    url: str(o.monitorURL) ?? undefined,
  }
}

// --- onlineornot -------------------------------------------------------------

// event: "uptime.down" | "uptime.up" | "heartbeat.down" | "heartbeat.up"
// (status_page.incident.* is out of scope for ticketing). Heartbeats carry a
// stable id; uptime checks do not, so the url is the stable target there.
export function parseOnlineornot(body: unknown): NormalizedNmsAlert | null {
  const o = asRecord(body)
  if (!o) return null
  const event = str(o.event)
  if (!event) return null
  let state: 'down' | 'up' | null = null
  if (event.endsWith('.down')) state = 'down'
  else if (event.endsWith('.up')) state = 'up'
  if (!state) return null
  const targetId = str(o.id) ?? str(o.url)
  if (!targetId) return null
  return {
    source: 'onlineornot',
    targetId,
    name: str(o.name) ?? targetId,
    state,
    url: str(o.url) ?? undefined,
    severity: severityFromWord(str(o.alert_priority), {
      critical: 'urgent',
      high: 'high',
      medium: 'normal',
      low: 'low',
    }),
  }
}

// --- zabbix (contract) -------------------------------------------------------

// Zabbix has no fixed webhook body — the user's script decides. The contract
// (documented in DEPLOYMENT.md) is a JSON built from Zabbix macros:
//   { "event": { "id", "status": 0=PROBLEM | 1=RESOLVED },
//     "host":  { "name" }, "trigger": { "id", "name" }, "severity": "..." }
// A stable target prefers the trigger id; without one it falls back to
// host:trigger name.
export function parseZabbix(body: unknown): NormalizedNmsAlert | null {
  const o = asRecord(body)
  if (!o) return null
  const ev = asRecord(o.event)
  const host = asRecord(o.host)
  const trigger = asRecord(o.trigger)
  const status = ev?.status ?? o.eventStatus ?? o.status
  const state = status === 0 || status === '0' ? 'down' : status === 1 || status === '1' ? 'up' : null
  if (!state) return null
  const hostName = str(host?.name) ?? str(o.hostName)
  const triggerName = str(trigger?.name) ?? str(o.triggerName)
  const triggerId = numToStr(trigger?.id ?? o.triggerId)
  let targetId: string
  if (triggerId) targetId = triggerId
  else if (hostName && triggerName) targetId = `${hostName}:${triggerName}`
  else return null
  return {
    source: 'zabbix',
    targetId,
    name: triggerName ?? hostName ?? targetId,
    state,
    message: str(o.message) ?? str(o.description) ?? undefined,
    severity: severityFromWord(str(o.severity), {
      disaster: 'urgent',
      high: 'high',
      average: 'normal',
      warning: 'normal',
      information: 'low',
      'not classified': 'normal',
    }),
  }
}

// --- prtg (contract) ----------------------------------------------------------

// PRTG has no native JSON alert webhook; the contract (documented in
// DEPLOYMENT.md) is a JSON built from PRTG notification macros:
//   { "objectid", "objectname", "state": "Up"|"Down"|"Error",
//     "checkmessage", "mapUrl" }
// "Error" is treated as an alerting state.
export function parsePrtg(body: unknown): NormalizedNmsAlert | null {
  const o = asRecord(body)
  if (!o) return null
  const objectId = numToStr(o.objectid ?? o.objectId)
  if (!objectId) return null
  const state = stateFromWords(str(o.state), ['down', 'error'], ['up'])
  if (!state) return null
  return {
    source: 'prtg',
    targetId: objectId,
    name: str(o.objectname ?? o.objectName) ?? `PRTG object ${objectId}`,
    state,
    message: str(o.checkmessage) ?? undefined,
    url: str(o.mapUrl) ?? str(o.link) ?? undefined,
  }
}

// --- watcher (contract) ---------------------------------------------------------

// Minimal documented JSON: { "target" (stable id), "name", "status", ... }.
export function parseWatcher(body: unknown): NormalizedNmsAlert | null {
  const o = asRecord(body)
  if (!o) return null
  const targetId = str(o.target) ?? str(o.id)
  if (!targetId) return null
  const state = stateFromWords(str(o.status), ['down', 'alerting', 'critical'], [
    'up',
    'resolved',
    'ok',
  ])
  if (!state) return null
  return {
    source: 'watcher',
    targetId,
    name: str(o.name) ?? targetId,
    state,
    message: str(o.message) ?? undefined,
    url: str(o.url) ?? undefined,
  }
}

// --- custom ---------------------------------------------------------------------

// Fully generic documented JSON: { "target", "status", "name"?, "severity"?,
// "message"?, "url"? }. This is the escape hatch for any monitor that can POST
// JSON.
export function parseCustom(body: unknown): NormalizedNmsAlert | null {
  const o = asRecord(body)
  if (!o) return null
  const targetId = str(o.target) ?? str(o.id)
  if (!targetId) return null
  const state = stateFromWords(str(o.status), ['down', 'alerting'], ['up', 'resolved'])
  if (!state) return null
  return {
    source: 'custom',
    targetId,
    name: str(o.name) ?? targetId,
    state,
    message: str(o.message) ?? undefined,
    url: str(o.url) ?? undefined,
    severity: severityFromWord(str(o.severity), {
      critical: 'urgent',
      urgent: 'urgent',
      high: 'high',
      normal: 'normal',
      medium: 'normal',
      low: 'low',
    }),
  }
}

export const PARSERS: Record<NmsSource, (body: unknown) => NormalizedNmsAlert | null> = {
  kuma: parseKuma,
  uptimerobot: parseUptimerobot,
  onlineornot: parseOnlineornot,
  zabbix: parseZabbix,
  prtg: parsePrtg,
  watcher: parseWatcher,
  custom: parseCustom,
}
