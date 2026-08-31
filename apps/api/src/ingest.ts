import { createHash, randomUUID } from 'node:crypto'
import pino from 'pino'
import { and, eq, ilike, inArray, isNotNull, ne, sql } from 'drizzle-orm'
import {
  cleanEmailSubject,
  extractThreadSignals,
  ticketAliasAddress,
  type ParsedEmail,
} from '@kipple/mail'
import { logAudit } from './audit'
import { db } from './db'
import {
  contactClients,
  contacts,
  emailMessages,
  emailOutbox,
  tickets,
  updates,
  users,
} from './db/schema'
import { loadEmailSettings } from './mail'

const log = pino({ name: 'ingest' })

export type IngestMatch = 'alias' | 'subject' | 'thread' | 'contact'

export type IngestResult =
  | { action: 'duplicate' }
  | { action: 'matched'; ticketId: string; via: IngestMatch }
  | { action: 'created'; ticketId: string }
  | { action: 'unknown_sender'; fromAddress: string }
  | { action: 'skipped_no_client'; fromAddress: string }
  | { action: 'error'; reason: string }

// RFC 5322 Message-IDs are case-insensitive and often bracketed; match on a
// canonical form.
function canonicalIds(ids: string[]): string[] {
  return ids.map((id) => id.trim().replace(/^<|>$/g, '').trim().toLowerCase()).filter(Boolean)
}

function stableMessageId(email: ParsedEmail): string {
  const basis = [email.from.address, ...email.to, email.subject, email.text].join('\u0001')
  return createHash('sha256').update(basis).digest('hex')
}

function bodyFromEmail(email: ParsedEmail): string {
  if (email.text.trim()) return email.text.trim()
  return email.html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim()
}

async function findTicketByNumber(number: number) {
  const [ticket] = await db
    .select()
    .from(tickets)
    .where(and(eq(tickets.number, number), ne(tickets.status, 'deleted')))
  return ticket ?? null
}

async function findContact(address: string) {
  const [contact] = await db.select().from(contacts).where(ilike(contacts.email, address))
  if (!contact) return null
  const [user] = await db.select().from(users).where(eq(users.contactId, contact.id))
  return { contact, user: user ?? null }
}

async function primaryClientId(contactId: string): Promise<string | null> {
  const links = await db
    .select({ clientId: contactClients.clientId, isPrimary: contactClients.isPrimary })
    .from(contactClients)
    .where(eq(contactClients.contactId, contactId))
  const primary = links.find((link) => link.isPrimary) ?? links[0]
  return primary?.clientId ?? null
}

// Layer (a): a Message-ID in References/In-Reply-To that we already know —
// as an inbound message, an outbound message, or a stored update.
async function findTicketByMessageIds(ids: string[]): Promise<string | null> {
  const normalized = canonicalIds(ids)
  if (normalized.length === 0) return null
  const candidates = new Set<string>()
  const fromMessages = await db
    .select({ ticketId: emailMessages.ticketId })
    .from(emailMessages)
    .where(and(inArray(emailMessages.messageId, normalized), isNotNull(emailMessages.ticketId)))
  // Outbound Message-IDs are stored with angle brackets; normalize in SQL.
  const fromOutbox = await db
    .select({ ticketId: emailOutbox.ticketId })
    .from(emailOutbox)
    .where(
      and(
        isNotNull(emailOutbox.ticketId),
        sql`lower(regexp_replace(email_outbox.message_id, '[<>]', '', 'g')) in ${normalized}`,
      ),
    )
  const fromUpdates = await db
    .select({ ticketId: updates.ticketId })
    .from(updates)
    .where(sql`"email_meta" ->> 'messageId' in ${normalized}`)
  for (const row of [...fromMessages, ...fromOutbox, ...fromUpdates]) {
    if (row.ticketId) candidates.add(row.ticketId)
  }
  for (const ticketId of candidates) {
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId))
    if (ticket && ticket.status !== 'deleted') return ticket.id
  }
  return null
}

async function createTicketFromEmail(email: ParsedEmail, clientId: string, userId: string | null) {
  const [ticket] = await db
    .insert(tickets)
    .values({
      id: randomUUID(),
      clientId,
      subject:
        cleanEmailSubject(email.subject) || `Email from ${email.from.name || email.from.address}`,
      createdBy: userId,
    })
    .returning()
  const alias = ticketAliasAddress(ticket.number, (await loadEmailSettings())?.domain ?? 'kipple.local')
  const [updated] = await db
    .update(tickets)
    .set({ alias })
    .where(eq(tickets.id, ticket.id))
    .returning()
  return updated
}

export async function processInboundMessage(email: ParsedEmail): Promise<IngestResult> {
  const messageId = email.messageId ?? stableMessageId(email)
  const [record] = await db
    .insert(emailMessages)
    .values({
      id: randomUUID(),
      messageId,
      fromName: email.from.name || null,
      fromAddress: email.from.address.toLowerCase(),
      toAddresses: email.to.map((to) => to.toLowerCase()),
      subject: email.subject,
    })
    .onConflictDoNothing()
    .returning()
  if (!record) return { action: 'duplicate' }

  const mark = (status: string, ticketId: string | null = null, error: string | null = null) =>
    db
      .update(emailMessages)
      .set({ status, ticketId, error })
      .where(eq(emailMessages.id, record.id))

  const contact = await findContact(email.from.address)

  try {
    const signals = extractThreadSignals(email)

    if (signals.aliasNumber !== null) {
      const ticket = await findTicketByNumber(signals.aliasNumber)
      if (ticket) return await finish(email, record, ticket, contact?.user?.id ?? null, 'alias')
    }
    if (signals.subjectNumber !== null) {
      const ticket = await findTicketByNumber(signals.subjectNumber)
      if (ticket) return await finish(email, record, ticket, contact?.user?.id ?? null, 'subject')
    }
    if (signals.messageIds.length > 0) {
      const ticketId = await findTicketByMessageIds(signals.messageIds)
      if (ticketId) {
        const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketId))
        if (ticket) return await finish(email, record, ticket, contact?.user?.id ?? null, 'thread')
      }
    }
    if (contact) {
      const clientId = await primaryClientId(contact.contact.id)
      if (!clientId) {
        await mark('skipped_no_client')
        return { action: 'skipped_no_client', fromAddress: email.from.address }
      }
      const ticket = await createTicketFromEmail(email, clientId, contact.user?.id ?? null)
      return await finish(email, record, ticket, contact.user?.id ?? null, 'contact')
    }
    await mark('unknown_sender')
    return { action: 'unknown_sender', fromAddress: email.from.address }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    await mark('error', null, reason)
    log.error({ messageId, err: reason }, 'inbound message processing failed')
    return { action: 'error', reason }
  }
}

async function finish(
  email: ParsedEmail,
  record: typeof emailMessages.$inferSelect,
  ticket: typeof tickets.$inferSelect,
  authorId: string | null,
  via: IngestMatch,
): Promise<IngestResult> {
  await db.insert(updates).values({
    id: randomUUID(),
    ticketId: ticket.id,
    authorId,
    kind: 'public',
    body: bodyFromEmail(email),
    emailMeta: { messageId: record.messageId },
  })
  await db
    .update(emailMessages)
    .set({ status: via === 'contact' ? 'created' : 'matched', ticketId: ticket.id })
    .where(eq(emailMessages.id, record.id))
  await logAudit(authorId, via === 'contact' ? 'email.message.created' : 'email.message.matched', 'ticket', ticket.id, {
    messageId: record.messageId,
    via,
    number: ticket.number,
  })
  log.info({ ticketId: ticket.id, via, messageId: record.messageId }, 'inbound message processed')
  return via === 'contact'
    ? { action: 'created', ticketId: ticket.id }
    : { action: 'matched', ticketId: ticket.id, via }
}
