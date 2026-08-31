import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { db } from './db'
import { runMigrations } from './db/migrate'
import {
  audit,
  clients,
  contactClients,
  contacts,
  tickets,
  timeEntries,
  updates,
  users,
  verifications,
} from './db/schema'
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
  await db.delete(verifications)
  await db.delete(audit)
  await db.delete(timeEntries)
  await db.delete(updates)
  await db.delete(tickets)
  await db.delete(contactClients)
  await db.delete(contacts)
  await db.delete(clients)
  await db.delete(users)
}

describe('time tracking', () => {
  let app: App
  let cookie: string
  let clientA: string
  let clientB: string
  let ticketA: string
  let ticketB: string

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

    for (const [name, key] of [
      ['Acme Corp', 'clientA'],
      ['Globex', 'clientB'],
    ] as const) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/clients',
        headers: { cookie },
        payload: { name },
      })
      expect(res.statusCode).toBe(201)
      const id = res.json().id
      if (key === 'clientA') clientA = id
      else clientB = id
    }
    const ticketResA = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie },
      payload: { clientId: clientA, subject: 'Printer is on fire' },
    })
    expect(ticketResA.statusCode).toBe(201)
    ticketA = ticketResA.json().id
    const ticketResB = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie },
      payload: { clientId: clientB, subject: 'VPN down' },
    })
    expect(ticketResB.statusCode).toBe(201)
    ticketB = ticketResB.json().id
  })

  afterAll(async () => {
    await app.close()
    await wipe()
  })

  it('starts a timer and refuses a second concurrent timer', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/time/start',
      headers: { cookie },
      payload: { ticketId: ticketA, note: 'diagnosing paper jam' },
    })
    expect(res.statusCode).toBe(201)
    const entry = res.json()
    expect(entry.agentId).toBeTruthy()
    expect(entry.clientId).toBe(clientA)
    expect(entry.durationS).toBeNull()
    expect(entry.billable).toBe(true)
    expect(entry.note).toBe('diagnosing paper jam')

    const again = await app.inject({
      method: 'POST',
      url: '/api/time/start',
      headers: { cookie },
      payload: { ticketId: ticketB },
    })
    expect(again.statusCode).toBe(409)
    expect(again.json().entry.id).toBe(entry.id)

    const active = await app.inject({
      method: 'GET',
      url: '/api/time/active',
      headers: { cookie },
    })
    expect(active.json().entry.id).toBe(entry.id)
  })

  it('stops the timer with a positive duration', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/time/stop',
      headers: { cookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().durationS).toBeGreaterThanOrEqual(1)

    const none = await app.inject({
      method: 'POST',
      url: '/api/time/stop',
      headers: { cookie },
    })
    expect(none.statusCode).toBe(409)
    expect((await app.inject({ method: 'GET', url: '/api/time/active', headers: { cookie } }))
      .json().entry).toBeNull()
  })

  it('creates manual entries with explicit duration and time', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/time/entries',
      headers: { cookie },
      payload: {
        ticketId: ticketA,
        startedAt: '2026-08-30T09:00:00Z',
        durationS: 1800,
        billable: false,
        note: 'travel time',
      },
    })
    expect(res.statusCode).toBe(201)
    const entry = res.json()
    expect(entry.durationS).toBe(1800)
    expect(entry.billable).toBe(false)
    expect(new Date(entry.startedAt).toISOString()).toBe('2026-08-30T09:00:00.000Z')

    const invalid = await app.inject({
      method: 'POST',
      url: '/api/time/entries',
      headers: { cookie },
      payload: { ticketId: ticketA, startedAt: '2026-08-30T09:00:00Z', durationS: 0 },
    })
    expect(invalid.statusCode).toBe(400)
  })

  it('rejects out-of-scope and bad bodies', async () => {
    const missing = await app.inject({
      method: 'POST',
      url: '/api/time/entries',
      headers: { cookie },
      payload: { ticketId: 'no-such-ticket', startedAt: '2026-08-30T09:00:00Z', durationS: 60 },
    })
    expect(missing.statusCode).toBe(404)

    const noDuration = await app.inject({
      method: 'POST',
      url: '/api/time/start',
      headers: { cookie },
      payload: { ticketId: ticketA },
    })
    expect(noDuration.statusCode).toBe(201)
    await app.inject({ method: 'POST', url: '/api/time/stop', headers: { cookie } })
    void noDuration
  })

  it('lists, filters, updates, and deletes entries; writes audit rows', async () => {
    const all = await app.inject({ method: 'GET', url: '/api/time', headers: { cookie } })
    expect(all.statusCode).toBe(200)
    expect(all.json().length).toBeGreaterThanOrEqual(2)

    const byTicket = await app.inject({
      method: 'GET',
      url: `/api/time?ticketId=${ticketA}`,
      headers: { cookie },
    })
    for (const row of byTicket.json()) expect(row.ticketId).toBe(ticketA)

    const nonBillable = await app.inject({
      method: 'GET',
      url: '/api/time?billable=false',
      headers: { cookie },
    })
    expect(nonBillable.json().length).toBe(1)
    expect(nonBillable.json()[0].note).toBe('travel time')
    const travelId = nonBillable.json()[0].id

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/time/${travelId}`,
      headers: { cookie },
      payload: { billable: true, note: 'travel time (approved)' },
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().billable).toBe(true)
    expect(patched.json().note).toBe('travel time (approved)')

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/time/${travelId}`,
      headers: { cookie },
    })
    expect(deleted.statusCode).toBe(204)
    const gone = await app.inject({
      method: 'DELETE',
      url: `/api/time/${travelId}`,
      headers: { cookie },
    })
    expect(gone.statusCode).toBe(404)

    const actions = new Set((await db.select({ action: audit.action }).from(audit)).map((row) => row.action))
    for (const action of ['time.start', 'time.stop', 'time.entry', 'time.update', 'time.delete']) {
      expect(actions.has(action)).toBe(true)
    }
  })

  it("scops the time list to the contact's clients and blocks mutations", async () => {
    const { hashPassword } = await import('better-auth/crypto')
    const { randomUUID } = await import('node:crypto')
    const { accounts } = await import('./db/schema')

    const contactRes = await app.inject({
      method: 'POST',
      url: `/api/clients/${clientA}/contacts`,
      headers: { cookie },
      payload: { name: 'Ada Client', email: 'ada@acme.test' },
    })
    expect(contactRes.statusCode).toBe(201)
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
    expect(login.statusCode).toBe(200)
    const adaCookie = cookiesFrom(login)

    // staff entries on client B must be invisible to the contact
    const staffStart = await app.inject({
      method: 'POST',
      url: '/api/time/start',
      headers: { cookie },
      payload: { ticketId: ticketB },
    })
    expect(staffStart.statusCode).toBe(201)
    await app.inject({ method: 'POST', url: '/api/time/stop', headers: { cookie } })

    const list = await app.inject({
      method: 'GET',
      url: '/api/time',
      headers: { cookie: adaCookie },
    })
    expect(list.statusCode).toBe(200)
    const rows = list.json()
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.clientId).toBe(clientA)

    const start = await app.inject({
      method: 'POST',
      url: '/api/time/start',
      headers: { cookie: adaCookie },
      payload: { ticketId: ticketA },
    })
    expect(start.statusCode).toBe(403)
  })
})
