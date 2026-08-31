import type { EmailSettings } from '@kipple/shared'
import type { MailProvider } from './providers'

// Delivery state machine for one email_outbox row. The DB row is the source
// of truth (audit log); BullMQ is only the trigger, so re-processing a job
// is always safe.

export interface OutboxRecord {
  id: string
  to: string
  from: string
  fromName: string | null
  subject: string
  body: string
  replyTo: string | null
  messageId: string | null
  provider: string
  status: string
  error: string | null
  attempts: number
  sentAt: Date | null
}

export interface OutboxPatch {
  status?: string
  error?: string | null
  attempts?: number
  nextTryAt?: Date | null
  sentAt?: Date | null
}

export interface DeliverDeps {
  loadRow(outboxId: string): Promise<OutboxRecord | null>
  patchRow(outboxId: string, patch: OutboxPatch): Promise<void>
  loadSettings(): Promise<EmailSettings | null>
  createProvider(settings: EmailSettings): MailProvider
  now?(): Date
  maxAttempts?: number
  backoffMs?: (attempt: number) => number
}

export type DeliverResult =
  | { action: 'sent' }
  | { action: 'failed'; reason: string }
  | { action: 'retry'; nextTryAt: Date }
  | { action: 'skipped'; reason: string }

const DEFAULT_MAX_ATTEMPTS = 5
const DEFAULT_MAX_BACKOFF_MS = 3_600_000

export function defaultBackoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** (attempt - 1), DEFAULT_MAX_BACKOFF_MS)
}

// Auth failures and hard recipient rejections will not fix themselves on
// retry; everything else (connection refused, timeout, 4xx) is retried.
export function isPermanentMailError(error: unknown): boolean {
  const code = (error as { responseCode?: number } | null)?.responseCode
  if (code === 535 || code === 550 || code === 553 || code === 554) return true
  const message = error instanceof Error ? error.message : String(error)
  return /invalid login|authentication failed|authentication denied|bad password|5\.7\.\d/i.test(
    message,
  )
}

export async function deliverOutbox(
  outboxId: string,
  deps: DeliverDeps,
): Promise<DeliverResult> {
  const now = deps.now?.() ?? new Date()
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const backoffMs = deps.backoffMs ?? defaultBackoffMs

  const row = await deps.loadRow(outboxId)
  if (!row) return { action: 'skipped', reason: 'not_found' }
  if (row.status !== 'queued') return { action: 'skipped', reason: row.status }

  let settings: EmailSettings | null = null
  try {
    settings = await deps.loadSettings()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await deps.patchRow(outboxId, { status: 'failed', error: `settings: ${reason}` })
    return { action: 'failed', reason }
  }
  if (!settings?.smtp) {
    await deps.patchRow(outboxId, { status: 'failed', error: 'email_not_configured' })
    return { action: 'failed', reason: 'email_not_configured' }
  }

  let provider: MailProvider
  try {
    provider = deps.createProvider(settings)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await deps.patchRow(outboxId, { status: 'failed', error: `provider: ${reason}` })
    return { action: 'failed', reason }
  }

  const attempts = row.attempts + 1
  try {
    await provider.send({
      to: row.to,
      from: row.from,
      fromName: row.fromName ?? undefined,
      subject: row.subject,
      body: row.body,
      replyTo: row.replyTo ?? undefined,
      messageId: row.messageId ?? undefined,
    })
    await deps.patchRow(outboxId, { status: 'sent', attempts, error: null, sentAt: new Date() })
    return { action: 'sent' }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    if (isPermanentMailError(error) || attempts >= maxAttempts) {
      await deps.patchRow(outboxId, { status: 'failed', attempts, error: reason })
      return { action: 'failed', reason }
    }
    const nextTryAt = new Date(now.getTime() + backoffMs(attempts))
    await deps.patchRow(outboxId, { status: 'queued', attempts, error: reason, nextTryAt })
    return { action: 'retry', nextTryAt }
  }
}
