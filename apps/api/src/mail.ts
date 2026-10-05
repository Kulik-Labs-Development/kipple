import { randomUUID } from 'node:crypto'
import { Queue } from 'bullmq'
import pino from 'pino'
import {
  createM365Provider,
  createSmtpProvider,
  deliverOutbox,
  type DeliverResult,
  type MailProvider,
} from '@kipple/mail'
import {
  EMAIL_OUTBOX_QUEUE,
  EmailSettings,
  ImapSettings,
  StoredEmailSettings,
  StoredImapSettings,
  decryptAtRest,
  encryptAtRest,
  htmlToText,
  isEncryptedValue,
  isHtmlBody,
  outboundSender,
} from '@kipple/shared'
import { desc, eq, ilike } from 'drizzle-orm'
import { logAudit } from './audit'
import { db } from './db'
import { contactClients, contacts, emailOutbox, settings, users } from './db/schema'

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

// The stored settings carry the SMTP password + M365 client secret as
// ciphertexts; the provider needs the plaintext, so loading always decrypts.
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
  const m365 = stored.m365
  if (
    (!smtp?.auth?.password || !isEncryptedValue(smtp.auth.password)) &&
    (!m365?.clientSecret || !isEncryptedValue(m365.clientSecret))
  ) {
    return stored
  }
  const loaded: EmailSettings = { ...stored }
  if (smtp?.auth?.password && isEncryptedValue(smtp.auth.password)) {
    loaded.smtp = {
      ...smtp,
      auth: { ...smtp.auth, password: decryptAtRest(smtp.auth.password, authSecret()) },
    }
  }
  if (m365?.clientSecret && isEncryptedValue(m365.clientSecret)) {
    loaded.m365 = { ...m365, clientSecret: decryptAtRest(m365.clientSecret, authSecret()) }
  }
  return loaded
}

export async function saveEmailSettings(input: EmailSettings, actorId: string): Promise<void> {
  // The settings panel can only read masked credentials (hasAuth/hasSecret),
  // so a blank password/client secret on re-save means "keep what is stored"
  // — but only when the identity is unchanged (smtp: same username; m365:
  // same client + tenant). A different identity, or a missing auth block,
  // stores '' (unconfigured). The stored value is already enc1:, so it is
  // carried over as-is, never re-encrypted.
  const stored = await loadStoredEmailSettings()
  const inputSmtpAuth = input.smtp?.auth
  const storedSmtpAuth = stored?.smtp?.auth
  const smtpPassword =
    inputSmtpAuth && inputSmtpAuth.password
      ? encryptAtRest(inputSmtpAuth.password, authSecret())
      : inputSmtpAuth &&
          storedSmtpAuth &&
          storedSmtpAuth.username === inputSmtpAuth.username &&
          isEncryptedValue(storedSmtpAuth.password)
        ? storedSmtpAuth.password
        : ''
  const storedM365 = stored?.m365
  const m365Secret =
    input.m365?.clientSecret
      ? encryptAtRest(input.m365.clientSecret, authSecret())
      : input.m365 &&
          storedM365 &&
          storedM365.clientId === input.m365.clientId &&
          storedM365.tenantId === input.m365.tenantId &&
          isEncryptedValue(storedM365.clientSecret)
        ? storedM365.clientSecret
        : ''
  const value = {
    ...input,
    smtp: input.smtp
      ? {
          ...input.smtp,
          auth: input.smtp.auth
            ? { username: input.smtp.auth.username, password: smtpPassword }
            : null,
        }
      : null,
    // Same enc1: seam as the SMTP password: the client secret is encrypted at
    // rest (or carried over from the stored row on a blank re-save).
    m365: input.m365 ? { ...input.m365, clientSecret: m365Secret } : null,
  }
  await db
    .insert(settings)
    .values({ key: 'email', value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
  await logAudit(actorId, 'email.settings.update', 'setting', 'email', {
    provider: input.provider,
    host: input.smtp?.host ?? null,
    from: input.smtp?.from ?? null,
    hasAuth: Boolean(input.smtp?.auth?.username),
    m365Mode: input.m365?.mode ?? null,
  })
}

// Masked view of the settings for the API: credentials never leave the DB.
// "configured" follows the ACTIVE provider (a stored smtp config does not
// count when the provider is m365, and vice versa); the client secret is
// exposed as a boolean flag only, the same way the SMTP password is.
export function describeEmailSettings(settingsValue: EmailSettings | null) {
  const sender = settingsValue ? outboundSender(settingsValue) : null
  return {
    configured: Boolean(sender),
    domain: settingsValue?.domain ?? 'kipple.local',
    provider: sender ? settingsValue?.provider : null,
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
    m365: settingsValue?.m365
      ? {
          tenantId: settingsValue.m365.tenantId,
          clientId: settingsValue.m365.clientId,
          senderAddress: settingsValue.m365.senderAddress,
          mode: settingsValue.m365.mode,
          hasSecret: Boolean(settingsValue.m365.clientSecret),
        }
      : null,
  }
}

export async function loadStoredImapSettings(): Promise<StoredImapSettings | null> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, 'imap'))
  if (!row) return null
  const parsed = StoredImapSettings.safeParse(row.value)
  return parsed.success ? parsed.data : null
}

export async function loadImapSettings(): Promise<ImapSettings | null> {
  const stored = await loadStoredImapSettings()
  if (!stored) return null
  if (!stored.auth?.password || !isEncryptedValue(stored.auth.password)) return stored
  return {
    ...stored,
    auth: { ...stored.auth, password: decryptAtRest(stored.auth.password, authSecret()) },
  }
}

export async function saveImapSettings(input: ImapSettings, actorId: string): Promise<void> {
  const value = {
    ...input,
    auth: input.auth
      ? {
          username: input.auth.username,
          password: input.auth.password ? encryptAtRest(input.auth.password, authSecret()) : '',
        }
      : null,
  }
  await db
    .insert(settings)
    .values({ key: 'imap', value })
    .onConflictDoUpdate({ target: settings.key, set: { value } })
  await logAudit(actorId, 'imap.settings.update', 'setting', 'imap', {
    host: input.host,
    hasAuth: Boolean(input.auth?.username),
  })
}

export function describeImapSettings(settingsValue: ImapSettings | null) {
  return {
    configured: Boolean(settingsValue),
    imap: settingsValue
      ? {
          host: settingsValue.host,
          port: settingsValue.port,
          secure: settingsValue.secure,
          mailbox: settingsValue.mailbox,
          hasAuth: Boolean(settingsValue.auth?.username),
        }
      : null,
  }
}

// Provider registry: dispatch on the settings' active provider. The smtp
// path is byte-identical to the Phase 1 wiring; m365 needs a client secret
// to fetch a token, so a saved m365 config without one = not configured.
export function providerFromSettings(settingsValue: EmailSettings): MailProvider {
  if (settingsValue.provider === 'm365') {
    if (!settingsValue.m365?.clientSecret) throw new Error('email_not_configured')
    return createM365Provider(settingsValue.m365)
  }
  if (!settingsValue.smtp) throw new Error('email_not_configured')
  return createSmtpProvider(settingsValue.smtp)
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
  /** Transport that will deliver (logged on the outbox row). */
  provider?: 'smtp' | 'm365'
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
    // Email transport is plain text: strip html bodies to their plain-text
    // version for the wire (the web timeline keeps the full html).
    body: isHtmlBody(input.body) ? htmlToText(input.body) : input.body,
    replyTo: input.replyTo ?? null,
    messageId: input.messageId,
    // The outbox log records the transport that will actually deliver, so
    // the activity log is filterable per provider.
    provider: input.provider ?? 'smtp',
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

// Magic-link login email (better-auth magicLink plugin hook). Only local
// accounts can receive one: unknown emails get nothing (no enumeration, no
// spam), org-wide SSO disables magic links for everyone, per-user SSO users
// sign in via their IdP, contacts always receive one (the portal flow), and
// staff opt in per account (users.magic_link_enabled, issue #98). Delivered
// through the normal provider queue.
export async function sendMagicLinkEmail(email: string, url: string): Promise<void> {
  const [user] = await db.select().from(users).where(ilike(users.email, email))
  if (!user) {
    log.info('magic link requested for unknown email; not sending')
    return
  }
  if (user.authSource !== 'local') {
    log.info({ userId: user.id }, 'magic link blocked for SSO user')
    return
  }
  // Org-wide kill switch: when SSO is enabled for the instance (settings key
  // 'sso'), magic-link sign-in is unavailable for everyone, contacts
  // included. The flag is a read-only seam in v1 — the writer lands with the
  // real IdP integration (Phase 3).
  const [ssoRow] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, 'sso'))
  if (((ssoRow?.value as { enabled?: boolean } | null) ?? {}).enabled === true) {
    log.info({ userId: user.id }, 'magic link disabled org-wide (SSO enabled)')
    return
  }
  if (user.role !== 'contact' && user.magicLinkEnabled !== true) {
    log.info({ userId: user.id }, 'magic link not enabled for staff account')
    return
  }
  const [instanceRow] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, 'instance'))
  const instanceName = ((instanceRow?.value as { name?: string } | null) ?? {}).name ?? 'Kipple'
  const emailSettings = await loadEmailSettings()
  const domain = emailSettings?.domain ?? 'kipple.local'
  const sender = emailSettings ? outboundSender(emailSettings) : null
  await enqueueOutbox({
    to: user.email,
    from: sender?.from ?? `no-reply@${domain}`,
    fromName: sender?.fromName ?? instanceName,
    subject: `Sign in to ${instanceName}`,
    body: [
      `Hi ${user.name || 'there'},`,
      '',
      'Use this link to sign in to your support portal:',
      '',
      url,
      '',
      'This link expires in 10 minutes and works only once.',
      '',
      'If you did not request this email you can safely ignore it.',
    ].join('\n'),
    messageId: `<${randomUUID()}@${domain}>`,
  })
}


// Admin invite for a new staff account (issue #32). Same delivery seam as
// the magic link: instance name, stored provider settings, outbox queue.
// Unknown-domain/SMTP instances simply queue the row like everything else.
export async function sendInviteEmail(email: string, role: string, url: string): Promise<void> {
  const [instanceRow] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, 'instance'))
  const instanceName = ((instanceRow?.value as { name?: string } | null) ?? {}).name ?? 'Kipple'
  const emailSettings = await loadEmailSettings()
  const domain = emailSettings?.domain ?? 'kipple.local'
  const sender = emailSettings ? outboundSender(emailSettings) : null
  await enqueueOutbox({
    to: email,
    from: sender?.from ?? `no-reply@${domain}`,
    fromName: sender?.fromName ?? instanceName,
    subject: `You're invited to ${instanceName}`,
    body: [
      'Hi there,',
      '',
      `You have been invited to join ${instanceName} as a ${role}.`,
      '',
      'Use this link to create your account:',
      '',
      url,
      '',
      'This invitation expires in 3 days and works only once.',
      '',
      'If you did not expect this invitation you can safely ignore it.',
    ].join('\n'),
    messageId: `<${randomUUID()}@${domain}>`,
  })
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
// No recipient configured (active provider not configured, no contact
// email) = no-op: nothing is auto-sent.
export async function queueTicketReply(input: {
  ticket: { id: string; number: number; subject: string; clientId: string; alias: string | null }
  body: string
  isReply: boolean
}): Promise<string | null> {
  const settingsValue = await loadEmailSettings()
  if (!settingsValue) return null
  const sender = outboundSender(settingsValue)
  if (!sender) return null
  const recipient = await resolveClientContactEmail(input.ticket.clientId)
  if (!recipient) return null
  const id = await enqueueOutbox({
    ticketId: input.ticket.id,
    to: recipient.email,
    from: sender.from,
    fromName: sender.fromName,
    subject: `${input.isReply ? 'Re: ' : ''}[KIP-${input.ticket.number}] ${input.ticket.subject}`,
    body: input.body,
    replyTo: input.ticket.alias,
    messageId: `<${randomUUID()}@${settingsValue.domain}>`,
    provider: settingsValue.provider,
  })
  log.info({ outboxId: id, ticketId: input.ticket.id, to: recipient.email }, 'outbox enqueued')
  return id
}
