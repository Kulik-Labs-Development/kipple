import { randomUUID } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { db } from './db'
import { runMigrations } from './db/migrate'
import {
  accounts,
  alertSignatures,
  clients,
  emailOutbox,
  notifications,
  settings,
  tickets,
  updates,
  users,
  webhookDeliveries,
  webhooks,
} from './db/schema'
import { closeWebhooks } from './webhooks'

type App = Awaited<ReturnType<typeof buildApp>>

// All fixtures are FAKE data (fake vendors, fake monitors, no real secrets).
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
  await db.delete(alertSignatures) // before tickets (the FK cascades, be explicit)
  await db.delete(tickets)
  await db.delete(accounts)
  await db.delete(users)
  await db.delete(clients)
  await db.delete(settings)
}

async function makeContact(
  app: App,
  cookie: string,
  clientId: string,
  name: string,
  email: string,
  password: string,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/api/clients/${clientId}/contacts`,
    headers: { cookie },
    payload: { name, email },
  })
  expect(res.statusCode).toBe(201)
  const userId = randomUUID()
  await db.insert(users).values({
    id: userId,
    name,
    email,
    role: 'contact',
    contactId: res.json().id,
  })
  await db.insert(accounts).values({
    id: randomUUID(),
    providerId: 'credential',
    issuer: 'local:credential',
    accountId: userId,
    userId,
    password: await hashPassword(password),
  })
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email, password },
  })
  expect(login.statusCode).toBe(200)
  return cookiesFrom(login)
}

const kumaDown = {
  heartbeat: { monitorID: 42, status: 0, msg: 'Ping failed: timeout' },
  monitor: { name: 'Acme Portal', url: 'https://portal.acme.test' },
  msg: 'Ping failed: timeout',
}
const kumaUp = {
  heartbeat: { monitorID: 42, status: 1, msg: 'Ping recovered' },
  monitor: { name: 'Acme Portal', url: 'https://portal.acme.test' },
  msg: 'Ping recovered',
}

function secretFrom(url: string): string {
  return url.split('/').pop() ?? ''
}

describe('inbound NMS webhooks (vendor route -> tickets)', () => {
  let app: App
  let cookie: string // superuser
  let agentCookie: string
  let contactACookie: string // contact on clientA (the default client)
  let contactBCookie: string // contact on clientB (must NOT see NMS tickets)
  let clientA: string
  let clientB: string
  let kumaSecret: string
  let nmsTicketId: string
  let nmsNumber: number

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
    clientB = resB.json().id

    contactACookie = await makeContact(app, cookie, clientA, 'Ada Client', 'ada@acme.test', 'ada-contact-pass')
    contactBCookie = await makeContact(app, cookie, clientB, 'Ben Client', 'ben@beta.test', 'ben-contact-pass')

    // Inbound config: default client = clientA, kuma enabled.
    const setDefault = await app.inject({
      method: 'POST',
      url: '/api/webhooks/inbound',
      headers: { cookie },
      payload: { clientId: clientA },
    })
    expect(setDefault.statusCode).toBe(200)
    expect(setDefault.json().defaultClientId).toBe(clientA)

    const enable = await app.inject({
      method: 'POST',
      url: '/api/webhooks/inbound/kuma',
      headers: { cookie },
      payload: { enabled: true },
    })
    expect(enable.statusCode).toBe(200)
    kumaSecret = secretFrom(enable.json().url as string)
    expect(kumaSecret).toMatch(/^[0-9a-f]{32}$/)
    expect(enable.json().url).toBe(
      `${process.env.PUBLIC_URL}/api/webhooks/inbound/kuma/${kumaSecret}`,
    )

    // An outbound webhook subscribed to ticket.created: proves the fan-out
    // path is live, so "the NMS ticket produced no delivery row" is
    // meaningful (next test is the control).
    const hook = await app.inject({
      method: 'POST',
      url: '/api/webhooks',
      headers: { cookie },
      payload: { url: 'http://127.0.0.1:1/hook', events: ['ticket.created'] },
    })
    expect(hook.statusCode).toBe(201)
  })

  afterAll(async () => {
    await app.close()
    await closeWebhooks()
    await wipe()
  })

  it('lists all seven sources, with the full URL only for enabled ones', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/webhooks/inbound', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    const rows = res.json()
    expect(rows.map((row: { source: string }) => row.source)).toEqual([
      'prtg',
      'zabbix',
      'watcher',
      'uptimerobot',
      'kuma',
      'onlineornot',
      'custom',
    ])
    for (const row of rows) {
      if (row.source === 'kuma') {
        expect(row.enabled).toBe(true)
        expect(row.url).toBe(`${process.env.PUBLIC_URL}/api/webhooks/inbound/kuma/${kumaSecret}`)
      } else {
        expect(row.enabled).toBe(false)
        expect(row.url).toBeNull()
      }
      // The secret (or its ciphertext) never appears in the read response.
      expect(JSON.stringify(row)).not.toContain('enc1:')
      expect(row).not.toHaveProperty('secret')
    }
  })

  it('creates a ticket on the default client for a vendor down alert (no cookie)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhooks/inbound/kuma/${kumaSecret}`,
      payload: kumaDown,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('created')
    nmsTicketId = body.ticketId
    nmsNumber = body.number
    expect(typeof nmsTicketId).toBe('string')
    expect(typeof nmsNumber).toBe('number')

    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, nmsTicketId))
    expect(ticket.clientId).toBe(clientA)
    expect(ticket.subject).toBe('[kuma] Acme Portal is down')
    expect(ticket.status).toBe('open')
    expect(ticket.priority).toBe('normal')
    expect(ticket.createdBy).toBeNull()
    expect(ticket.tags).toEqual(['nms:kuma'])
    expect(ticket.alias).toBe(`support+${nmsNumber}@kipple.local`)

    const updateRows = await db.select().from(updates).where(eq(updates.ticketId, nmsTicketId))
    expect(updateRows).toHaveLength(1)
    expect(updateRows[0].body).toContain('NMS alert (kuma): Acme Portal is DOWN')
    expect(updateRows[0].body).toContain('Ping failed: timeout')
    expect(updateRows[0].body).toContain('Source: https://portal.acme.test')
    expect(updateRows[0].authorId).toBeNull()

    // The signature row now dedupes repeats for (kuma, monitor 42).
    const sigs = await db
      .select()
      .from(alertSignatures)
      .where(and(eq(alertSignatures.source, 'kuma'), eq(alertSignatures.signature, '42')))
    expect(sigs).toHaveLength(1)
    expect(sigs[0].ticketId).toBe(nmsTicketId)
    expect(sigs[0].state).toBe('open')

    // Nothing auto-sends: no outbound delivery, no email, no notification.
    const deliveries = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.ticketId, nmsTicketId))
    expect(deliveries).toHaveLength(0)
    expect(await db.select().from(emailOutbox)).toHaveLength(0)
    const notes = await db
      .select()
      .from(notifications)
      .where(eq(notifications.ticketId, nmsTicketId))
    expect(notes).toHaveLength(0)
  })

  it('keeps firing outbound fan-out for regular tickets (control)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie },
      payload: { clientId: clientB, subject: 'Control ticket' },
    })
    expect(res.statusCode).toBe(201)
    const rows = await db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.ticketId, res.json().id))
    expect(rows).toHaveLength(1)
    expect(rows[0].event).toBe('ticket.created')
  })

  it('updates the open ticket on a repeat down alert (never a second ticket)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhooks/inbound/kuma/${kumaSecret}`,
      payload: kumaDown,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'updated', ticketId: nmsTicketId, number: nmsNumber })
    const updateRows = await db.select().from(updates).where(eq(updates.ticketId, nmsTicketId))
    expect(updateRows).toHaveLength(2)
    const sigs = await db.select().from(alertSignatures).where(eq(alertSignatures.signature, '42'))
    expect(sigs).toHaveLength(1)
  })

  it('closes the open ticket on a recovery (up) alert', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhooks/inbound/kuma/${kumaSecret}`,
      payload: kumaUp,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'closed', ticketId: nmsTicketId, number: nmsNumber })
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, nmsTicketId))
    expect(ticket.status).toBe('closed')
    const [sig] = await db.select().from(alertSignatures).where(eq(alertSignatures.signature, '42'))
    expect(sig.state).toBe('closed')
  })

  it('treats a second recovery as a noop', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhooks/inbound/kuma/${kumaSecret}`,
      payload: kumaUp,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'noop', ticketId: null, number: null })
  })

  it('opens a fresh episode (new ticket) when down arrives after a close', async () => {
    const before = await db.select({ id: tickets.id }).from(tickets)
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhooks/inbound/kuma/${kumaSecret}`,
      payload: kumaDown,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('created')
    const secondId = res.json().ticketId as string
    expect(secondId).not.toBe(nmsTicketId)
    const after = await db.select({ id: tickets.id }).from(tickets)
    expect(after).toHaveLength(before.length + 1)
    const [sig] = await db.select().from(alertSignatures).where(eq(alertSignatures.signature, '42'))
    expect(sig.ticketId).toBe(secondId)
    expect(sig.state).toBe('open')
  })

  it('accepts UptimeRobot form-encoded bodies', async () => {
    const enable = await app.inject({
      method: 'POST',
      url: '/api/webhooks/inbound/uptimerobot',
      headers: { cookie },
      payload: { enabled: true },
    })
    expect(enable.statusCode).toBe(200)
    const secret = secretFrom(enable.json().url as string)
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhooks/inbound/uptimerobot/${secret}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload:
        'monitorID=90210&alertType=1&monitorFriendlyName=Beta+API&monitorURL=https%3A%2F%2Fapi.beta.test&alertDetails=HTTP+500',
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().status).toBe('created')
    const [ticket] = await db.select().from(tickets).where(eq(tickets.id, res.json().ticketId))
    expect(ticket.subject).toBe('[uptimerobot] Beta API is down')
  })

  it('answers 404 for unknown sources and a generic 401 for bad or disabled secrets', async () => {
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/webhooks/inbound/nosuch/0123456789abcdef0123456789abcdef',
      payload: kumaDown,
    })
    expect(unknown.statusCode).toBe(404)

    const wrong = await app.inject({
      method: 'POST',
      url: `/api/webhooks/inbound/kuma/${'f'.repeat(32)}`,
      payload: kumaDown,
    })
    expect(wrong.statusCode).toBe(401)

    const short = await app.inject({
      method: 'POST',
      url: '/api/webhooks/inbound/kuma/x',
      payload: kumaDown,
    })
    expect(short.statusCode).toBe(401)

    // Disabled source: the SAME generic 401 even with the real secret
    // (no enablement oracle).
    const enable = await app.inject({
      method: 'POST',
      url: '/api/webhooks/inbound/zabbix',
      headers: { cookie },
      payload: { enabled: true },
    })
    expect(enable.statusCode).toBe(200)
    const zabbixSecret = secretFrom(enable.json().url as string)
    const disable = await app.inject({
      method: 'POST',
      url: '/api/webhooks/inbound/zabbix',
      headers: { cookie },
      payload: { enabled: false },
    })
    expect(disable.statusCode).toBe(200)
    expect(disable.json().url).toBeNull()
    const disabled = await app.inject({
      method: 'POST',
      url: `/api/webhooks/inbound/zabbix/${zabbixSecret}`,
      payload: { event: { id: 1, status: 0 }, host: { name: 'h' }, trigger: { id: 2, name: 't' } },
    })
    expect(disabled.statusCode).toBe(401)
  })

  it('answers 400 for payloads the source parser does not recognize', async () => {
    const empty = await app.inject({
      method: 'POST',
      url: `/api/webhooks/inbound/kuma/${kumaSecret}`,
      payload: {},
    })
    expect(empty.statusCode).toBe(400)
    const garbage = await app.inject({
      method: 'POST',
      url: `/api/webhooks/inbound/kuma/${kumaSecret}`,
      headers: { 'content-type': 'text/plain' },
      payload: 'not a payload',
    })
    expect(garbage.statusCode).toBe(400)
    const pending = await app.inject({
      method: 'POST',
      url: `/api/webhooks/inbound/kuma/${kumaSecret}`,
      payload: { heartbeat: { monitorID: 42, status: 2 }, monitor: { name: 'x' } },
    })
    expect(pending.statusCode).toBe(400)
  })

  it('answers 409 while no default client is configured', async () => {
    const clear = await app.inject({
      method: 'POST',
      url: '/api/webhooks/inbound',
      headers: { cookie },
      payload: { clientId: null },
    })
    expect(clear.statusCode).toBe(200)
    expect(clear.json().defaultClientId).toBeNull()

    const enable = await app.inject({
      method: 'POST',
      url: '/api/webhooks/inbound/onlineornot',
      headers: { cookie },
      payload: { enabled: true },
    })
    expect(enable.statusCode).toBe(200)
    const secret = secretFrom(enable.json().url as string)
    const res = await app.inject({
      method: 'POST',
      url: `/api/webhooks/inbound/onlineornot/${secret}`,
      payload: { event: 'uptime.down', name: 'Shopfront', url: 'https://shop.acme.test' },
    })
    expect(res.statusCode).toBe(409)

    const restore = await app.inject({
      method: 'POST',
      url: '/api/webhooks/inbound',
      headers: { cookie },
      payload: { clientId: clientA },
    })
    expect(restore.statusCode).toBe(200)
    expect(restore.json().defaultClientId).toBe(clientA)
  })

  it('rejects a default client id that does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/inbound',
      headers: { cookie },
      payload: { clientId: 'no-such-client' },
    })
    expect(res.statusCode).toBe(404)
  })

  it('rotates a source secret: the old URL stops working, the new one works', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/webhooks/inbound/kuma',
      headers: { cookie },
      payload: { rotate: true },
    })
    expect(res.statusCode).toBe(200)
    const view = res.json()
    expect(view.enabled).toBe(true)
    const newSecret = secretFrom(view.url as string)
    expect(newSecret).not.toBe(kumaSecret)
    kumaSecret = newSecret

    const stale = await app.inject({
      method: 'POST',
      url: `/api/webhooks/inbound/kuma/${'f'.repeat(32)}`,
      payload: kumaDown,
    })
    expect(stale.statusCode).toBe(401)

    const fresh = await app.inject({
      method: 'POST',
      url: `/api/webhooks/inbound/kuma/${newSecret}`,
      payload: kumaDown,
    })
    expect(fresh.statusCode).toBe(200)
    expect(fresh.json().status).toBe('updated')
  })

  it('is staff-readable and superuser-writable (contacts have no access)', async () => {
    const agentRead = await app.inject({
      method: 'GET',
      url: '/api/webhooks/inbound',
      headers: { cookie: agentCookie },
    })
    expect(agentRead.statusCode).toBe(200)
    const agentWrite = await app.inject({
      method: 'POST',
      url: '/api/webhooks/inbound/kuma',
      headers: { cookie: agentCookie },
      payload: { enabled: false },
    })
    expect(agentWrite.statusCode).toBe(403)
    const agentDefault = await app.inject({
      method: 'POST',
      url: '/api/webhooks/inbound',
      headers: { cookie: agentCookie },
      payload: { clientId: null },
    })
    expect(agentDefault.statusCode).toBe(403)

    const contactRead = await app.inject({
      method: 'GET',
      url: '/api/webhooks/inbound',
      headers: { cookie: contactACookie },
    })
    expect(contactRead.statusCode).toBe(403)
    const contactWrite = await app.inject({
      method: 'POST',
      url: '/api/webhooks/inbound/kuma',
      headers: { cookie: contactACookie },
      payload: { rotate: true },
    })
    expect(contactWrite.statusCode).toBe(403)
  })

  it('scopes the NMS ticket to its client: client B never sees it', async () => {
    // The signature->ticket lookup is a query feature; the ticket lands on
    // the default client (A). A contact on client B must get a generic 404
    // and must not see the ticket in their list (AGENTS client-scoping rule).
    const listB = await app.inject({
      method: 'GET',
      url: '/api/tickets',
      headers: { cookie: contactBCookie },
    })
    expect(listB.statusCode).toBe(200)
    expect(listB.json().every((row: { id: string }) => row.id !== nmsTicketId)).toBe(true)

    const direct = await app.inject({
      method: 'GET',
      url: `/api/tickets/${nmsTicketId}`,
      headers: { cookie: contactBCookie },
    })
    expect(direct.statusCode).toBe(404)

    const updateAttempt = await app.inject({
      method: 'POST',
      url: `/api/tickets/${nmsTicketId}/updates`,
      headers: { cookie: contactBCookie },
      payload: { body: 'snooping' },
    })
    expect(updateAttempt.statusCode).toBe(404)

    // The client A contact can see it — the ticket is a normal A ticket.
    const listA = await app.inject({
      method: 'GET',
      url: '/api/tickets',
      headers: { cookie: contactACookie },
    })
    expect(listA.statusCode).toBe(200)
    expect(listA.json().some((row: { id: string }) => row.id === nmsTicketId)).toBe(true)
    const directA = await app.inject({
      method: 'GET',
      url: `/api/tickets/${nmsTicketId}`,
      headers: { cookie: contactACookie },
    })
    expect(directA.statusCode).toBe(200)
  })
})
