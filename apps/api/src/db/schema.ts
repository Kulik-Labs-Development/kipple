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

export const clients = pgTable('clients', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  domain: text('domain').unique(),
  branding: jsonb('branding'),
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
  assignedTo: text('assigned_to').references(() => users.id),
  createdBy: text('created_by').references(() => users.id),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const updates = pgTable('updates', {
  id: text('id').primaryKey(),
  ticketId: text('ticket_id')
    .notNull()
    .references(() => tickets.id, { onDelete: 'cascade' }),
  authorId: text('author_id').references(() => users.id),
  kind: text('kind').notNull().default('public'),
  body: text('body').notNull().default(''),
  emailMeta: jsonb('email_meta'),
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

export const audit = pgTable('audit', {
  id: text('id').primaryKey(),
  actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
  action: text('action').notNull(),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  meta: jsonb('meta'),
  createdAt: createdAt(),
})
