import { randomUUID } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
import { eq } from 'drizzle-orm'
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
  notifications,
  ruleRuns,
  rules,
  settings,
  tickets,
  updates,
  users,
} from './db/schema'
import { tickHolds } from './holds'

type App = Awaited<ReturnType<typeof buildApp>>

const DAY_MS = 86_400_000

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

async function signIn(app: App, email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email, password },
  })
  expect(res.statusCode).toBe(200)
  return cookiesFrom(res)
}

async function createUserRow(name: string, email: string, role: string, password: string): Promise<string> {
  const id = randomUUID()
  await db.insert(users).values({ id, name, email, role })
  await db.insert(accounts).values({
    id: randomUUID(),
    providerId: 'credential',
    issuer: 'local:credential',
    accountId: id,
    userId: id,
    password: await hashPassword(password),
  })
  return id
}

async function wipe() {
  await db.delete(ruleRuns)
  await db.delete(rules)
  await db.delete(updates)
  await db.delete(tickets)
  await db.delete(contactClients)
  await db.delete(contacts)
  await db.delete(notifications)
  await db.delete(clients)
  await db.delete(audit)
  await db.delete(users)
  await db.delete(settings)
}

describe('hold states — waiting on client/vendor, timers, auto-close (issue #30)', () => {
  let app: App
  let superCookie: string
  let agentCookie: string
  let contactCookie: string
  let ownerUserId: string
  let agentUserId: string
  let clientId: string

  beforeAll(async () => {
    await runMigrations()
    await wipe()
    app = await buildApp()
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: owner })
    expect(setup.statusCode).toBe(200)
    superCookie = await signIn(app, owner.ownerEmail, owner.password)
    agentUserId = await createUserRow('Riley Agent', 'riley@kuliklabs.dev', 'agent', 'riley-pass-123')
    agentCookie = await signIn(app, 'riley@kuliklabs.dev', 'riley-pass-123')
    clientId = randomUUID()
    await db.insert(clients).values({ id: clientId, name: 'Acme Robotics' })
    // a portal contact on the same client (for the contact-visibility test)
    const contactUserId = await createUserRow('Ada Client', 'ada@acme.test', 'contact', 'ada-pass-123')
    const contactRowId = randomUUID()
    await db.insert(contacts).values({ id: contactRowId, name: 'Ada Client', email: 'ada@acme.test' })
    await db.update(users).set({ contactId: contactRowId }).where(eq(users.id, contactUserId))
    await db.insert(contactClients).values({ contactId: contactRowId, clientId, isPrimary: true })
    contactCookie = await signIn(app, 'ada@acme.test', 'ada-pass-123')
    const [ownerRow] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, owner.ownerEmail))
    ownerUserId = ownerRow.id
  })

  afterAll(async () => {
    await app.close()
    await wipe()
  })

  it('GET /api/holds returns defaults; staff can read', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/holds', headers: { cookie: superCookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ autoCloseDays: null, warnDays: null })
    const asAgent = await app.inject({ method: 'GET', url: '/api/holds', headers: { cookie: agentCookie } })
    expect(asAgent.statusCode).toBe(200)
  })

  it('POST /api/holds superuser saves settings + audits', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/holds',
      headers: { cookie: superCookie },
      payload: { autoCloseDays: 30, warnDays: 7 },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ autoCloseDays: 30, warnDays: 7 })
    const rows = await db.select().from(audit).where(eq(audit.action, 'hold.settings'))
    expect(rows.length).toBe(1)
    expect(rows[0].actorId).toBe(ownerUserId)
    expect(rows[0].meta).toEqual({ autoCloseDays: 30, warnDays: 7 })
  })

  it('POST /api/holds forbids agents', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/holds',
      headers: { cookie: agentCookie },
      payload: { autoCloseDays: 5, warnDays: null },
    })
    expect(res.statusCode).toBe(403)
  })

  it('POST /api/holds rejects bad combos (400, raw objects)', async () => {
    const equal = await app.inject({
      method: 'POST',
      url: '/api/holds',
      headers: { cookie: superCookie },
      payload: { autoCloseDays: 30, warnDays: 30 },
    })
    expect(equal.statusCode).toBe(400)
    expect(equal.json().error).toBe('bad_request')
    const warnOnly = await app.inject({
      method: 'POST',
      url: '/api/holds',
      headers: { cookie: superCookie },
      payload: { warnDays: 7 },
    })
    expect(warnOnly.statusCode).toBe(400)
    const zeroDays = await app.inject({
      method: 'POST',
      url: '/api/holds',
      headers: { cookie: superCookie },
      payload: { autoCloseDays: 0 },
    })
    expect(zeroDays.statusCode).toBe(400)
    const tooBig = await app.inject({
      method: 'POST',
      url: '/api/holds',
      headers: { cookie: superCookie },
      payload: { autoCloseDays: 400 },
    })
    expect(tooBig.statusCode).toBe(400)
  })

  it('entering hold records the reason and starts the timer', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: superCookie },
      payload: { clientId, subject: 'Waiting on the vendor quote', assignedTo: agentUserId },
    })
    expect(created.statusCode).toBe(201)
    const ticketId = created.json().id
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/tickets/${ticketId}`,
      headers: { cookie: superCookie },
      payload: { status: 'hold', holdOn: 'vendor' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.status).toBe('hold')
    expect(body.holdOn).toBe('vendor')
    expect(typeof body.holdSince).toBe('string')
    expect(new Date(body.holdSince).getTime()).toBeGreaterThan(Date.now() - 5000)
    const [row] = await db.select().from(tickets).where(eq(tickets.id, ticketId))
    expect(row.holdWarnedAt).toBeNull()
    const auditRows = await db
      .select()
      .from(audit)
      .where(eq(audit.action, 'ticket.update'))
    expect(
      auditRows.some((a) => a.entityId === ticketId && (a.meta as { fields?: string[] }).fields?.includes('holdOn')),
    ).toBe(true)
  })

  it('switching the hold reason keeps hold_since (total hold time is the timer)', async () => {
    const list = await db.select({ id: tickets.id }).from(tickets).orderBy(tickets.number)
    const [ticket] = list
    const [before] = await db.select().from(tickets).where(eq(tickets.id, ticket.id))
    expect(before.holdSince).not.toBeNull()
    const originalSince = before.holdSince!.toISOString()
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/tickets/${ticket.id}`,
      headers: { cookie: superCookie },
      payload: { holdOn: 'client' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.holdOn).toBe('client')
    expect(body.holdSince).toBe(originalSince)
  })

  it('leaving hold clears the hold fields', async () => {
    const list = await db.select({ id: tickets.id }).from(tickets).orderBy(tickets.number)
    const [ticket] = list
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/tickets/${ticket.id}`,
      headers: { cookie: superCookie },
      payload: { status: 'open' },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.holdOn).toBeNull()
    expect(body.holdSince).toBeNull()
    expect(body.holdWarnedAt).toBeNull()
  })

  it('tick auto-closes a held ticket (system update, audit, notification, rule)', async () => {
    const settings = await app.inject({
      method: 'POST',
      url: '/api/holds',
      headers: { cookie: superCookie },
      payload: { autoCloseDays: 1, warnDays: null },
    })
    expect(settings.statusCode).toBe(200)
    const created = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: superCookie },
      payload: { clientId, subject: 'Waiting on the vendor firmware', assignedTo: agentUserId },
    })
    const ticketId = created.json().id
    // deterministic: the episode started 2 days ago, policy = 1 day
    await db
      .update(tickets)
      .set({
        status: 'hold',
        holdOn: 'vendor',
        holdSince: new Date(Date.now() - 2 * DAY_MS),
        holdWarnedAt: null,
      })
      .where(eq(tickets.id, ticketId))
    const ruleId = randomUUID()
    await db.insert(rules).values({
      id: ruleId,
      name: 'tag auto-closed holds',
      enabled: true,
      match: { event: 'ticket.status_changed', fromStatus: 'hold' },
      action: { type: 'add_tag', tags: ['auto-closed-hold'] },
    })
    const result = await tickHolds()
    expect(result.closed).toBe(1)
    expect(result.warned).toBe(0)
    const [row] = await db.select().from(tickets).where(eq(tickets.id, ticketId))
    expect(row.status).toBe('closed')
    expect(row.holdOn).toBeNull()
    expect(row.holdSince).toBeNull()
    expect(row.holdWarnedAt).toBeNull()
    expect(row.tags).toContain('auto-closed-hold')
    const sysUpdates = await db
      .select()
      .from(updates)
      .where(eq(updates.ticketId, ticketId))
    expect(
      sysUpdates.some(
        (u) =>
          u.kind === 'system' &&
          u.authorId === null &&
          /auto-closed after 1 days on hold \(waiting on vendor\)/.test(u.body),
      ),
    ).toBe(true)
    const auditRows = await db.select().from(audit).where(eq(audit.action, 'ticket.hold_auto_close'))
    expect(auditRows.length).toBe(1)
    expect(auditRows[0].actorId).toBeNull()
    expect(auditRows[0].entityId).toBe(ticketId)
    const notices = await db.select().from(notifications).where(eq(notifications.ticketId, ticketId))
    expect(notices.some((n) => n.userId === agentUserId && n.event === 'ticket.status_changed')).toBe(true)
    const runs = await db.select().from(ruleRuns).where(eq(ruleRuns.ruleId, ruleId))
    expect(runs.length).toBe(1)
    expect(runs[0].event).toBe('ticket.status_changed')
    expect(runs[0].result).toBe('ok')
    await db.delete(rules).where(eq(rules.id, ruleId))
  })

  it('tick warns once before auto-close — no duplicate on re-tick', async () => {
    const settings = await app.inject({
      method: 'POST',
      url: '/api/holds',
      headers: { cookie: superCookie },
      payload: { autoCloseDays: 30, warnDays: 7 },
    })
    expect(settings.statusCode).toBe(200)
    const created = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: superCookie },
      payload: { clientId, subject: 'Waiting on the client sign-off', assignedTo: agentUserId },
    })
    const ticketId = created.json().id
    // deterministic: 24 days on hold of a 30-day policy → inside the 7-day
    // warning window, 6 days before auto-close
    await db
      .update(tickets)
      .set({
        status: 'hold',
        holdOn: 'client',
        holdSince: new Date(Date.now() - 24 * DAY_MS),
        holdWarnedAt: null,
      })
      .where(eq(tickets.id, ticketId))
    const ruleId = randomUUID()
    await db.insert(rules).values({
      id: ruleId,
      name: 'tag hold warnings',
      enabled: true,
      match: { event: 'ticket.hold_warning' },
      action: { type: 'add_tag', tags: ['hold-warning'] },
    })
    const result = await tickHolds()
    expect(result.warned).toBe(1)
    expect(result.closed).toBe(0)
    const [row] = await db.select().from(tickets).where(eq(tickets.id, ticketId))
    expect(row.status).toBe('hold')
    expect(row.holdWarnedAt).not.toBeNull()
    expect(row.tags).toContain('hold-warning')
    const warnings = async () =>
      (
        await db.select().from(updates).where(eq(updates.ticketId, ticketId))
      ).filter((u) => u.kind === 'system' && /pre-close warning/.test(u.body))
    expect((await warnings()).length).toBe(1)
    const auditRows = await db.select().from(audit).where(eq(audit.action, 'ticket.hold_warning'))
    expect(auditRows.length).toBe(1)
    expect(auditRows[0].entityId).toBe(ticketId)
    const notices = await db.select().from(notifications).where(eq(notifications.ticketId, ticketId))
    expect(notices.some((n) => n.userId === agentUserId && n.event === 'ticket.hold_warning')).toBe(true)
    const runs = await db.select().from(ruleRuns).where(eq(ruleRuns.ruleId, ruleId))
    expect(runs.length).toBe(1)
    expect(runs[0].event).toBe('ticket.hold_warning')
    expect(runs[0].result).toBe('ok')
    // second tick: the warning must not fire again
    const warnedAt = row.holdWarnedAt
    const again = await tickHolds()
    expect(again.warned).toBe(0)
    expect((await warnings()).length).toBe(1)
    const [row2] = await db.select().from(tickets).where(eq(tickets.id, ticketId))
    expect(row2.holdWarnedAt?.toISOString()).toBe(warnedAt?.toISOString())
    await db.delete(rules).where(eq(rules.id, ruleId))
  })

  it('staff detail carries holdAutoCloseAt; contacts see the reason but not the time', async () => {
    const list = await db
      .select({ id: tickets.id, status: tickets.status })
      .from(tickets)
      .orderBy(tickets.number)
    const held = list.find((t) => t.status === 'hold')
    expect(held).toBeTruthy()
    const staffRes = await app.inject({
      method: 'GET',
      url: `/api/tickets/${held!.id}`,
      headers: { cookie: superCookie },
    })
    expect(staffRes.statusCode).toBe(200)
    const staffBody = staffRes.json()
    expect(staffBody.holdOn).toBe('client')
    expect(typeof staffBody.holdSince).toBe('string')
    expect(typeof staffBody.holdAutoCloseAt).toBe('string')
    // 24 days on hold of a 30-day policy → auto-close ≈ 6 days out
    const closeIn = new Date(staffBody.holdAutoCloseAt).getTime() - Date.now()
    expect(closeIn).toBeGreaterThan(4 * DAY_MS)
    expect(closeIn).toBeLessThan(8 * DAY_MS)
    const contactRes = await app.inject({
      method: 'GET',
      url: `/api/tickets/${held!.id}`,
      headers: { cookie: contactCookie },
    })
    expect(contactRes.statusCode).toBe(200)
    const contactBody = contactRes.json()
    expect(contactBody.holdOn).toBe('client')
    expect(typeof contactBody.holdSince).toBe('string')
    expect(contactBody.holdAutoCloseAt).toBeUndefined()
  })
})
