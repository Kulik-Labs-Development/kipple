import { z } from 'zod'

export const TicketStatus = z.enum(['open', 'pending', 'hold', 'closed', 'deleted'])
export type TicketStatus = z.infer<typeof TicketStatus>

export const TicketPriority = z.enum(['low', 'normal', 'high', 'urgent'])
export type TicketPriority = z.infer<typeof TicketPriority>

export const AgentPresence = z.enum(['online', 'away', 'busy', 'offline'])
export type AgentPresence = z.infer<typeof AgentPresence>

export const UserRole = z.enum(['superuser', 'admin', 'agent', 'contact'])
export type UserRole = z.infer<typeof UserRole>

export const SetupRequest = z.object({
  instanceName: z.string().min(2).max(80),
  ownerName: z.string().min(2).max(120),
  ownerEmail: z.string().email().max(200),
  password: z.string().min(8).max(128),
})
export type SetupRequest = z.infer<typeof SetupRequest>

export const ClientCreate = z.object({
  name: z.string().min(1).max(200),
  domain: z.string().max(253).optional().or(z.literal('')),
})
export type ClientCreate = z.infer<typeof ClientCreate>

export const ClientUpdate = ClientCreate.partial()

export const ContactCreate = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(254),
  phone: z.string().max(40).optional().or(z.literal('')),
})
export type ContactCreate = z.infer<typeof ContactCreate>

export const ContactUpdate = ContactCreate.partial()

export const ContactClientLink = z.object({
  clientId: z.string().min(1),
  isPrimary: z.boolean().optional(),
})
export type ContactClientLink = z.infer<typeof ContactClientLink>

export const TicketCreate = z.object({
  clientId: z.string().min(1),
  subject: z.string().min(1).max(300),
  body: z.string().max(50000).optional().default(''),
  priority: TicketPriority.optional().default('normal'),
  assignedTo: z.string().min(1).nullable().optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional().default([]),
})
export type TicketCreate = z.infer<typeof TicketCreate>

export const TicketUpdate = z.object({
  clientId: z.string().min(1).optional(),
  subject: z.string().min(1).max(300).optional(),
  status: TicketStatus.optional(),
  priority: TicketPriority.optional(),
  assignedTo: z.string().min(1).nullable().optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
})
export type TicketUpdate = z.infer<typeof TicketUpdate>

export const UpdateCreate = z.object({
  kind: z.enum(['public', 'internal']).optional().default('public'),
  body: z.string().min(1).max(100000),
})
export type UpdateCreate = z.infer<typeof UpdateCreate>

// --- Email outbound (§5b) -------------------------------------------------

export const SmtpAuthConfig = z.object({
  username: z.string().min(1).max(254),
  password: z.string().max(512).optional().or(z.literal('')),
})
export type SmtpAuthConfig = z.infer<typeof SmtpAuthConfig>

export const SmtpEmailConfig = z.object({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535).default(587),
  secure: z.boolean().default(false),
  startTls: z.boolean().default(true),
  auth: SmtpAuthConfig.nullable().optional(),
  from: z.string().email().max(254),
  fromName: z.string().max(200).optional().or(z.literal('')),
})
export type SmtpEmailConfig = z.infer<typeof SmtpEmailConfig>

export const EmailSettings = z.object({
  domain: z.string().max(253).default('kipple.local'),
  provider: z.enum(['smtp']).default('smtp'),
  smtp: SmtpEmailConfig.nullable().optional(),
})
export type EmailSettings = z.infer<typeof EmailSettings>

// Persisted shape: the SMTP password is stored as an at-rest ciphertext
// (enc1:...), so it is just a string here.
export const StoredSmtpAuth = z.object({
  username: z.string().min(1).max(254),
  password: z.string(),
})
export type StoredSmtpAuth = z.infer<typeof StoredSmtpAuth>

export const StoredSmtpEmailConfig = SmtpEmailConfig.extend({
  auth: StoredSmtpAuth.nullable().optional(),
})
export type StoredSmtpEmailConfig = z.infer<typeof StoredSmtpEmailConfig>

export const StoredEmailSettings = EmailSettings.extend({
  smtp: StoredSmtpEmailConfig.nullable().optional(),
})
export type StoredEmailSettings = z.infer<typeof StoredEmailSettings>

// Inbound mail (IMAP) — same shape as the SMTP provider config.
export const ImapSettings = z.object({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535).default(993),
  secure: z.boolean().default(true),
  auth: SmtpAuthConfig.nullable().optional(),
  mailbox: z.string().min(1).max(100).default('INBOX'),
})
export type ImapSettings = z.infer<typeof ImapSettings>

export const StoredImapSettings = ImapSettings.extend({
  auth: StoredSmtpAuth.nullable().optional(),
})
export type StoredImapSettings = z.infer<typeof StoredImapSettings>

export const OutboxStatus = z.enum(['queued', 'sent', 'failed', 'bounced'])
export type OutboxStatus = z.infer<typeof OutboxStatus>

export const OutboxJobPayload = z.object({ outboxId: z.string().min(1) })
export type OutboxJobPayload = z.infer<typeof OutboxJobPayload>

export const OutboxTestSend = z.object({ to: z.string().email().max(254) })
export type OutboxTestSend = z.infer<typeof OutboxTestSend>

export const EMAIL_OUTBOX_QUEUE = 'email-outbox'

// --- Time tracking ---
export const MAX_ENTRY_DURATION_S = 24 * 3600

export const TimeEntryStart = z.object({
  ticketId: z.string().min(1),
  billable: z.boolean().optional().default(true),
  note: z.string().max(2000).optional().default(''),
})
export type TimeEntryStart = z.infer<typeof TimeEntryStart>

export const TimeEntryManual = z.object({
  ticketId: z.string().min(1),
  startedAt: z.coerce.date(),
  durationS: z.number().int().min(1).max(MAX_ENTRY_DURATION_S),
  billable: z.boolean().optional().default(true),
  note: z.string().max(2000).optional().default(''),
})
export type TimeEntryManual = z.infer<typeof TimeEntryManual>

export const TimeEntryUpdate = z.object({
  startedAt: z.coerce.date().optional(),
  durationS: z.number().int().min(1).max(MAX_ENTRY_DURATION_S).optional(),
  billable: z.boolean().optional(),
  note: z.string().max(2000).optional(),
})
export type TimeEntryUpdate = z.infer<typeof TimeEntryUpdate>

export const TimeEntryView = z.object({
  id: z.string(),
  ticketId: z.string(),
  agentId: z.string(),
  agentName: z.string().nullable(),
  clientId: z.string(),
  startedAt: z.coerce.date(),
  durationS: z.number().int().nullable(),
  billable: z.boolean(),
  note: z.string(),
})
export type TimeEntryView = z.infer<typeof TimeEntryView>
