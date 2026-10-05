import { createHmac } from 'node:crypto'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import { desc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { decryptAtRest } from '@kipple/shared'
import { db } from './db'
import { runMigrations } from './db/migrate'
import {
  accounts,
  clients,
  settings,
  tickets,
  users,
  webhookDeliveries,
  webhooks,
} from './db/schema'
import { closeWebhooks, processWebhookDelivery } from './webhooks'

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
  await db.delete(webhookDeliveries)
  await db.delete(webhooks)
  await db.delete(tickets)
  await db.delete(accounts)
  await db.delete(users)
  await db.delete(clients)
  await db.delete(settings)
}

interface Captured {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: string
}

// Scriptable sink: each test pushes the status code(s) the endpoint should
// answer with, in order. Anything left over answers 200.
class Sink {
  queue: number[] = []
  captured: Captured[] = []
  server: http.Server
  port = 0

  constructor() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk) => chunks.push(chunk))
      req.on('end', () => {
        const status = this.queue.length > 0 ? (this.queue.shift() ?? 200) : 200
        this.captured.push({
          status,
          headers: req.headers as Captured['headers'],
          body: Buffer.concat(chunks).toString('utf8'),
        })
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: status >= 200 && status < 300 }))
      })
    })
  }

  listen(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address()
        this.port = typeof address === 'object' && address ? address.port : 0
        resolve(this.port)
      })
    })
  }

  close(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()))
  }

  last(): Captured {
    return this.captured[this.captured.length - 1]
  }
}

describe('outbound webhooks', () => {
  let app: App
  let cookie: string
  let agentCookie: string
  let contactCookie: string
  let clientA: string
  let otherClientId: string
  let sink: Sink
  let url: string
  let hookId: string

  beforeAll(async () => {
    await runMigrations()
    await wipe()
    app = await buildApp()
    sink = new Sink()
    await sink.listen()
    url = `http://127.0.0.1:${sink.port}/hook`

    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: owner })
    expect(setup.statusCode).toBe(200)
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: owner.ownerEmail, password: owner.password },
    })
    expect(login.statusCode).toBe(200)
    cookie = cookiesFrom(login)

    const createAgent = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie },
      payload: { name: 'Agent One', email: 'agent@kuliklabs.dev', password: 'agent-pass-12345' },
    })
    expect(createAgent.statusCode).toBe(200) // user.create returns 200 (house pattern)
    const agentLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'agent@kuliklabs.dev', password: 'agent-pass-12345' },
    })
    expect(agentLogin.statusCode).toBe(200)
    agentCookie = cookiesFrom(agentLogin)

    const resA = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie },
      payload: { name: 'Acme Corp', domain: 'acme.test' },
    })
    expect(resA.statusCode).toBe(201)
    clientA = resA.json().id

    const resB = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie },
      payload: { name: 'Beta Corp', domain: 'beta.test' },
    })
    expect(resB.statusCode).toBe(201)
    otherClientId = resB.json().id

    const contactRes = await app.inject({
      method: 'POST',
      url: `/api/clients/${clientA}/contacts`,
      headers: { cookie },
      payload: { name: 'Ada Client', email: 'ada@acme.test' },
    })
    expect(contactRes.statusCode).toBe(201)
    const contactUserId = randomUUID()
    await db.insert(users).values({
      id: contactUserId,
      name: 'Ada Client',
      email: 'ada@acme.test',
      role: 'contact',
      contactId: contactRes.json().id,
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
  })

  afterAll(async () => {
    await app.close()
    await closeWebhooks()
    await sink.close()
    await wipe()
  })

  it('creates a webhook with a runtime-generated secret, masked in reads', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks',
      headers: { cookie },
      payload: { url, events: ['ticket.created', 'ticket.status_changed'] },
    })
    expect(res.statusCode).toBe(201)
    const body = res.json()
    hookId = body.id
    expect(body.url).toBe(url)
    expect(body.events).toEqual(['ticket.created', 'ticket.status_changed'])
    expect(body.enabled).toBe(true)
    expect(body.hasSecret).toBe(true)
    expect(res.headers['content-type']).toContain('application/json')
    expect(JSON.stringify(body)).not.toContain('enc1:')
    expect(JSON.stringify(body)).not.toHaveProperty('secret')

    // at rest: enc1: ciphertext only — the plaintext never touches the DB
    const [row] = await db.select({ secret: webhooks.secret }).from(webhooks)
    expect(row?.secret.startsWith('enc1:')).toBe(true)
    expect(JSON.stringify(row)).not.toMatch(/[0-9a-f]{64}/)
  })

  it('rejects non-superuser writes and unknown events', async () => {
    const agent = await app.inject({
      method: 'POST',
      url: '/api/webhooks',
      headers: { cookie: agentCookie },
      payload: { url, events: ['ticket.created'] },
    })
    expect(agent.statusCode).toBe(403)

    const bad = await app.inject({
      method: 'POST',
      url: '/api/webhooks',
      headers: { cookie },
      payload: { url, events: ['ticket.exploded'] },
    })
    expect(bad.statusCode).toBe(400)
  })

  it('enqueues a delivery row when a subscribed ticket event fires', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie },
      payload: { clientId: clientA, subject: 'Webhook smoke test' },
    })
    expect(res.statusCode).toBe(201)
    const ticketId = res.json().id

    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.ticketId, ticketId))
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('queued')
    expect(rows[0].event).toBe('ticket.created')
    const payload = JSON.parse(rows[0].payload)
    expect(payload.event).toBe('ticket.created')
    expect(payload.ticket.id).toBe(ticketId)
    expect(payload.actor).toMatchObject({ role: 'superuser', system: false })
  })

  it('delivers with an HMAC-SHA256 signature over the raw body', async () => {
    const [row] = await db.select().from(webhookDeliveries).limit(1)
    expect(row).toBeDefined()
    const result = await processWebhookDelivery(row.id)
    expect(result.action).toBe('sent')

    const req = sink.last()
    expect(req.headers['content-type']).toBe('application/json')
    const [stored] = await db.select().from(webhooks)
    const plaintextSecret = decryptAtRest(stored.secret, process.env.AUTH_SECRET!)
    const expected = createHmac('sha256', plaintextSecret).update(req.body).digest('hex')
    expect(req.headers['x-kipple-signature']).toBe(expected)
    // the wire body must be exactly the stored payload (signature basis)
    expect(req.body).toBe(row.payload)

    const [after] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, row.id))
    expect(after.status).toBe('sent')
    expect(after.attempts).toBe(1)
    expect(after.sentAt).toBeInstanceOf(Date)

    const [hook] = await db.select().from(webhooks).where(eq(webhooks.id, stored.id))
    expect(hook.lastStatus).toBe('sent')
    expect(hook.lastError).toBeNull()
    expect(hook.lastDeliveredAt).toBeInstanceOf(Date)
  })

  it('fails fast on 4xx (permanent — no retry is scheduled)', async () => {
    sink.queue.push(404)
    const res = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie },
      payload: { clientId: clientA, subject: 'Permanent failure probe' },
    })
    expect(res.statusCode).toBe(201)
    const [row] = await db
      .select()
      .from(webhookDeliveries)
      .orderBy(desc(webhookDeliveries.createdAt))
    const result = await processWebhookDelivery(row.id)
    expect(result.action).toBe('failed')
    const [after] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, row.id))
    expect(after.status).toBe('failed')
    expect(after.attempts).toBe(1)
    expect(after.error).toContain('404')
    expect(after.nextTryAt).toBeNull() // permanent: nothing scheduled
    expect(after.sentAt).toBeNull()
  })

  it('retries 5xx with exponential backoff (30s first step)', async () => {
    sink.queue.push(500)
    const res = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie },
      payload: { clientId: clientA, subject: 'Transient failure probe' },
    })
    expect(res.statusCode).toBe(201)
    const [row] = await db
      .select()
      .from(webhookDeliveries)
      .orderBy(desc(webhookDeliveries.createdAt))
    const before = Date.now()
    const result = await processWebhookDelivery(row.id)
    expect(result.action).toBe('retry')
    const [after] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, row.id))
    expect(after.status).toBe('queued') // stays queued for the next attempt
    expect(after.attempts).toBe(1)
    expect(after.nextTryAt).toBeInstanceOf(Date)
    const delayMs = after.nextTryAt!.getTime() - before
    expect(delayMs).toBeGreaterThanOrEqual(29_000)
    expect(delayMs).toBeLessThan(31_000)

    // second attempt: the sink now answers 200
    const second = await processWebhookDelivery(row.id)
    expect(second.action).toBe('sent')
    const [final] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, row.id))
    expect(final.attempts).toBe(2)
    expect(final.status).toBe('sent')
  })

  it('does not redeliver an already-sent row', async () => {
    const [row] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.status, 'sent'))
      .limit(1)
    expect(row).toBeDefined()
    const result = await processWebhookDelivery(row.id)
    expect(result).toEqual({ action: 'skipped', reason: 'sent' })
  })

  it('sends a test ping (webhook.test event, no ticket)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhooks/${hookId}/test`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(202)
    const { id } = res.json()
    const result = await processWebhookDelivery(id)
    expect(result.action).toBe('sent')
    const req = sink.last()
    const ping = JSON.parse(req.body)
    expect(ping.event).toBe('webhook.test')
    const [row] = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id))
    expect(row.event).toBe('webhook.test')
    expect(row.ticketId).toBeNull()
  })

  it('lists deliveries with a payload preview, never the full payload', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/webhooks/deliveries?limit=50',
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    const rows = res.json()
    expect(rows.length).toBeGreaterThanOrEqual(4)
    for (const row of rows) {
      expect(row).toHaveProperty('payloadPreview')
      expect(row).not.toHaveProperty('payload')
    }
    const filtered = await app.inject({
      method: 'GET',
      url: '/api/webhooks/deliveries?status=sent',
      headers: { cookie },
    })
    expect(filtered.statusCode).toBe(200)
    expect(filtered.json().every((row: { status: string }) => row.status === 'sent')).toBe(true)
  })

  it('supports manual retry of a failed delivery', async () => {
    const [row] = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.status, 'failed'))
      .limit(1)
    expect(row).toBeDefined()
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhooks/deliveries/${row.id}/retry`,
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('queued')
    expect(res.json().attempts).toBe(0)
    const result = await processWebhookDelivery(row.id)
    expect(result.action).toBe('sent')
  })

  it('patches url/events/enabled and deletes', async () => {
    const second = await app.inject({
      method: 'POST',
      url: '/api/webhooks',
      headers: { cookie },
      payload: { url: 'https://example.invalid/x', events: ['ticket.reply'], enabled: false },
    })
    expect(second.statusCode).toBe(201)
    const secondId = second.json().id

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/webhooks/${secondId}`,
      headers: { cookie },
      payload: { url: 'https://example.invalid/y', enabled: true },
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().url).toBe('https://example.invalid/y')
    expect(patched.json().enabled).toBe(true)
    expect(patched.json().events).toEqual(['ticket.reply'])

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/webhooks/${secondId}`,
      headers: { cookie },
    })
    expect(del.statusCode).toBe(204)
    const missing = await app.inject({
      method: 'DELETE',
      url: `/api/webhooks/${secondId}`,
      headers: { cookie },
    })
    expect(missing.statusCode).toBe(404)
  })

  it('is staff-only: contacts get 403, never webhook data', async () => {
    // the webhook surface is instance-scoped (AGENTS: webhooks are instance
    // surfaces) — a contact must not list, create, or read deliveries.
    for (const request of [
      { method: 'GET', url: '/api/webhooks' },
      { method: 'GET', url: '/api/webhooks/deliveries' },
      { method: 'POST', url: '/api/webhooks', payload: { url, events: ['ticket.created'] } },
    ] as const) {
      const res = await app.inject({ ...request, headers: { cookie: contactCookie } })
      expect(res.statusCode).toBe(403)
    }
  })

  it('does not deliver to disabled hooks', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks',
      headers: { cookie },
      payload: { url, events: ['ticket.created'], enabled: false },
    })
    expect(res.statusCode).toBe(201)
    const disabledId = res.json().id

    // a created ticket fires ticket.created; the enabled hook gets a row, the
    // disabled one must not
    const ticket = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie },
      payload: { clientId: otherClientId, subject: 'Disabled hook must stay silent' },
    })
    expect(ticket.statusCode).toBe(201)
    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.webhookId, disabledId))
    expect(rows).toHaveLength(0)
  })
})
