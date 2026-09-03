import { sql } from 'drizzle-orm'
import {
  boolean,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  text,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core'

const createdAt = () =>
  timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  phone: text('phone'),
  address: text('address'),
  office: text('office'),
  clientId: text('client_id').references(() => clients.id, { onDelete: 'set null' }),
  role: text('role').notNull().default('agent'),
  presence: text('presence').notNull().default('offline'),
  authSource: text('auth_source').notNull().default('local'),
  twoFactorEnabled: boolean('two_factor_enabled').notNull().default(false),
  theme: text('theme'),
  colorMode: text('color_mode').notNull().default('system'),
  contactId: text('contact_id').references(() => contacts.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const sessions = pgTable('session', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const accounts = pgTable(
  'account',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id').notNull(),
    issuer: text('issuer').notNull(),
    accountId: text('account_id').notNull(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
    scope: text('scope'),
    password: text('password'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [unique().on(table.issuer, table.accountId)],
)

export const verifications = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const twoFactor = pgTable('twoFactor', {
  id: text('id').primaryKey(),
  secret: text('secret').notNull(),
  backupCodes: text('backup_codes').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  verified: boolean('verified').notNull().default(true),
  failedVerificationCount: integer('failed_verification_count').notNull().default(0),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

// Named SLA policies (PLAN item 10). targets = per-priority response/resolve
// targets in business minutes (see SlaTargets in @kipple/shared). Exactly one
// policy may be the instance default.
export const slaPolicies = pgTable('sla_policies', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  targets: jsonb('targets').notNull(),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const clients = pgTable('clients', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  domain: text('domain').unique(),
  branding: jsonb('branding'),
  slaPolicyId: text('sla_policy_id').references(() => slaPolicies.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const contacts = pgTable('contacts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  phone: text('phone'),
  externalId: text('external_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const contactClients = pgTable(
  'contact_clients',
  {
    contactId: text('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    clientId: text('client_id')
      .notNull()
      .references(() => clients.id, { onDelete: 'cascade' }),
    isPrimary: boolean('is_primary').notNull().default(false),
  },
  (table) => [unique().on(table.contactId, table.clientId)],
)

export const ticketNumberSeq = pgSequence('ticket_number', { startWith: 1, increment: 1 })

export const tickets = pgTable('tickets', {
  id: text('id').primaryKey(),
  number: integer('number')
    .notNull()
    .unique()
    .default(sql`nextval('ticket_number')`),
  clientId: text('client_id').notNull().references(() => clients.id),
  alias: text('alias').unique(),
  subject: text('subject').notNull(),
  status: text('status').notNull().default('open'),
  priority: text('priority').notNull().default('normal'),
  assignedTo: text('assigned_to').references(() => users.id, { onDelete: 'set null' }),
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  // SLA (item 10). The resolved policy id is recorded when the due times are
  // computed (ticket override > client policy > instance default), so due
  // times survive policy edits/deletes. States: pending | at_risk |
  // breached | met — response tracks the first staff reply, resolve tracks
  // the status reaching closed.
  slaPolicyId: text('sla_policy_id').references(() => slaPolicies.id, { onDelete: 'set null' }),
  slaResponseDueAt: timestamp('sla_response_due_at', { withTimezone: true }),
  slaResolveDueAt: timestamp('sla_resolve_due_at', { withTimezone: true }),
  slaResponseAt: timestamp('sla_response_at', { withTimezone: true }),
  slaResolvedAt: timestamp('sla_resolved_at', { withTimezone: true }),
  slaResponseState: text('sla_response_state').notNull().default('pending'),
  slaResolveState: text('sla_resolve_state').notNull().default('pending'),
  // Hold states (issue #30): while status='hold' the auto-close timer runs
  // from hold_since (calendar days, instance setting 'hold'); hold_warned_at
  // marks the pre-close warning that fired once per hold episode.
  holdOn: text('hold_on'),
  holdSince: timestamp('hold_since', { withTimezone: true }),
  holdWarnedAt: timestamp('hold_warned_at', { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const updates = pgTable('updates', {
  id: text('id').primaryKey(),
  ticketId: text('ticket_id')
    .notNull()
    .references(() => tickets.id, { onDelete: 'cascade' }),
  authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }),
  kind: text('kind').notNull().default('public'),
  body: text('body').notNull().default(''),
  emailMeta: jsonb('email_meta'),
  createdAt: createdAt(),
})

// Attachments on updates (plan item 13, v1 — local disk, single-request
// multipart; chunked/tus + S3 adapter are tracked as follow-ups). storage_key
// is the on-disk sharding key and is always a server-generated id; the
// client-supplied filename is display data only and never touches paths.
export const attachments = pgTable('attachments', {
  id: text('id').primaryKey(),
  updateId: text('update_id')
    .notNull()
    .references(() => updates.id, { onDelete: 'cascade' }),
  filename: text('filename').notNull(),
  size: integer('size').notNull(),
  mime: text('mime').notNull(),
  storageKey: text('storage_key').notNull().unique(),
  createdAt: createdAt(),
})

export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedAt: updatedAt(),
})

export const emailOutbox = pgTable('email_outbox', {
  id: text('id').primaryKey(),
  ticketId: text('ticket_id').references(() => tickets.id),
  to: text('to').notNull(),
  from: text('from').notNull(),
  fromName: text('from_name'),
  subject: text('subject').notNull(),
  body: text('body').notNull().default(''),
  replyTo: text('reply_to'),
  messageId: text('message_id'),
  provider: text('provider').notNull(),
  status: text('status').notNull().default('queued'),
  error: text('error'),
  attempts: integer('attempts').notNull().default(0),
  nextTryAt: timestamp('next_try_at', { withTimezone: true }),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  createdAt: createdAt(),
})

// Inbound email dedupe + processing log. message_id is the idempotency key:
// the same Message-ID is only ever processed once (PLAN §5.1, AGENTS email
// rules).
export const emailMessages = pgTable('email_messages', {
  id: text('id').primaryKey(),
  messageId: text('message_id').notNull().unique(),
  fromName: text('from_name'),
  fromAddress: text('from_address').notNull(),
  toAddresses: text('to_addresses').array().notNull().default(sql`'{}'::text[]`),
  subject: text('subject').notNull(),
  ticketId: text('ticket_id').references(() => tickets.id),
  status: text('status').notNull().default('received'),
  error: text('error'),
  createdAt: createdAt(),
})

// Time tracking. A running timer is a row with duration_s NULL; exactly one
// such row may exist per agent (enforced in the service layer). client_id is
// denormalized from the ticket at entry time so per-client billing reports
// survive client reassignment.
export const timeEntries = pgTable('time_entries', {
  id: text('id').primaryKey(),
  ticketId: text('ticket_id')
    .notNull()
    .references(() => tickets.id, { onDelete: 'cascade' }),
  agentId: text('agent_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  clientId: text('client_id')
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  durationS: integer('duration_s'),
  billable: boolean('billable').notNull().default(true),
  note: text('note').notNull().default(''),
  createdAt: createdAt(),
})

// Email templates (PLAN item 11). All optional — none are enabled by default;
// automated email only happens when a rule (send_template action) references
// an enabled template. Body/subject support {{dotted.var}} placeholders.
export const emailTemplates = pgTable('email_templates', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  name: text('name').notNull(),
  subject: text('subject').notNull().default(''),
  body: text('body').notNull().default(''),
  enabled: boolean('enabled').notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

// Automation rules v1 (PLAN item 11). match: { event, status?, fromStatus?,
// priority?, clientId?, tags?, staffOnly? }; action: one of
// send_template | assign | add_tag | set_status | webhook. Disabled until the
// user enables one.
export const rules = pgTable('rules', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(false),
  match: jsonb('match').notNull(),
  action: jsonb('action').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

// Rule execution log — powers the "what would fire" test preview UI and
// auditability of every rule action.
export const ruleRuns = pgTable('rule_runs', {
  id: text('id').primaryKey(),
  ruleId: text('rule_id').references(() => rules.id, { onDelete: 'cascade' }),
  event: text('event').notNull(),
  ticketId: text('ticket_id').references(() => tickets.id, { onDelete: 'set null' }),
  result: text('result').notNull().default('ok'), // ok | noop | error
  error: text('error'),
  meta: jsonb('meta'),
  createdAt: createdAt(),
})

// In-app notification center (PLAN §8d, item 11). One row per (user, event);
// the bell shows unread. SSE is a documented follow-up (polling for v1).
export const notifications = pgTable('notifications', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  event: text('event').notNull(),
  ticketId: text('ticket_id').references(() => tickets.id, { onDelete: 'cascade' }),
  message: text('message').notNull().default(''),
  read: boolean('read').notNull().default(false),
  createdAt: createdAt(),
})

export const audit = pgTable('audit', {
  id: text('id').primaryKey(),
  actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  meta: jsonb('meta'),
  createdAt: createdAt(),
})
