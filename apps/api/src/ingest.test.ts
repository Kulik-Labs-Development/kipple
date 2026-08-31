import { randomUUID } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseEmail } from '@kipple/mail'
import { buildApp } from './app'
import { db } from './db'
import { runMigrations } from './db/migrate'
import {
  accounts,
  clients,
  contactClients,
  contacts,
  emailMessages,
  emailOutbox,
  settings,
  tickets,
  updates,
  users,
} from './db/schema'
import { processInboundMessage } from './ingest'
import { closeMail } from './mail'

type App = Awaited<ReturnType<typeof buildApp>>

const owner = {
  instanceName: 'Kulik Labs IT',
  ownerName: 'Max Kulik',
  ownerEmail: 'max@kuliklabs.dev',
  password: 'correct-horse-battery',
}

function cookiesFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie']
  const list = Array.isArray(raw) ? raw : [raw]
  return list
    .filter(Boolean)
    .map((cookie) => String(cookie).split(';')[0])
    .join('; ')
}

async function wipe() {
  await db.delete(emailMessages)
  await db.delete(emailOutbox)
  await db.delete(updates)
  await db.delete(tickets)
  await db.delete(contactClients)
  await db.delete(contacts)
  await db.delete(clients)
  await db.delete(users)
  await db.delete(settings)
}

function makeEml(input: {
  from: string
  fromName?: string
  to: string
  subject: string
  messageId: string
  inReplyTo?: string
  references?: string[]
  body: string
}): string {
  const fromHeader = input.fromName ? `"${input.fromName}" <${input.from}>` : input.from
  return [
    `From: ${fromHeader}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    `Message-ID: <${input.messageId}>`,
    ...(input.inReplyTo ? [`In-Reply-To: <${input.inReplyTo}>`] : []),
    ...(input.references ? [`References: ${input.references.map((r) => `<${r}>`).join(' ')}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    input.body,
  ].join('\r\n')
}

describe('email ingest', () => {
  let app: App
  let staffCookie: string
  let clientA: string
  let ticketA: string
  let ticketNumberA: number
  let adaUserId: string

  beforeAll(async () => {
    await runMigrations()
    await wipe()
    app = await buildApp()

    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: owner })
    expect(setup.statusCode).toBe(200)
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: owner.ownerEmail, password: owner.password },
    })
    expect(login.statusCode).toBe(200)
    staffCookie = cookiesFrom(login)

    const resA = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie: staffCookie },
      payload: { name: 'Acme Corp', domain: 'acme.test' },
    })
    expect(resA.statusCode).toBe(201)
    clientA = resA.json().id

    const contactRes = await app.inject({
      method: 'POST',
      url: `/api/clients/${clientA}/contacts`,
      headers: { cookie: staffCookie },
      payload: { name: 'Ada Client', email: 'ada@acme.test' },
    })
    expect(contactRes.statusCode).toBe(201)
    const contactRecordId = contactRes.json().id
    adaUserId = randomUUID()
    await db.insert(users).values({
      id: adaUserId,
      name: 'Ada Client',
      email: 'ada@acme.test',
      role: 'contact',
      contactId: contactRecordId,
    })
    await db.insert(accounts).values({
      id: randomUUID(),
      providerId: 'credential',
      issuer: 'local:credential',
      accountId: adaUserId,
      userId: adaUserId,
      password: await hashPassword('ada-contact-pass'),
    })

    const ticketRes = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: staffCookie },
      payload: { clientId: clientA, subject: 'Printer is on fire' },
    })
    expect(ticketRes.statusCode).toBe(201)
    ticketA = ticketRes.json().id
    ticketNumberA = ticketRes.json().number
  })

  afterAll(async () => {
    await app.close()
    await closeMail()
    await wipe()
  })

  it('matches a reply via the ticket alias in the To header', async () => {
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, ticketA))
    const email = await parseEmail(
      makeEml({
        from: 'ada@acme.test',
        fromName: 'Ada Client',
        to: ticket.alias as string,
        subject: `Re: [KIP-${ticketNumberA}] Printer is on fire`,
        messageId: 'in-alias-1@acme.test',
        body: 'It was a paper jam.',
      }),
    )
    const result = await processInboundMessage(email)
    expect(result).toEqual({ action: 'matched', ticketId: ticketA, via: 'alias' })

    const [record] = await db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.messageId, 'in-alias-1@acme.test'))
    expect(record.status).toBe('matched')
    expect(record.ticketId).toBe(ticketA)

    const [update] = await db
      .select()
      .from(updates)
      .where(eq(updates.ticketId, ticketA))
      .orderBy(updates.createdAt)
    expect(update.kind).toBe('public')
    expect(update.body).toBe('It was a paper jam.')
    expect(update.authorId).toBe(adaUserId)
    expect(update.emailMeta).toEqual({ messageId: 'in-alias-1@acme.test' })
  })

  it('is idempotent: the same Message-ID is not processed twice', async () => {
    const email = await parseEmail(
      makeEml({
        from: 'ada@acme.test',
        to: `support+${ticketNumberA}@kuliklabs.dev`,
        subject: `Re: [KIP-${ticketNumberA}] Printer is on fire`,
        messageId: 'in-alias-1@acme.test',
        body: 'It was a paper jam.',
      }),
    )
    expect(await processInboundMessage(email)).toEqual({ action: 'duplicate' })
    const rows = await db
      .select({ id: emailMessages.id })
      .from(emailMessages)
      .where(eq(emailMessages.messageId, 'in-alias-1@acme.test'))
    expect(rows).toHaveLength(1)
  })

  it('matches via the [KIP-n] subject tag when the To has no alias', async () => {
    const email = await parseEmail(
      makeEml({
        from: 'ada@acme.test',
        to: 'support@kuliklabs.dev',
        subject: `[KIP-${ticketNumberA}] still not printing`,
        messageId: 'in-subject-1@acme.test',
        body: 'Tried a new cartridge.',
      }),
    )
    expect(await processInboundMessage(email)).toEqual({
      action: 'matched',
      ticketId: ticketA,
      via: 'subject',
    })
  })

  it('matches via References to an outbound reply', async () => {
    // Configure email so the staff reply is enqueued (never actually sent here).
    const saveRes = await app.inject({
      method: 'POST',
      url: '/api/email',
      headers: { cookie: staffCookie },
      payload: {
        domain: 'kuliklabs.dev',
        provider: 'smtp',
        smtp: {
          host: '127.0.0.1',
          port: 2525,
          secure: false,
          startTls: false,
          from: 'support@kuliklabs.dev',
        },
      },
    })
    expect(saveRes.statusCode).toBe(200)

    const updateRes = await app.inject({
      method: 'POST',
      url: `/api/tickets/${ticketA}/updates`,
      headers: { cookie: staffCookie },
      payload: { kind: 'public', body: 'We shipped a fix.' },
    })
    expect(updateRes.statusCode).toBe(201)
    const [outbox] = await db.select().from(emailOutbox).where(eq(emailOutbox.ticketId, ticketA))
    expect(outbox).toBeDefined()
    const outMessageId = (outbox.messageId as string).replace(/[<>]/g, '')

    const email = await parseEmail(
      makeEml({
        from: 'ada@acme.test',
        to: 'support@kuliklabs.dev',
        subject: 'Re: Printer is on fire',
        messageId: 'in-thread-1@acme.test',
        inReplyTo: outMessageId,
        references: [outMessageId],
        body: 'The fix worked.',
      }),
    )
    expect(await processInboundMessage(email)).toEqual({
      action: 'matched',
      ticketId: ticketA,
      via: 'thread',
    })
  })

  it('creates a ticket for a known contact with no thread signals', async () => {
    const email = await parseEmail(
      makeEml({
        from: 'ada@acme.test',
        fromName: 'Ada Client',
        to: 'support@kuliklabs.dev',
        subject: 'Re: Fwd: VPN down again',
        messageId: 'in-new-1@acme.test',
        body: 'The VPN is down again, cannot connect.',
      }),
    )
    const result = await processInboundMessage(email)
    expect(result.action).toBe('created')
    if (result.action !== 'created') throw new Error('expected a created ticket')
    const createdTicketId = result.ticketId

    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, createdTicketId))
    expect(ticket.clientId).toBe(clientA)
    expect(ticket.subject).toBe('VPN down again')
    expect(ticket.alias).toMatch(/^support\+\d+@kuliklabs\.dev$/)
    expect(ticket.status).toBe('open')

    const [record] = await db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.messageId, 'in-new-1@acme.test'))
    expect(record.status).toBe('created')
    expect(record.ticketId).toBe(createdTicketId)
  })

  it('does not create a ticket for an unknown sender', async () => {
    const before = await db
      .select({ id: tickets.id })
      .from(tickets)
    const email = await parseEmail(
      makeEml({
        from: 'stranger@evil.test',
        fromName: 'Some Stranger',
        to: 'support@kuliklabs.dev',
        subject: 'Re: Printer is on fire',
        messageId: 'in-unknown-1@evil.test',
        body: 'Buy cheap widgets.',
      }),
    )
    const result = await processInboundMessage(email)
    expect(result).toEqual({ action: 'unknown_sender', fromAddress: 'stranger@evil.test' })
    const after = await db.select({ id: tickets.id }).from(tickets)
    expect(after).toHaveLength(before.length)
  })

  it('masks imap credentials and stores them encrypted', async () => {
    const saveRes = await app.inject({
      method: 'POST',
      url: '/api/imap',
      headers: { cookie: staffCookie },
      payload: {
        host: 'imap.kuliklabs.dev',
        port: 993,
        secure: true,
        mailbox: 'INBOX',
        auth: { username: 'support@kuliklabs.dev', password: 'imap-secret' },
      },
    })
    expect(saveRes.statusCode).toBe(200)
    expect(saveRes.json()).toEqual({
      configured: true,
      imap: {
        host: 'imap.kuliklabs.dev',
        port: 993,
        secure: true,
        mailbox: 'INBOX',
        hasAuth: true,
      },
    })

    const getRes = await app.inject({ method: 'GET', url: '/api/imap', headers: { cookie: staffCookie } })
    const json = JSON.stringify(getRes.json())
    expect(json).not.toContain('imap-secret')
    expect(json).not.toContain('support@kuliklabs.dev')

    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'imap'))
    expect(JSON.stringify(row?.value)).toContain('enc1:')
    expect(JSON.stringify(row?.value)).not.toContain('imap-secret')
  })

  it('reports imap test-connection failures without leaking details', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/imap/test-connection',
      headers: { cookie: staffCookie },
      payload: { host: '127.0.0.1', port: 1, secure: false, mailbox: 'INBOX' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(false)
    expect(res.json().detail).toBeTruthy()
  })
})
