import { createHmac, randomBytes, randomUUID } from 'node:crypto'
import { Queue } from 'bullmq'
import { desc, eq } from 'drizzle-orm'
import pino from 'pino'
import {
  WEBHOOKS_DELIVER_QUEUE,
  WebhookCreate,
  WebhookUpdate,
  decryptAtRest,
  encryptAtRest,
  type RuleEventName,
} from '@kipple/shared'
import { logAudit } from './audit'
import { db } from './db'
import { webhookDeliveries, webhooks } from './db/schema'
import type { RuleEvent, RuleTicketSnapshot } from './rules'

const log = pino({ name: 'webhooks' })

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379'

let queuePromise: Promise<Queue> | null = null

function getQueue(): Promise<Queue> {
  queuePromise ??= Promise.resolve(
    new Queue(WEBHOOKS_DELIVER_QUEUE, { connection: { url: redisUrl } }),
  )
  return queuePromise
}

export async function closeWebhooks(): Promise<void> {
  if (!queuePromise) return
  const queue = await queuePromise
  queuePromise = null
  await queue.close()
}

function authSecret(): string {
  const secret = process.env.AUTH_SECRET
  if (!secret) throw new Error('AUTH_SECRET is required to encrypt webhook secrets')
  return secret
}

// HMAC-SHA256 over the RAW body string, hex. The receiver recomputes the
// digest over the bytes it received and compares against the header — the
// payload string and the wire bytes must be identical, which they are (the
// delivery row's payload IS the body sent on the wire).
export function signWebhookBody(secret: string, rawBody: string): string {
  return createHmac('sha256', secret).update(rawBody).digest('hex')
}

// Masked view: the ciphertext never leaves the DB, so the API only reports
// that a secret exists (same contract as the mail settings masking).
export type WebhookView = Omit<typeof webhooks.$inferSelect, 'secret'> & {
  hasSecret: boolean
}

export function toWebhookView(row: typeof webhooks.$inferSelect): WebhookView {
  const { secret: _secret, ...rest } = row
  return { ...rest, hasSecret: true }
}

export async function listWebhooks(): Promise<WebhookView[]> {
  const rows = await db.select().from(webhooks).orderBy(webhooks.createdAt)
  return rows.map(toWebhookView)
}

export async function createWebhook(input: WebhookCreate, actorId: string) {
  // Runtime-generated secret: 32 random bytes, hex. Stored enc1: at rest.
  const secret = randomBytes(32).toString('hex')
  const [row] = await db
    .insert(webhooks)
    .values({
      id: randomUUID(),
      url: input.url,
      events: [...new Set(input.events)],
      enabled: input.enabled,
      secret: encryptAtRest(secret, authSecret()),
    })
    .returning()
  await logAudit(actorId, 'webhook.create', 'webhook', row.id, { url: row.url, events: row.events })
  return toWebhookView(row)
}

export async function updateWebhook(
  id: string,
  input: WebhookUpdate,
  actorId: string,
): Promise<WebhookView | null> {
  const [row] = await db
    .update(webhooks)
    .set({
      url: input.url,
      events: input.events ? [...new Set(input.events)] : undefined,
      enabled: input.enabled,
    })
    .where(eq(webhooks.id, id))
    .returning()
  if (!row) return null
  await logAudit(actorId, 'webhook.update', 'webhook', id, {
    url: input.url ?? undefined,
    events: input.events ?? undefined,
    enabled: input.enabled ?? undefined,
  })
  return toWebhookView(row)
}

export async function deleteWebhook(id: string, actorId: string): Promise<boolean> {
  const [row] = await db.delete(webhooks).where(eq(webhooks.id, id)).returning()
  if (!row) return false
  await logAudit(actorId, 'webhook.delete', 'webhook', id, { url: row.url })
  return true
}

// -------------------------------------------------------------------
// Event emission + delivery queue (the DB row is the audit log; the
// BullMQ job is only the trigger, mirroring the email outbox).

// The payload shape sent to every subscriber (also the exact wire body).
export function buildWebhookPayload(event: {
  type: RuleEventName
  ticket: RuleTicketSnapshot
  fromStatus?: string
  actor: { id: string | null; name: string | null; role: string }
}): string {
  const body = {
    event: event.type,
    firedAt: new Date().toISOString(),
    ticket: event.ticket,
    fromStatus: event.fromStatus ?? null,
    actor: {
      id: event.actor.id,
      name: event.actor.name,
      role: event.actor.role,
      system: event.actor.id === null,
    },
  }
  return JSON.stringify(body)
}

// Fan a house ticket event out to every enabled webhook subscribed to it.
// Failures are logged, never thrown: a webhook blip must not break the main
// ticket flow (the delivery row stays queued and can be retried from the
// panel).
export async function emitWebhookEvents(event: RuleEvent): Promise<number> {
  const rows = await db.select().from(webhooks).where(eq(webhooks.enabled, true))
  const subscribers = rows.filter((row) => row.events.includes(event.type))
  if (subscribers.length === 0) return 0
  const payload = buildWebhookPayload(event)
  let enqueued = 0
  for (const row of subscribers) {
    const id = randomUUID()
    await db.insert(webhookDeliveries).values({
      id,
      webhookId: row.id,
      event: event.type,
      ticketId: event.ticket.id,
      payload,
    })
    try {
      await (await getQueue()).add(
        'deliver',
        { deliveryId: id },
        { removeOnComplete: true, removeOnFail: true },
      )
    } catch (error) {
      log.warn(
        { deliveryId: id, err: error instanceof Error ? error.message : error },
        'failed to enqueue webhook delivery; row left queued for manual retry',
      )
    }
    enqueued++
  }
  return enqueued
}

// One-off test ping from the panel (never a ticket event).
export async function testWebhook(id: string, actorId: string): Promise<string | null> {
  const [row] = await db.select().from(webhooks).where(eq(webhooks.id, id))
  if (!row) return null
  const payload = JSON.stringify({
    event: 'webhook.test',
    firedAt: new Date().toISOString(),
    message: 'Kipple webhook test ping',
  })
  const deliveryId = randomUUID()
  await db.insert(webhookDeliveries).values({
    id: deliveryId,
    webhookId: id,
    event: 'webhook.test',
    ticketId: null,
    payload,
  })
  try {
    await (await getQueue()).add(
      'deliver',
      { deliveryId },
      { removeOnComplete: true, removeOnFail: true },
    )
  } catch (error) {
    log.warn(
      { deliveryId, err: error instanceof Error ? error.message : error },
      'failed to enqueue webhook test ping',
    )
  }
  await logAudit(actorId, 'webhook.test_ping', 'webhook', id)
  return deliveryId
}

// -------------------------------------------------------------------
// Delivery state machine. Transient (5xx / timeout / network) = retry with
// exponential backoff 30s->1h, 5 attempts (house pattern). Permanent
// (any 4xx) = fail fast. 2xx = sent.

export type DeliveryOutcome =
  | { action: 'sent' }
  | { action: 'failed'; reason: string }
  | { action: 'retry'; nextTryAt: Date }
  | { action: 'skipped'; reason: string }

const DELIVERY_MAX_ATTEMPTS = 5
const DELIVERY_MAX_BACKOFF_MS = 3_600_000

export function deliveryBackoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** (attempt - 1), DELIVERY_MAX_BACKOFF_MS)
}

export function isPermanentWebhookError(status: number): boolean {
  // 4xx = the destination will keep rejecting; retrying changes nothing.
  // 5xx / network / timeout are transient.
  return status >= 400 && status < 500
}

export interface DeliverWebhookDeps {
  loadRow(deliveryId: string): Promise<(typeof webhookDeliveries.$inferSelect) | null>
  loadWebhook(webhookId: string): Promise<{ url: string; secret: string } | null>
  patchRow(
    deliveryId: string,
    patch: {
      status?: string
      error?: string | null
      attempts?: number
      nextTryAt?: Date | null
      sentAt?: Date | null
    },
  ): Promise<void>
  send(url: string, secret: string, rawBody: string): Promise<number>
  now?(): Date
  maxAttempts?: number
  backoffMs?: (attempt: number) => number
}

export async function deliverWebhook(deliveryId: string, deps: DeliverWebhookDeps): Promise<DeliveryOutcome> {
  const now = deps.now?.() ?? new Date()
  const maxAttempts = deps.maxAttempts ?? DELIVERY_MAX_ATTEMPTS
  const backoffMs = deps.backoffMs ?? deliveryBackoffMs

  const row = await deps.loadRow(deliveryId)
  if (!row) return { action: 'skipped', reason: 'not_found' }
  if (row.status !== 'queued') return { action: 'skipped', reason: row.status }

  const webhook = await deps.loadWebhook(row.webhookId)
  if (!webhook) {
    await deps.patchRow(deliveryId, { status: 'failed', error: 'webhook_secret_missing' })
    return { action: 'failed', reason: 'webhook_secret_missing' }
  }

  const attempts = row.attempts + 1
  let status: number
  try {
    status = await deps.send(webhook.url, webhook.secret, row.payload)
  } catch (error) {
    // network error / timeout / abort: transient, retry unless exhausted
    const reason = error instanceof Error ? error.message : String(error)
    if (attempts >= maxAttempts) {
      await deps.patchRow(deliveryId, { status: 'failed', attempts, error: reason })
      return { action: 'failed', reason }
    }
    const nextTryAt = new Date(now.getTime() + backoffMs(attempts))
    await deps.patchRow(deliveryId, { status: 'queued', attempts, error: reason, nextTryAt })
    return { action: 'retry', nextTryAt }
  }

  if (status >= 200 && status < 300) {
    await deps.patchRow(deliveryId, {
      status: 'sent',
      attempts,
      error: null,
      sentAt: new Date(),
    })
    return { action: 'sent' }
  }
  if (isPermanentWebhookError(status) || attempts >= maxAttempts) {
    await deps.patchRow(deliveryId, {
      status: 'failed',
      attempts,
      error: `endpoint responded ${status}`,
    })
    return { action: 'failed', reason: `endpoint responded ${status}` }
  }
  const nextTryAt = new Date(now.getTime() + backoffMs(attempts))
  await deps.patchRow(deliveryId, {
    status: 'queued',
    attempts,
    error: `endpoint responded ${status}`,
    nextTryAt,
  })
  return { action: 'retry', nextTryAt }
}

// Real transport: signed POST, 10s timeout (same bar as the rules-engine
// webhook action).
export async function sendSignedWebhook(url: string, secret: string, rawBody: string): Promise<number> {
  const signature = signWebhookBody(secret, rawBody)
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-kipple-signature': signature,
    },
    body: rawBody,
    signal: AbortSignal.timeout(10_000),
  })
  return res.status
}

export async function processWebhookDelivery(deliveryId: string): Promise<DeliveryOutcome> {
  const result = await deliverWebhook(deliveryId, {
    loadRow: async (id) => {
      const [row] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id))
      return row ?? null
    },
    loadWebhook: async (webhookId) => {
      const [row] = await db
        .select({ url: webhooks.url, secret: webhooks.secret })
        .from(webhooks)
        .where(eq(webhooks.id, webhookId))
      if (!row) return null
      try {
        return { url: row.url, secret: decryptAtRest(row.secret, authSecret()) }
      } catch {
        return null
      }
    },
    patchRow: async (id, patch) => {
      await db
        .update(webhookDeliveries)
        .set({
          status: patch.status,
          error: patch.error ?? null,
          attempts: patch.attempts,
          nextTryAt: patch.nextTryAt ?? null,
          sentAt: patch.sentAt ?? null,
        })
        .where(eq(webhookDeliveries.id, id))
      // Keep the webhook's last_* panel fields fresh.
      const [fresh] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id))
      if (fresh && (patch.status === 'sent' || patch.status === 'failed')) {
        await db
          .update(webhooks)
          .set({
            lastStatus: fresh.status,
            lastError: fresh.error,
            lastDeliveredAt: new Date(),
          })
          .where(eq(webhooks.id, fresh.webhookId))
      }
    },
    send: sendSignedWebhook,
  })
  if (result.action === 'retry') {
    const delay = Math.max(0, result.nextTryAt.getTime() - Date.now())
    try {
      await (await getQueue()).add('deliver', { deliveryId }, { delay, removeOnComplete: true })
    } catch (error) {
      log.warn(
        { deliveryId, err: error instanceof Error ? error.message : error },
        'failed to schedule webhook retry',
      )
    }
  }
  return result
}

export type DeliveryView = Omit<typeof webhookDeliveries.$inferSelect, 'payload'> & {
  payloadPreview: string
}

export function toDeliveryView(row: typeof webhookDeliveries.$inferSelect): DeliveryView {
  // The panel shows a preview, never the full payload (it may carry ticket
  // content).
  const { payload, ...rest } = row
  return { ...rest, payloadPreview: payload.slice(0, 280) }
}

export async function listDeliveries(opts: {
  webhookId?: string
  status?: string
  limit?: number
}): Promise<DeliveryView[]> {
  const limit = Math.min(opts.limit ?? 100, 500)
  const rows = await db
    .select()
    .from(webhookDeliveries)
    .where(
      opts.webhookId
        ? eq(webhookDeliveries.webhookId, opts.webhookId)
        : opts.status
          ? eq(webhookDeliveries.status, opts.status)
          : undefined,
    )
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(limit)
  return rows.map(toDeliveryView)
}

export async function retryDelivery(id: string, actorId: string): Promise<DeliveryView | null> {
  const [row] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id))
  if (!row) return null
  if (!['queued', 'failed'].includes(row.status)) return null
  const [updated] = await db
    .update(webhookDeliveries)
    .set({ status: 'queued', attempts: 0, error: null, nextTryAt: null })
    .where(eq(webhookDeliveries.id, id))
    .returning()
  try {
    await (await getQueue()).add(
      'deliver',
      { deliveryId: id },
      { removeOnComplete: true, removeOnFail: true },
    )
  } catch (error) {
    log.warn(
      { deliveryId: id, err: error instanceof Error ? error.message : error },
      'failed to re-enqueue webhook delivery',
    )
  }
  await logAudit(actorId, 'webhook.delivery_retry', 'webhook_delivery', id)
  return toDeliveryView(updated)
}
