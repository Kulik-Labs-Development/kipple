import { randomUUID } from 'node:crypto'
import { Queue } from 'bullmq'
import pino from 'pino'
import {
  createSmtpProvider,
  deliverOutbox,
  type DeliverResult,
  type MailProvider,
} from '@kipple/mail'
import {
  EMAIL_OUTBOX_QUEUE,
  EmailSettings,
  StoredEmailSettings,
  decryptAtRest,
  encryptAtRest,
  isEncryptedValue,
} from '@kipple/shared'
import { desc, eq } from 'drizzle-orm'
import { logAudit } from './audit'
import { db } from './db'
import { contactClients, contacts, emailOutbox, settings } from './db/schema'

const log = pino({ name: 'mail' })

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379'

let queuePromise: Promise<Queue> | null = null

function getQueue(): Promise<Queue> {
  queuePromise ??= Promise.resolve(
    new Queue(EMAIL_OUTBOX_QUEUE, { connection: { url: redisUrl } }),
  )
  return queuePromise
}

export async function closeMail(): Promise<void> {
  if (!queuePromise) return
  const queue = await queuePromise
  queuePromise = null
  await queue.close()
}

function authSecret(): string {
  const secret = process.env.AUTH_SECRET
  if (!secret) throw new Error('AUTH_SECRET is required to encrypt email settings')
  return secret
}

// The stored settings carry the SMTP password ciphertext; the provider needs
// the plaintext, so loading always decrypts.
export async function loadStoredEmailSettings(): Promise<StoredEmailSettings | null> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, 'email'))
  if (!row) return null
  const parsed = StoredEmailSettings.safeParse(row.value)
  return parsed.success ? parsed.data : null
}

export async function loadEmailSettings(): Promise<EmailSettings | null> {
  const stored = await loadStoredEmailSettings()
  if (!stored) return null
  const smtp = stored.smtp
  if (!smtp?.auth?.password || !isEncryptedValue(smtp.auth.password)) return stored
  return {
    ...stored,
    smtp: {
      ...smtp,
      auth: { ...smtp.auth, password: decryptAtRest(smtp.auth.password, authSecret()) },
    },
  }
}

export async function saveEmailSettings(input: EmailSettings, actorId: string): Promise<void> {
  const value = {
    ...input,
    smtp: input.smtp
      ? {
          ...input.smtp,
          auth: input.smtp.auth
            ? {
                username: input.smtp.auth.username,
                password: input.smtp.auth.password
                  ? encryptAtRest(input.smtp.auth.password, authSecret())
                  : '',
              }
            : null,
        }
      : null,
  }
  await db
    .insert(settings)
    .values({ key: 'email', value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
  await logAudit(actorId, 'email.settings.update', 'setting', 'email', {
    host: input.smtp?.host ?? null,
    from: input.smtp?.from ?? null,
    hasAuth: Boolean(input.smtp?.auth?.username),
  })
}

// Masked view of the settings for the API: credentials never leave the DB.
export function describeEmailSettings(settingsValue: EmailSettings | null) {
  return {
    configured: Boolean(settingsValue?.smtp),
    domain: settingsValue?.domain ?? 'kipple.local',
    provider: settingsValue?.smtp ? settingsValue.provider : null,
    smtp: settingsValue?.smtp
      ? {
          host: settingsValue.smtp.host,
          port: settingsValue.smtp.port,
          secure: settingsValue.smtp.secure,
          startTls: settingsValue.smtp.startTls,
          from: settingsValue.smtp.from,
          fromName: settingsValue.smtp.fromName ?? '',
          hasAuth: Boolean(settingsValue.smtp.auth?.username),
        }
      : null,
  }
}

// Provider registry. Phase 1 ships generic SMTP; M365/Google land in Phase 2.
export function providerFromSettings(settingsValue: EmailSettings): MailProvider {
  if (!settingsValue.smtp) throw new Error('email_not_configured')
  switch (settingsValue.provider) {
    case 'smtp':
      return createSmtpProvider(settingsValue.smtp)
  }
}

export interface EnqueueOutboxInput {
  ticketId?: string | null
  to: string
  from: string
  fromName?: string | null
  subject: string
  body: string
  replyTo?: string | null
  messageId: string
}

// Persist the outbox row first (it is the audit log), then trigger the
// worker. If Redis is down the row stays queued and can be retried from the
// outbox log — no email is ever lost.
export async function enqueueOutbox(input: EnqueueOutboxInput): Promise<string> {
  const id = randomUUID()
  await db.insert(emailOutbox).values({
    id,
    ticketId: input.ticketId ?? null,
    to: input.to,
    from: input.from,
    fromName: input.fromName ?? null,
    subject: input.subject,
    body: input.body,
    replyTo: input.replyTo ?? null,
    messageId: input.messageId,
    provider: 'smtp',
  })
  try {
    await (await getQueue()).add(
      'deliver',
      { outboxId: id },
      { removeOnComplete: true, removeOnFail: true },
    )
  } catch (error) {
    log.warn(
      { outboxId: id, err: error instanceof Error ? error.message : error },
      'failed to enqueue outbox job; row left queued for manual retry',
    )
  }
  return id
}

export type OutboxRowView = Omit<typeof emailOutbox.$inferSelect, 'body'>

function toView(row: typeof emailOutbox.$inferSelect): OutboxRowView {
  const { body: _body, ...rest } = row
  return rest
}

export async function listOutbox(opts: {
  status?: string
  provider?: string
  limit: number
}): Promise<OutboxRowView[]> {
  const rows = await db
    .select()
    .from(emailOutbox)
    .where(
      opts.status
        ? eq(emailOutbox.status, opts.status)
        : opts.provider
          ? eq(emailOutbox.provider, opts.provider)
          : undefined,
    )
    .orderBy(desc(emailOutbox.createdAt))
    .limit(opts.limit)
  return rows.map(toView)
}

export async function retryOutbox(outboxId: string): Promise<OutboxRowView | null> {
  const [row] = await db.select().from(emailOutbox).where(eq(emailOutbox.id, outboxId))
  if (!row) return null
  if (!['queued', 'failed', 'bounced'].includes(row.status)) return null
  const [updated] = await db
    .update(emailOutbox)
    .set({ status: 'queued', attempts: 0, error: null, nextTryAt: null })
    .where(eq(emailOutbox.id, outboxId))
    .returning()
  try {
    await (await getQueue()).add(
      'deliver',
      { outboxId },
      { removeOnComplete: true, removeOnFail: true },
    )
  } catch (error) {
    log.warn(
      { outboxId, err: error instanceof Error ? error.message : error },
      'failed to re-enqueue outbox job',
    )
  }
  return toView(updated)
}

export async function processOutboxJob(outboxId: string): Promise<DeliverResult> {
  const result = await deliverOutbox(outboxId, {
    loadRow: async (id) => {
      const [row] = await db.select().from(emailOutbox).where(eq(emailOutbox.id, id))
      return row ?? null
    },
    patchRow: async (id, patch) => {
      await db
        .update(emailOutbox)
        .set({
          status: patch.status,
          error: patch.error ?? null,
          attempts: patch.attempts,
          nextTryAt: patch.nextTryAt ?? null,
          sentAt: patch.sentAt ?? null,
        })
        .where(eq(emailOutbox.id, id))
    },
    loadSettings: loadEmailSettings,
    createProvider: providerFromSettings,
  })
  if (result.action === 'retry') {
    const delay = Math.max(0, result.nextTryAt.getTime() - Date.now())
    try {
      await (await getQueue()).add('deliver', { outboxId }, { delay, removeOnComplete: true })
    } catch (error) {
      log.warn(
        { outboxId, err: error instanceof Error ? error.message : error },
        'failed to schedule outbox retry',
      )
    }
  }
  return result
}

export async function resolveClientContactEmail(
  clientId: string,
): Promise<{ email: string; name: string } | null> {
  const links = await db
    .select({ contactId: contactClients.contactId, isPrimary: contactClients.isPrimary })
    .from(contactClients)
    .where(eq(contactClients.clientId, clientId))
  const ordered = [...links].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
  for (const link of ordered) {
    const [contact] = await db
      .select({ email: contacts.email, name: contacts.name })
      .from(contacts)
      .where(eq(contacts.id, link.contactId))
    if (contact?.email) return { email: contact.email, name: contact.name }
  }
  return null
}

// Enqueue the client-facing email for a staff-authored public update.
// No recipient configured (no email settings, no contact email) = no-op:
// nothing is auto-sent, and there is no template layer in Phase 1.
export async function queueTicketReply(input: {
  ticket: { id: string; number: number; subject: string; clientId: string; alias: string | null }
  body: string
  isReply: boolean
}): Promise<string | null> {
  const settingsValue = await loadEmailSettings()
  if (!settingsValue?.smtp) return null
  const recipient = await resolveClientContactEmail(input.ticket.clientId)
  if (!recipient) return null
  const id = await enqueueOutbox({
    ticketId: input.ticket.id,
    to: recipient.email,
    from: settingsValue.smtp.from,
    fromName: settingsValue.smtp.fromName || null,
    subject: `${input.isReply ? 'Re: ' : ''}[KIP-${input.ticket.number}] ${input.ticket.subject}`,
    body: input.body,
    replyTo: input.ticket.alias,
    messageId: `<${randomUUID()}@${settingsValue.domain}>`,
  })
  log.info({ outboxId: id, ticketId: input.ticket.id, to: recipient.email }, 'outbox enqueued')
  return id
}
