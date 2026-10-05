import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import pino from 'pino'
import {
  InboundSourceConfig,
  InboundWebhooksSettings,
  NMS_SOURCES,
  decryptAtRest,
  encryptAtRest,
  type NmsSource,
  type NormalizedNmsAlert,
} from '@kipple/shared'
import { ticketAliasAddress } from '@kipple/mail'
import { logAudit } from './audit'
import { db } from './db'
import { alertSignatures, settings, tickets, updates } from './db/schema'
import { PARSERS } from './inbound-parsers'
import { loadEmailSettings } from './mail'

const log = pino({ name: 'inbound-webhooks' })

// Instance settings key for inbound NMS config: the default client inbound
// alerts create tickets for, plus per-source { enabled, secret } (secret is
// enc1: ciphertext at rest, '' = not generated yet).
const SETTINGS_KEY = 'webhooks_inbound'

function authSecret(): string {
  const secret = process.env.AUTH_SECRET
  if (!secret) throw new Error('AUTH_SECRET is required to encrypt inbound webhook secrets')
  return secret
}

async function readSettings(): Promise<InboundWebhooksSettings> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, SETTINGS_KEY))
  const parsed = InboundWebhooksSettings.safeParse(row?.value)
  return parsed.success ? parsed.data : InboundWebhooksSettings.parse({})
}

async function writeSettings(
  mutate: (next: InboundWebhooksSettings) => void,
): Promise<InboundWebhooksSettings> {
  const current = await readSettings()
  const next: InboundWebhooksSettings = { ...current }
  mutate(next)
  const normalized = InboundWebhooksSettings.parse(next)
  await db
    .insert(settings)
    .values({ key: SETTINGS_KEY, value: normalized })
    .onConflictDoUpdate({ target: settings.key, set: { value: normalized } })
  return normalized
}

export async function loadInboundSettings(): Promise<InboundWebhooksSettings> {
  return readSettings()
}

export function inboundUrl(source: NmsSource, secret: string): string {
  return `${process.env.PUBLIC_URL ?? ''}/api/webhooks/inbound/${source}/${secret}`
}

export interface InboundSourceView {
  source: NmsSource
  enabled: boolean
  // Full URL to hand to the vendor. null while the source is disabled or
  // before a secret exists (nothing to hand out).
  url: string | null
}

function viewFor(source: NmsSource, config: InboundSourceConfig | undefined): InboundSourceView {
  const enabled = config?.enabled === true
  let url: string | null = null
  if (enabled && config?.secret) {
    try {
      const secret = decryptAtRest(config.secret, authSecret())
      if (secret) url = inboundUrl(source, secret)
    } catch {
      // Undecryptable secret (AUTH_SECRET rotated) — no URL to hand out;
      // a rotation recovers the source.
      url = null
    }
  }
  return { source, enabled, url }
}

// Panel view: every source with its enabled flag and the full vendor URL
// (the secret is decrypted here only to build the URL — it is never
// returned on its own).
export async function describeInboundWebhooks(): Promise<InboundSourceView[]> {
  const current = await readSettings()
  return NMS_SOURCES.map((source) => viewFor(source, current[source]))
}

export async function enableInboundSource(
  source: string,
  enabled: boolean,
  actorId: string,
): Promise<InboundSourceView | null> {
  if (!NMS_SOURCES.includes(source as NmsSource)) return null
  const key = source as NmsSource
  const current = await readSettings()
  const nextConfig: InboundSourceConfig = { enabled, secret: current[key]?.secret ?? '' }
  if (enabled && !nextConfig.secret) {
    // 32 random bytes, hex — generated on first enable, stored enc1: like
    // the outbound webhook secrets. Disabling keeps the stored secret so
    // re-enabling restores the same URL (rotation is explicit).
    nextConfig.secret = encryptAtRest(randomBytes(16).toString('hex'), authSecret())
  }
  const updated = await writeSettings((next) => {
    next[key] = nextConfig
  })
  await logAudit(actorId, `webhooks_inbound.${key}`, 'inbound_webhook', key, { enabled })
  return viewFor(key, updated[key])
}

// Rotation mints a fresh secret AND enables the source, so the returned URL
// is always usable — the old secret stops working immediately.
export async function rotateInboundSource(
  source: string,
  actorId: string,
): Promise<InboundSourceView | null> {
  if (!NMS_SOURCES.includes(source as NmsSource)) return null
  const key = source as NmsSource
  const secret = randomBytes(16).toString('hex')
  const updated = await writeSettings((next) => {
    next[key] = { enabled: true, secret: encryptAtRest(secret, authSecret()) }
  })
  await logAudit(actorId, `webhooks_inbound.${key}`, 'inbound_webhook', key, { rotate: true })
  return viewFor(key, updated[key])
}

export async function setDefaultInboundClient(
  clientId: string | null,
  actorId: string,
): Promise<InboundWebhooksSettings> {
  const updated = await writeSettings((next) => {
    next.defaultClientId = clientId
  })
  await logAudit(actorId, 'webhooks_inbound.default_client', 'inbound_webhook', 'default_client', {
    clientId,
  })
  return updated
}

// -------------------------------------------------------------------
// Vendor endpoint logic. The route is unauthenticated: the per-source
// secret in the URL path is the credential. No body HMAC, no timestamp,
// no replay window (documented ceiling — see docs/DEPLOYMENT.md).

export type InboundTicketStatus = 'created' | 'updated' | 'closed' | 'noop'

export interface InboundOutcome {
  status: InboundTicketStatus
  ticketId: string | null
  number: number | null
}

export type VendorResult =
  | { kind: 'unknown_source' }
  | { kind: 'unauthorized' }
  | { kind: 'bad_payload' }
  | { kind: 'no_default_client' }
  | ({ kind: 'handled' } & InboundOutcome)

// Constant-time comparison. On a length mismatch the same-length dummy
// compare keeps the two paths timing-uniform.
export function secretsEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.length !== b.length) {
    const size = Math.max(a.length, b.length)
    timingSafeEqual(Buffer.alloc(size), Buffer.alloc(size))
    return false
  }
  return timingSafeEqual(a, b)
}

// The vendor route hands over the RAW body (JSON or form-encoded —
// UptimeRobot posts form params). JSON first, URLSearchParams fallback.
export function parseInboundBody(rawBody: string): Record<string, unknown> {
  const text = (rawBody ?? '').trim()
  if (!text) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return {}
  } catch {
    const record: Record<string, unknown> = {}
    for (const [key, value] of new URLSearchParams(text)) record[key] = value
    return record
  }
}

export async function handleVendorAlert(
  source: string,
  providedSecret: string,
  rawBody: string,
): Promise<VendorResult> {
  if (!NMS_SOURCES.includes(source as NmsSource)) return { kind: 'unknown_source' }
  const key = source as NmsSource
  const current = await readSettings()
  const config = current[key]
  let expectedSecret = ''
  if (config?.secret) {
    try {
      expectedSecret = decryptAtRest(config.secret, authSecret())
    } catch {
      expectedSecret = ''
    }
  }
  // "disabled source", "no secret", and "wrong secret" all answer the same
  // generic 401 — no oracle about which sources exist or are enabled.
  if (config?.enabled !== true || !expectedSecret || !secretsEqual(providedSecret, expectedSecret)) {
    return { kind: 'unauthorized' }
  }
  const alert = PARSERS[key](parseInboundBody(rawBody))
  if (!alert) return { kind: 'bad_payload' }
  const clientId = current.defaultClientId ?? null
  if (!clientId) return { kind: 'no_default_client' }
  const outcome = await processNmsAlert(alert, clientId)
  return { kind: 'handled', ...outcome }
}

async function appendAlertUpdate(ticketId: string, alert: NormalizedNmsAlert): Promise<void> {
  const body = [
    `NMS alert (${alert.source}): ${alert.name} is ${alert.state === 'down' ? 'DOWN' : 'UP'}`,
    alert.message,
    alert.url ? `Source: ${alert.url}` : undefined,
  ]
    .filter((line): line is string => typeof line === 'string' && line !== '')
    .join('\n\n')
  await db.insert(updates).values({
    id: randomUUID(),
    ticketId,
    authorId: null,
    kind: 'public',
    body,
  })
}

// Episode state machine. Signature = (source, targetId): the vendor's stable
// identity for the monitored object. A repeat DOWN updates the open ticket
// (fresh update, re-open if it was since closed) and never creates a second
// ticket; an UP closes the open ticket; anything else is a noop.
// Inbound-created tickets fire no email, no notifications, and no outbound
// webhook fan-out (AGENTS: nothing auto-sends — and fanning out could loop
// the vendor's alert back into Kipple).
export async function processNmsAlert(
  alert: NormalizedNmsAlert,
  clientId: string,
): Promise<InboundOutcome> {
  const now = new Date()
  const [sigRow] = await db
    .select()
    .from(alertSignatures)
    .where(
      and(
        eq(alertSignatures.source, alert.source),
        eq(alertSignatures.signature, alert.targetId),
      ),
    )
  let ticket: typeof tickets.$inferSelect | null = null
  if (sigRow) {
    const [found] = await db.select().from(tickets).where(eq(tickets.id, sigRow.ticketId))
    if (found && found.status !== 'deleted') ticket = found
  }

  if (alert.state === 'down') {
    if (sigRow && sigRow.state === 'open' && ticket) {
      await appendAlertUpdate(ticket.id, alert)
      if (ticket.status === 'closed') {
        await db.update(tickets).set({ status: 'open' }).where(eq(tickets.id, ticket.id))
      }
      await db
        .update(alertSignatures)
        .set({ lastSeenAt: now })
        .where(eq(alertSignatures.id, sigRow.id))
      log.info(
        { ticketId: ticket.id, source: alert.source, targetId: alert.targetId },
        'repeat NMS alert updated the open ticket',
      )
      return { status: 'updated', ticketId: ticket.id, number: ticket.number }
    }
    const [created] = await db
      .insert(tickets)
      .values({
        id: randomUUID(),
        clientId,
        subject: `[${alert.source}] ${alert.name} is down`,
        priority: alert.severity ?? 'normal',
        createdBy: null,
        tags: [`nms:${alert.source}`],
      })
      .returning()
    // Alias the ticket so a human reply from a mailbox can find it (same
    // seam as inbound email — NMS tickets are first-class tickets).
    const alias = ticketAliasAddress(created.number, (await loadEmailSettings())?.domain ?? 'kipple.local')
    await db.update(tickets).set({ alias }).where(eq(tickets.id, created.id))
    await appendAlertUpdate(created.id, alert)
    await db
      .insert(alertSignatures)
      .values({
        id: randomUUID(),
        source: alert.source,
        signature: alert.targetId,
        ticketId: created.id,
        state: 'open',
      })
      .onConflictDoUpdate({
        target: [alertSignatures.source, alertSignatures.signature],
        set: { ticketId: created.id, state: 'open', lastSeenAt: now },
      })
    await logAudit(null, 'nms.inbound.created', 'ticket', created.id, {
      source: alert.source,
      targetId: alert.targetId,
      number: created.number,
    })
    log.info({ ticketId: created.id, source: alert.source }, 'NMS alert created a ticket')
    return { status: 'created', ticketId: created.id, number: created.number }
  }

  // state === 'up'
  if (sigRow && sigRow.state === 'open' && ticket) {
    await appendAlertUpdate(ticket.id, alert)
    await db.update(tickets).set({ status: 'closed' }).where(eq(tickets.id, ticket.id))
    await db
      .update(alertSignatures)
      .set({ state: 'closed', lastSeenAt: now })
      .where(eq(alertSignatures.id, sigRow.id))
    await logAudit(null, 'nms.inbound.closed', 'ticket', ticket.id, {
      source: alert.source,
      targetId: alert.targetId,
      number: ticket.number,
    })
    log.info({ ticketId: ticket.id, source: alert.source }, 'NMS recovery closed the ticket')
    return { status: 'closed', ticketId: ticket.id, number: ticket.number }
  }
  return { status: 'noop', ticketId: null, number: null }
}
