import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { hashPassword } from 'better-auth/crypto'
import { addBusinessMinutes, businessMinutesBetween } from '@kipple/shared'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { db } from './db'
import { runMigrations } from './db/migrate'
import {
  accounts,
  audit,
  clients,
  contactClients,
  contacts,
  settings,
  slaPolicies,
  tickets,
  updates,
  users,
  verifications,
} from './db/schema'
import { tickSla } from './sla'

type App = Awaited<ReturnType<typeof buildApp>>

const owner = {
  instanceName: 'Kulik Labs IT',
  ownerName: 'Max Kulik',
  ownerEmail: 'max@kuliklabs.dev',
  password: 'correct-horse-battery',
}

const targets = (response: number, resolve: number) => ({
  responseMinutes: { low: response, normal: response, high: response, urgent: response },
  resolveMinutes: { low: resolve, normal: resolve, high: resolve, urgent: resolve },
})

function cookiesFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie']
  const list = Array.isArray(raw) ? raw : [raw]
  return list
    .filter(Boolean)
    .map((cookie) => String(cookie).split(';')[0])
    .join('; ')
}

async function wipe() {
  await db.delete(verifications)
  await db.delete(audit)
  await db.delete(updates)
  await db.delete(tickets)
  await db.delete(contactClients)
  await db.delete(contacts)
  await db.delete(slaPolicies)
  await db.delete(clients)
  await db.delete(users)
  await db.delete(settings)
}

// A fixed past Monday so business-hours math is deterministic.
const PAST_MONDAY = new Date(Date.UTC(2026, 7, 24, 10, 0))

describe('SLA feature (enable-able, off by default)', () => {
  let app: App
  let superCookie: string
  let agentCookie: string
  let clientA: string
  let clientB: string
  let standardPolicy: string
  let premiumPolicy: string

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
    superCookie = cookiesFrom(login)

    // a plain agent (read access to SLA, no management)
    const agentId = randomUUID()
    await db.insert(users).values({
      id: agentId,
      name: 'Agent One',
      email: 'agent@kuliklabs.dev',
      role: 'agent',
    })
    await db.insert(accounts).values({
      id: randomUUID(),
      providerId: 'credential',
      issuer: 'local:credential',
      accountId: agentId,
      userId: agentId,
      password: await hashPassword('agent-pass-12345'),
    })
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
      headers: { cookie: superCookie },
      payload: { name: 'Acme Corp', domain: 'acme.test' },
    })
    clientA = resA.json().id
    const resB = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie: superCookie },
      payload: { name: 'Globex', domain: 'globex.test' },
    })
    clientB = resB.json().id
  })

  afterAll(async () => {
    await app.close()
    await wipe()
  })

  it('is disabled by default and tickets have no SLA fields', async () => {
    const config = await app.inject({
      method: 'GET',
      url: '/api/sla/config',
      headers: { cookie: agentCookie },
    })
    expect(config.statusCode).toBe(200)
    expect(config.json().enabled).toBe(false)

    const ticket = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: superCookie },
      payload: { clientId: clientA, subject: 'no sla yet' },
    })
    expect(ticket.statusCode).toBe(201)
    expect(ticket.json().slaResponseDueAt).toBeNull()
    expect(ticket.json().slaPolicyId).toBeNull()
  })

  it('manages policies and settings (superuser only)', async () => {
    // staff cannot manage
    const agentPost = await app.inject({
      method: 'POST',
      url: '/api/sla/policies',
      headers: { cookie: agentCookie },
      payload: { name: 'Rogue', targets: targets(60, 240) },
    })
    expect(agentPost.statusCode).toBe(403)
    const agentSettings = await app.inject({
      method: 'POST',
      url: '/api/sla/settings',
      headers: { cookie: agentCookie },
      payload: { enabled: true },
    })
    expect(agentSettings.statusCode).toBe(403)

    const created = await app.inject({
      method: 'POST',
      url: '/api/sla/policies',
      headers: { cookie: superCookie },
      payload: { name: 'Standard', targets: targets(120, 600), isDefault: true },
    })
    expect(created.statusCode).toBe(201)
    standardPolicy = created.json().id
    expect(created.json().isDefault).toBe(true)

    const dup = await app.inject({
      method: 'POST',
      url: '/api/sla/policies',
      headers: { cookie: superCookie },
      payload: { name: 'Standard', targets: targets(60, 240) },
    })
    expect(dup.statusCode).toBe(409)

    const premium = await app.inject({
      method: 'POST',
      url: '/api/sla/policies',
      headers: { cookie: superCookie },
      payload: { name: 'Premium', targets: targets(30, 120) },
    })
    premiumPolicy = premium.json().id
    const [rows] = await db
      .select()
      .from(slaPolicies)
      .where(eq(slaPolicies.id, premiumPolicy))
    expect(rows.isDefault).toBe(false) // a new default demoted none, but premium is not default

    const listed = await app.inject({
      method: 'GET',
      url: '/api/sla/policies',
      headers: { cookie: agentCookie },
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().map((p: { name: string }) => p.name).sort()).toEqual([
      'Premium',
      'Standard',
    ])

    // business hours: superuser only, validated
    const badHours = await app.inject({
      method: 'POST',
      url: '/api/sla/business-hours',
      headers: { cookie: superCookie },
      payload: {
        timezone: 'UTC',
        windows: [
          { day: 1, start: '09:00', end: '17:00' },
          { day: 1, start: '10:00', end: '11:00' },
        ],
      },
    })
    expect(badHours.statusCode).toBe(400)
    const hours = await app.inject({
      method: 'POST',
      url: '/api/sla/business-hours',
      headers: { cookie: superCookie },
      payload: {
        timezone: 'UTC',
        windows: [1, 2, 3, 4, 5].map((day) => ({ day, start: '08:00', end: '16:00' })),
      },
    })
    expect(hours.statusCode).toBe(200)

    const enable = await app.inject({
      method: 'POST',
      url: '/api/sla/settings',
      headers: { cookie: superCookie },
      payload: { enabled: true },
    })
    expect(enable.statusCode).toBe(200)
    const config = await app.inject({
      method: 'GET',
      url: '/api/sla/config',
      headers: { cookie: superCookie },
    })
    expect(config.json().enabled).toBe(true)
    expect(config.json().businessHours.windows[0]).toEqual({ day: 1, start: '08:00', end: '16:00' })
  })

  it('resolves policy precedence: ticket > client > instance default', async () => {
    const businessHours = await (
      await app.inject({ method: 'GET', url: '/api/sla/config', headers: { cookie: superCookie } })
    ).json().businessHours

    // default policy (no client policy on A)
    const t1 = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: superCookie },
      payload: { clientId: clientA, subject: 'default policy ticket' },
    })
    const row1 = t1.json()
    expect(row1.slaPolicyId).toBe(standardPolicy)
    expect(
      businessMinutesBetween(new Date(row1.createdAt), new Date(row1.slaResponseDueAt), businessHours),
    ).toBe(120)
    expect(
      businessMinutesBetween(new Date(row1.createdAt), new Date(row1.slaResolveDueAt), businessHours),
    ).toBe(600)

    // client policy on B
    const patchClient = await app.inject({
      method: 'PATCH',
      url: `/api/clients/${clientB}`,
      headers: { cookie: superCookie },
      payload: { slaPolicyId: premiumPolicy },
    })
    expect(patchClient.statusCode).toBe(200)
    const t2 = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: superCookie },
      payload: { clientId: clientB, subject: 'client policy ticket' },
    })
    expect(t2.json().slaPolicyId).toBe(premiumPolicy)
    expect(
      businessMinutesBetween(
        new Date(t2.json().createdAt),
        new Date(t2.json().slaResponseDueAt),
        businessHours,
      ),
    ).toBe(30)

    // ticket-level override beats the client policy
    const override = await app.inject({
      method: 'PATCH',
      url: `/api/tickets/${t2.json().id}`,
      headers: { cookie: superCookie },
      payload: { slaPolicyId: standardPolicy },
    })
    expect(override.statusCode).toBe(200)
    expect(override.json().slaPolicyId).toBe(standardPolicy)
    expect(
      businessMinutesBetween(
        new Date(override.json().createdAt),
        new Date(override.json().slaResponseDueAt),
        businessHours,
      ),
    ).toBe(120)
    void row1
  })

  it('recomputes due times when priority changes', async () => {
    const businessHours = (
      await (
        await app.inject({ method: 'GET', url: '/api/sla/config', headers: { cookie: superCookie } })
      ).json()
    ).businessHours
    const t = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: superCookie },
      payload: { clientId: clientA, subject: 'priority change', priority: 'normal' },
    })
    const before = t.json()
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/tickets/${before.id}`,
      headers: { cookie: superCookie },
      payload: { priority: 'urgent' },
    })
    expect(patch.statusCode).toBe(200)
    const after = patch.json()
    expect(after.priority).toBe('urgent')
    // the clock restarts on the change: the due time is re-derived from now
    expect(new Date(after.slaResponseDueAt).getTime()).toBeGreaterThanOrEqual(
      new Date(before.slaResponseDueAt).getTime(),
    )
    const elapsed = businessMinutesBetween(
      new Date(after.createdAt),
      new Date(after.slaResponseDueAt),
      businessHours,
    )
    expect([120, 121]).toContain(elapsed)
  })

  it('marks the response met on the first staff reply, with a system event', async () => {
    const t = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: superCookie },
      payload: { clientId: clientA, subject: 'reply flow' },
    })
    const ticketId = t.json().id
    const reply = await app.inject({
      method: 'POST',
      url: `/api/tickets/${ticketId}/updates`,
      headers: { cookie: agentCookie },
      payload: { kind: 'public', body: 'on it — looking now' },
    })
    expect(reply.statusCode).toBe(201)
    const detail = await app.inject({
      method: 'GET',
      url: `/api/tickets/${ticketId}`,
      headers: { cookie: superCookie },
    })
    expect(detail.json().slaResponseState).toBe('met')
    expect(detail.json().slaResponseAt).toBeTruthy()
    const systemUpdates = detail.json().updates.filter((u: { kind: string }) => u.kind === 'system')
    expect(systemUpdates).toHaveLength(1)
    expect(systemUpdates[0].body).toContain('SLA response met')
  })

  it('tick: at-risk then breached, with system events (deterministic past dates)', async () => {
    const businessHours = (
      await (
        await app.inject({ method: 'GET', url: '/api/sla/config', headers: { cookie: superCookie } })
      ).json()
    ).businessHours
    const t = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: superCookie },
      payload: { clientId: clientA, subject: 'tick flow' },
    })
    const ticketId = t.json().id
    // pin the row to deterministic past dates: created Mon 10:00, response
    // due Mon 12:00 (120 business minutes at 08:00-16:00)
    const due = addBusinessMinutes(PAST_MONDAY, 120, businessHours)
    await db
      .update(tickets)
      .set({
        createdAt: PAST_MONDAY,
        slaResponseDueAt: due,
        slaResolveDueAt: addBusinessMinutes(PAST_MONDAY, 100000, businessHours),
        slaResponseState: 'pending',
      })
      .where(eq(tickets.id, ticketId))

    // 95 of 120 business minutes elapsed (79% >= 75%) -> at risk
    const atRiskNow = addBusinessMinutes(PAST_MONDAY, 95, businessHours)
    await tickSla(atRiskNow)
    let [row] = await db.select().from(tickets).where(eq(tickets.id, ticketId))
    expect(row.slaResponseState).toBe('at_risk')

    // past the due time -> breached
    const breachedNow = addBusinessMinutes(PAST_MONDAY, 130, businessHours)
    await tickSla(breachedNow)
    ;[row] = await db.select().from(tickets).where(eq(tickets.id, ticketId))
    expect(row.slaResponseState).toBe('breached')

    const systemUpdates = (
      await db.select().from(updates).where(eq(updates.ticketId, ticketId))
    ).filter((u) => u.kind === 'system')
    const bodies = systemUpdates.map((u) => u.body)
    expect(bodies.some((b) => b.includes('SLA response at risk'))).toBe(true)
    expect(bodies.some((b) => b.includes('SLA response breached'))).toBe(true)
    const actions = new Set(
      (await db.select({ action: audit.action }).from(audit)).map((a) => a.action),
    )
    expect(actions.has('sla.response.at_risk')).toBe(true)
    expect(actions.has('sla.response.breached')).toBe(true)
  })

  it('marks resolve met on close before the due time', async () => {
    const t = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: superCookie },
      payload: { clientId: clientA, subject: 'resolve flow' },
    })
    const ticketId = t.json().id
    const close = await app.inject({
      method: 'PATCH',
      url: `/api/tickets/${ticketId}`,
      headers: { cookie: superCookie },
      payload: { status: 'closed' },
    })
    expect(close.statusCode).toBe(200)
    const detail = await app.inject({
      method: 'GET',
      url: `/api/tickets/${ticketId}`,
      headers: { cookie: superCookie },
    })
    expect(detail.json().slaResolveState).toBe('met')
    expect(detail.json().slaResolvedAt).toBeTruthy()
    const systemUpdates = detail.json().updates.filter((u: { kind: string }) => u.kind === 'system')
    expect(systemUpdates.some((u: { body: string }) => u.body.includes('SLA resolve met'))).toBe(true)
  })

  it('hides SLA fields from contact users', async () => {
    const contactRes = await app.inject({
      method: 'POST',
      url: `/api/clients/${clientA}/contacts`,
      headers: { cookie: superCookie },
      payload: { name: 'Ada Client', email: 'ada@acme.test' },
    })
    const contactId = contactRes.json().id
    const userId = randomUUID()
    await db.insert(users).values({
      id: userId,
      name: 'Ada Client',
      email: 'ada@acme.test',
      role: 'contact',
      contactId,
    })
    await db.insert(accounts).values({
      id: randomUUID(),
      providerId: 'credential',
      issuer: 'local:credential',
      accountId: userId,
      userId,
      password: await hashPassword('ada-contact-pass'),
    })
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'ada@acme.test', password: 'ada-contact-pass' },
    })
    const adaCookie = cookiesFrom(login)

    const list = await app.inject({ method: 'GET', url: '/api/tickets', headers: { cookie: adaCookie } })
    expect(list.statusCode).toBe(200)
    for (const row of list.json()) {
      expect(row.slaResponseDueAt).toBeUndefined()
      expect(row.slaResolveDueAt).toBeUndefined()
      expect(row.slaResponseState).toBeUndefined()
    }
    const [first] = list.json()
    const detail = await app.inject({
      method: 'GET',
      url: `/api/tickets/${first.id}`,
      headers: { cookie: adaCookie },
    })
    expect(detail.statusCode).toBe(200)
    expect(detail.json().slaPolicyId).toBeUndefined()
    expect(detail.json().slaResponseDueAt).toBeUndefined()
    expect(detail.json().slaResolveDueAt).toBeUndefined()

    // staff still see them
    const staffDetail = await app.inject({
      method: 'GET',
      url: `/api/tickets/${first.id}`,
      headers: { cookie: superCookie },
    })
    expect(staffDetail.json().slaResponseDueAt).not.toBeNull()
  })

  it('stops attaching SLA when disabled', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/sla/settings',
      headers: { cookie: superCookie },
      payload: { enabled: false },
    })
    const t = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: superCookie },
      payload: { clientId: clientA, subject: 'sla off' },
    })
    expect(t.json().slaPolicyId).toBeNull()
    expect(t.json().slaResponseDueAt).toBeNull()
    expect(t.json().slaResolveDueAt).toBeNull()
    await app.inject({
      method: 'POST',
      url: '/api/sla/settings',
      headers: { cookie: superCookie },
      payload: { enabled: true },
    })
  })
})
