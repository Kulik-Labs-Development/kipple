import { randomUUID } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import { eq } from 'drizzle-orm'
import { SMTPServer } from 'smtp-server'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { db } from './db'
import { runMigrations } from './db/migrate'
import {
  accounts,
  clients,
  contactClients,
  contacts,
  emailOutbox,
  settings,
  tickets,
  updates,
  users,
} from './db/schema'
import { closeMail, processOutboxJob } from './mail'

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
  await db.delete(emailOutbox)
  await db.delete(updates)
  await db.delete(tickets)
  await db.delete(contactClients)
  await db.delete(contacts)
  await db.delete(clients)
  await db.delete(users)
  await db.delete(settings)
}

interface TestMailServer {
  port: number
  captured: Array<{ mailFrom: string; rcptTo: string[]; data: string }>
  close: () => Promise<void>
}

function startMailServer() {
  const captured: TestMailServer['captured'] = []
  const server = new SMTPServer({
    authOptional: true,
    allowInsecureAuth: true,
    secure: false,
    disabledCommands: ['STARTTLS'],
    onAuth(_auth, _session, callback) {
      callback(null, { user: 'relay' })
    },
    onMailFrom(address, _session, callback) {
      captured[captured.length - 1].mailFrom = address.address
      callback()
    },
    onRcptTo(address, _session, callback) {
      captured[captured.length - 1].rcptTo.push(address.address)
      callback()
    },
    onData(stream, _session, callback) {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => {
        captured[captured.length - 1].data = Buffer.concat(chunks).toString('utf8')
        callback(null, 'OK')
      })
    },
    onConnect(_session, callback) {
      captured.push({ mailFrom: '', rcptTo: [], data: '' })
      callback()
    },
  })
  return new Promise<TestMailServer>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.server.address()
      resolve({
        port: typeof address === 'object' && address ? address.port : 0,
        captured,
        close: () => new Promise((done) => server.close(done)),
      })
    })
  })
}

describe('email outbox', () => {
  let app: App
  let staffCookie: string
  let contactCookie: string
  let clientA: string
  let contactRecordId: string
  let ticketA: string
  let mailServer: TestMailServer

  beforeAll(async () => {
    await runMigrations()
    await wipe()
    app = await buildApp()
    mailServer = await startMailServer()

    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: owner })
    expect(setup.statusCode).toBe(200)
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: owner.ownerEmail, password: owner.password },
    })
    expect(login.statusCode).toBe(200)
    staffCookie = cookiesFrom(login)

    // Configure the SMTP provider before creating any ticket so ticket
    // aliases carry the configured domain.
    const saveRes = await app.inject({
      method: 'POST',
      url: '/api/email',
      headers: { cookie: staffCookie },
      payload: {
        domain: 'kuliklabs.dev',
        provider: 'smtp',
        smtp: {
          host: '127.0.0.1',
          port: mailServer.port,
          secure: false,
          startTls: false,
          from: 'support@kuliklabs.dev',
          fromName: 'Kulik Labs Support',
          auth: { username: 'relay', password: 'hunter2' },
        },
      },
    })
    expect(saveRes.statusCode).toBe(200)
    expect(saveRes.json().configured).toBe(true)

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
    contactRecordId = contactRes.json().id

    const contactUserId = randomUUID()
    await db.insert(users).values({
      id: contactUserId,
      name: 'Ada Client',
      email: 'ada@acme.test',
      role: 'contact',
      contactId: contactRecordId,
    })
    await db.insert(accounts).values({
      id: randomUUID(),
      providerId: 'credential',
      issuer: 'local:credential',
      accountId: contactUserId,
      userId: contactUserId,
      password: await hashPassword('ada-contact-pass'),
    })
    const contactLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'ada@acme.test', password: 'ada-contact-pass' },
    })
    expect(contactLogin.statusCode).toBe(200)
    contactCookie = cookiesFrom(contactLogin)

    const ticketARes = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: contactCookie },
      payload: { clientId: clientA, subject: 'Printer is on fire', body: 'Please help' },
    })
    expect(ticketARes.statusCode).toBe(201)
    ticketA = ticketARes.json().id
  })

  afterAll(async () => {
    await app.close()
    await closeMail()
    await mailServer.close()
    await wipe()
  })

  it('masks smtp credentials in the settings response', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/email', headers: { cookie: staffCookie } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.configured).toBe(true)
    expect(body.smtp).toMatchObject({
      host: '127.0.0.1',
      port: mailServer.port,
      from: 'support@kuliklabs.dev',
      hasAuth: true,
    })
    const json = JSON.stringify(body)
    expect(json).not.toContain('hunter2')
    expect(json).not.toContain('relay')
  })

  it('stores the smtp password encrypted at rest', async () => {
    const [row] = await db.select({ value: settings.value }).from(settings).where(eq(settings.key, 'email'))
    expect(row).toBeDefined()
    const json = JSON.stringify(row?.value)
    expect(json).toContain('enc1:')
    expect(json).not.toContain('hunter2')
  })

  it('enqueues a client reply when staff post a public update', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/tickets/${ticketA}/updates`,
      headers: { cookie: staffCookie },
      payload: { kind: 'public', body: 'We are looking into it.' },
    })
    expect(res.statusCode).toBe(201)

    const [ticket] = await db.select({ number: tickets.number }).from(tickets).where(eq(tickets.id, ticketA))
    const [outbox] = await db.select().from(emailOutbox).where(eq(emailOutbox.ticketId, ticketA))
    expect(outbox).toBeDefined()
    expect(outbox.status).toBe('queued')
    expect(outbox.to).toBe('ada@acme.test')
    expect(outbox.from).toBe('support@kuliklabs.dev')
    expect(outbox.replyTo).toBe(`support+${ticket.number}@kuliklabs.dev`)
    expect(outbox.subject).toContain(`[KIP-${ticket.number}]`)
    expect(outbox.body).toBe('We are looking into it.')
  })

  it('does not enqueue for internal notes', async () => {
    const before = await countOutbox()
    const res = await app.inject({
      method: 'POST',
      url: `/api/tickets/${ticketA}/updates`,
      headers: { cookie: staffCookie },
      payload: { kind: 'internal', body: 'Internal chatter' },
    })
    expect(res.statusCode).toBe(201)
    expect(await countOutbox()).toBe(before)
  })

  it('does not enqueue when a contact posts an update', async () => {
    const before = await countOutbox()
    const res = await app.inject({
      method: 'POST',
      url: `/api/tickets/${ticketA}/updates`,
      headers: { cookie: contactCookie },
      payload: { kind: 'public', body: 'Still on fire' },
    })
    expect(res.statusCode).toBe(201)
    expect(await countOutbox()).toBe(before)
  })

  it('delivers a queued outbox row via the provider', async () => {
    const [ticket] = await db.select({ number: tickets.number }).from(tickets).where(eq(tickets.id, ticketA))
    const [outbox] = await db.select().from(emailOutbox).where(eq(emailOutbox.ticketId, ticketA))
    expect(outbox).toBeDefined()
    const result = await processOutboxJob(outbox.id)
    expect(result.action).toBe('sent')

    const [after] = await db.select().from(emailOutbox).where(eq(emailOutbox.id, outbox.id))
    expect(after.status).toBe('sent')
    expect(after.attempts).toBe(1)
    expect(after.sentAt).toBeInstanceOf(Date)

    const mail = mailServer.captured[mailServer.captured.length - 1]
    expect(mail.mailFrom).toBe('support@kuliklabs.dev')
    expect(mail.rcptTo).toEqual(['ada@acme.test'])
    expect(mail.data).toContain('To: ada@acme.test')
    expect(mail.data).toContain('From: Kulik Labs Support <support@kuliklabs.dev>')
    expect(mail.data).toContain(`Reply-To: support+${ticket.number}@kuliklabs.dev`)
    expect(mail.data).toContain('We are looking into it.')
  })

  it('is idempotent: a sent row is not reprocessed', async () => {
    const [outbox] = await db.select().from(emailOutbox).where(eq(emailOutbox.ticketId, ticketA))
    const result = await processOutboxJob(outbox.id)
    expect(result).toEqual({ action: 'skipped', reason: 'sent' })
  })

  it('reports provider status for the configured provider', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/outbox/provider', headers: { cookie: staffCookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json().configured).toBe(true)
    expect(res.json().status.ok).toBe(true)
  })

  it('supports one-click test send and lists the outbox log', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/outbox/test',
      headers: { cookie: staffCookie },
      payload: { to: 'ops@kuliklabs.dev' },
    })
    expect(res.statusCode).toBe(202)
    const id = res.json().id

    await processOutboxJob(id)

    const list = await app.inject({ method: 'GET', url: '/api/outbox', headers: { cookie: staffCookie } })
    expect(list.statusCode).toBe(200)
    expect(list.json().some((row: { id: string }) => row.id === id)).toBe(true)
    expect(list.json()[0]).not.toHaveProperty('body')
  })

  it('retries a failed outbox row', async () => {
    const [sent] = await db.select().from(emailOutbox).where(eq(emailOutbox.ticketId, ticketA))
    await db
      .update(emailOutbox)
      .set({ status: 'failed', error: 'simulated', attempts: 3 })
      .where(eq(emailOutbox.id, sent.id))

    const res = await app.inject({
      method: 'POST',
      url: `/api/outbox/${sent.id}/retry`,
      headers: { cookie: staffCookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('queued')
    expect(res.json().attempts).toBe(0)
  })
})

async function countOutbox(): Promise<number> {
  const rows = await db.select({ id: emailOutbox.id }).from(emailOutbox)
  return rows.length
}
