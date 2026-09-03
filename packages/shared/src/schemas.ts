import { z } from 'zod'
import { SlaTargets } from './sla'
import { ClientBranding } from './themes'

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
  slaPolicyId: z.string().min(1).nullable().optional(),
  branding: ClientBranding.optional(),
})
export type ClientCreate = z.infer<typeof ClientCreate>

export const ClientUpdate = ClientCreate.partial().extend({
  branding: ClientBranding.nullable().optional(),
})

// Staff-to-client association (UI triage 09-02 item 11): which client a staff
// member's account belongs to. null = unassigned. Association only — staff
// scoping is a separate row.
export const UserClientPatch = z.object({
  clientId: z.string().min(1).nullable().optional(),
})
export type UserClientPatch = z.infer<typeof UserClientPatch>

// Company settings (UI triage 09-02 item 15): superuser-provisioned staff
// account. superuser is deliberately absent from the role union — superusers
// are created by the setup wizard only, never through this endpoint.
export const UserCreate = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email().max(200),
  password: z.string().min(8).max(128),
  role: z.enum(['admin', 'agent']).optional().default('agent'),
})
export type UserCreate = z.infer<typeof UserCreate>

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

// --- Hold states (issue #30) ---
// Who a held ticket is waiting on. 'hold' itself is an existing status
// value (TicketStatus); the reason is the new distinction.
export const HOLD_REASONS = ['client', 'vendor'] as const
export type HoldReason = (typeof HOLD_REASONS)[number]

// Instance hold settings (settings key 'hold'). null = off. warnDays
// requires autoCloseDays and must be smaller (cross-field rules are
// validated in the POST route, not in the zod object).
export const HoldSettings = z.object({
  autoCloseDays: z.number().int().min(1).max(365).nullable().optional(),
  warnDays: z.number().int().min(1).max(364).nullable().optional(),
})
export type HoldSettings = z.infer<typeof HoldSettings>

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
  slaPolicyId: z.string().min(1).nullable().optional(),
  subject: z.string().min(1).max(300).optional(),
  status: TicketStatus.optional(),
  // hold reason (issue #30): who the ticket is waiting on while on hold;
  // entering hold defaults it to 'client' when omitted
  holdOn: z.enum(HOLD_REASONS).nullable().optional(),
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

// An update attachment as returned by the API (plan item 13, v1). Downloads
// go to GET /api/attachments/:id with the caller's session cookie.
export const AttachmentView = z.object({
  id: z.string(),
  updateId: z.string(),
  filename: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  mime: z.string().min(1).max(128),
  createdAt: z.coerce.date(),
})
export type AttachmentView = z.infer<typeof AttachmentView>

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

// --- SLA management (item 10) ---
export const SlaPolicyCreate = z.object({
  name: z.string().min(1).max(100),
  targets: SlaTargets,
  isDefault: z.boolean().optional().default(false),
})
export type SlaPolicyCreate = z.infer<typeof SlaPolicyCreate>

export const SlaPolicyUpdate = z.object({
  name: z.string().min(1).max(100).optional(),
  targets: SlaTargets.optional(),
  isDefault: z.boolean().optional(),
})
export type SlaPolicyUpdate = z.infer<typeof SlaPolicyUpdate>

export const SlaSettings = z.object({ enabled: z.boolean() })
export type SlaSettings = z.infer<typeof SlaSettings>

// --- Email templates (item 11) ---
export const TEMPLATE_KEY = /^[a-z0-9][a-z0-9_]{0,59}$/

export const EmailTemplateCreate = z.object({
  key: z.string().regex(TEMPLATE_KEY, 'lowercase letters, digits, underscores'),
  name: z.string().min(1).max(100),
  subject: z.string().max(300).default(''),
  body: z.string().max(20_000).default(''),
  enabled: z.boolean().optional().default(false),
})
export type EmailTemplateCreate = z.infer<typeof EmailTemplateCreate>

export const EmailTemplateUpdate = z.object({
  name: z.string().min(1).max(100).optional(),
  subject: z.string().max(300).optional(),
  body: z.string().max(20_000).optional(),
  enabled: z.boolean().optional(),
})
export type EmailTemplateUpdate = z.infer<typeof EmailTemplateUpdate>

// --- Rules (item 11) ---
export const RULE_EVENTS = [
  'ticket.created',
  'ticket.status_changed',
  'ticket.reply',
  'ticket.updated',
  // a held ticket entered its pre-close warning window (issue #30)
  'ticket.hold_warning',
] as const
export type RuleEventName = (typeof RULE_EVENTS)[number]

export const RuleMatch = z.object({
  event: z.enum(RULE_EVENTS),
  // status = the ticket's status at the moment of the event (for
  // ticket.status_changed: the NEW status); fromStatus = previous status
  status: TicketStatus.optional(),
  fromStatus: TicketStatus.optional(),
  priority: TicketPriority.optional(),
  clientId: z.string().min(1).optional(),
  // every listed tag must be present on the ticket
  tags: z.array(z.string().min(1).max(50)).max(10).optional(),
  // the event actor must be staff (not a contact)
  staffOnly: z.boolean().optional(),
})
export type RuleMatch = z.infer<typeof RuleMatch>

export const RuleAction = z.discriminatedUnion('type', [
  z.object({ type: z.literal('send_template'), templateKey: z.string().regex(TEMPLATE_KEY) }),
  z.object({ type: z.literal('assign'), userId: z.string().min(1) }),
  z.object({ type: z.literal('add_tag'), tags: z.array(z.string().min(1).max(50)).min(1).max(10) }),
  z.object({ type: z.literal('set_status'), status: TicketStatus }),
  z.object({
    type: z.literal('webhook'),
    url: z.string().url().max(2000),
    // HMAC-SHA256 signature secret (x-kipple-signature header)
    secret: z.string().min(8).max(200).optional(),
  }),
])
export type RuleAction = z.infer<typeof RuleAction>

export const RuleCreate = z.object({
  name: z.string().min(1).max(100),
  enabled: z.boolean().optional().default(false),
  match: RuleMatch,
  action: RuleAction,
})
export type RuleCreate = z.infer<typeof RuleCreate>

export const RuleUpdate = z.object({
  name: z.string().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
  match: RuleMatch.optional(),
  action: RuleAction.optional(),
})
export type RuleUpdate = z.infer<typeof RuleUpdate>
