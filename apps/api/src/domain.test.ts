import { randomUUID } from 'node:crypto'
import { hashPassword } from 'better-auth/crypto'
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
  tickets,
  updates,
  users,
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
  await db.delete(updates)
  await db.delete(tickets)
  await db.delete(contactClients)
  await db.delete(contacts)
  await db.delete(clients)
  await db.delete(audit)
  await db.delete(users)
  await db.delete(settings)
}

describe('ticket domain', () => {
  let app: App
  let staffCookie: string
  let contactCookie: string
  let clientA: string
  let clientB: string
  let contactRecordId: string
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
    staffCookie = cookiesFrom(login)

    const resA = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie: staffCookie },
      payload: { name: 'Acme Corp', domain: 'acme.test' },
    })
    expect(resA.statusCode).toBe(201)
    clientA = resA.json().id
    const resB = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie: staffCookie },
      payload: { name: 'Globex' },
    })
    clientB = resB.json().id

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
    // better-auth signs session tokens, so a hand-inserted session row is
    // rejected; give the contact a credential account and sign in for real.
    // issuer/accountId must match better-auth's credential account shape
    // (see createLocalAccountIssuer in @better-auth/core).
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

    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: contactCookie },
    })
    expect(me.statusCode).toBe(200)
    expect(me.json().contactId).toBe(contactRecordId)

    const ticketARes = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: contactCookie },
      payload: { clientId: clientA, subject: 'Printer is on fire', body: 'Please help' },
    })
    expect(ticketARes.statusCode).toBe(201)
    ticketA = ticketARes.json().id
    const ticketBRes = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: staffCookie },
      payload: { clientId: clientB, subject: 'Server needs patching' },
    })
    expect(ticketBRes.statusCode).toBe(201)
    ticketB = ticketBRes.json().id
  })

  afterAll(async () => {
    await app.close()
    await wipe()
  })

  it('requires authentication', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/clients' })
    expect(res.statusCode).toBe(401)
    const tickets = await app.inject({ method: 'GET', url: '/api/tickets' })
    expect(tickets.statusCode).toBe(401)
  })

  it('staff see all clients, contacts only their own', async () => {
    const staff = await app.inject({
      method: 'GET',
      url: '/api/clients',
      headers: { cookie: staffCookie },
    })
    expect(staff.json().map((c: { name: string }) => c.name).sort()).toEqual([
      'Acme Corp',
      'Globex',
    ])

    const contact = await app.inject({
      method: 'GET',
      url: '/api/clients',
      headers: { cookie: contactCookie },
    })
    expect(contact.json().map((c: { id: string }) => c.id)).toEqual([clientA])

    const foreign = await app.inject({
      method: 'GET',
      url: `/api/clients/${clientB}`,
      headers: { cookie: contactCookie },
    })
    expect(foreign.statusCode).toBe(404)
  })

  it('blocks contacts from staff-only actions', async () => {
    const createClient = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie: contactCookie },
      payload: { name: 'Evil Corp' },
    })
    expect(createClient.statusCode).toBe(403)

    const createTicketB = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: contactCookie },
      payload: { clientId: clientB, subject: 'Sneaky ticket' },
    })
    expect(createTicketB.statusCode).toBe(404)
  })

  it('assigns sequential ticket numbers and plus-addressed aliases', async () => {
    const a = await app.inject({
      method: 'GET',
      url: `/api/tickets/${ticketA}`,
      headers: { cookie: staffCookie },
    })
    const b = await app.inject({
      method: 'GET',
      url: `/api/tickets/${ticketB}`,
      headers: { cookie: staffCookie },
    })
    const aliasA = a.json().alias
    const aliasB = b.json().alias
    expect(aliasA).toMatch(/^support\+\d+@kipple\.local$/)
    expect(aliasB).toMatch(/^support\+\d+@kipple\.local$/)
    expect(Number(aliasB.split('+')[1].split('@')[0])).toBe(
      Number(aliasA.split('+')[1].split('@')[0]) + 1,
    )
    expect(a.json().clientName).toBe('Acme Corp')
    expect(a.json().updates[0]).toMatchObject({ kind: 'public', body: 'Please help', authorImage: null })
  })

  it('scopes ticket lists and detail to the contact client', async () => {
    const list = await app.inject({
      method: 'GET',
      url: '/api/tickets',
      headers: { cookie: contactCookie },
    })
    expect(list.json().map((t: { id: string }) => t.id)).toEqual([ticketA])

    const foreign = await app.inject({
      method: 'GET',
      url: `/api/tickets/${ticketB}`,
      headers: { cookie: contactCookie },
    })
    expect(foreign.statusCode).toBe(404)
  })

  it('supports public and internal updates; contacts are forced public and never see internal', async () => {
    const internal = await app.inject({
      method: 'POST',
      url: `/api/tickets/${ticketA}/updates`,
      headers: { cookie: staffCookie },
      payload: { kind: 'internal', body: 'Checking with vendor' },
    })
    expect(internal.statusCode).toBe(201)
    expect(internal.json().kind).toBe('internal')

    const contactUpdate = await app.inject({
      method: 'POST',
      url: `/api/tickets/${ticketA}/updates`,
      headers: { cookie: contactCookie },
      payload: { kind: 'internal', body: 'Any news?' },
    })
    expect(contactUpdate.statusCode).toBe(201)
    expect(contactUpdate.json().kind).toBe('public')

    const detail = await app.inject({
      method: 'GET',
      url: `/api/tickets/${ticketA}`,
      headers: { cookie: contactCookie },
    })
    const kinds = detail.json().updates.map((u: { kind: string }) => u.kind)
    expect(kinds).toEqual(['public', 'public'])

    const staffDetail = await app.inject({
      method: 'GET',
      url: `/api/tickets/${ticketA}`,
      headers: { cookie: staffCookie },
    })
    const staffKinds = staffDetail.json().updates.map((u: { kind: string }) => u.kind)
    expect(staffKinds).toEqual(['public', 'internal', 'public'])
  })

  it('supports contact-client linking with a single primary', async () => {
    const link = await app.inject({
      method: 'POST',
      url: `/api/contacts/${contactRecordId}/clients`,
      headers: { cookie: staffCookie },
      payload: { clientId: clientB, isPrimary: true },
    })
    expect(link.statusCode).toBe(200)

    const detail = await app.inject({
      method: 'GET',
      url: `/api/contacts/${contactRecordId}`,
      headers: { cookie: staffCookie },
    })
    const links = detail.json().clientLinks
    expect(links).toHaveLength(2)
    const primaries = links.filter((l: { isPrimary: boolean }) => l.isPrimary)
    expect(primaries.map((l: { clientId: string }) => l.clientId)).toEqual([clientB])

    const nowScopesB = await app.inject({
      method: 'GET',
      url: '/api/tickets',
      headers: { cookie: contactCookie },
    })
    expect(nowScopesB.json().map((t: { id: string }) => t.id).sort()).toEqual(
      [ticketA, ticketB].sort(),
    )

    const unlink = await app.inject({
      method: 'DELETE',
      url: `/api/contacts/${contactRecordId}/clients/${clientB}`,
      headers: { cookie: staffCookie },
    })
    expect(unlink.statusCode).toBe(204)
  })

  it('patches ticket status, priority, and assignment', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/tickets/${ticketB}`,
      headers: { cookie: staffCookie },
      payload: { status: 'pending', priority: 'urgent', assignedTo: null },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'pending', priority: 'urgent' })

    const filtered = await app.inject({
      method: 'GET',
      url: '/api/tickets?priority=urgent',
      headers: { cookie: staffCookie },
    })
    expect(filtered.json().map((t: { id: string }) => t.id)).toEqual([ticketB])
  })

  it('records audit entries for domain mutations', async () => {
    const rows = await db.select().from(audit)
    const actions = rows.map((row) => row.action)
    expect(actions).toEqual(
      expect.arrayContaining(['client.create', 'contact.create', 'ticket.create', 'update.create', 'ticket.update']),
    )
    expect(rows.every((row) => row.actorId)).toBe(true)
  })

  it('soft-deletes tickets and blocks deleting clients with tickets', async () => {
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/tickets/${ticketB}`,
      headers: { cookie: staffCookie },
    })
    expect(del.statusCode).toBe(204)
    const detail = await app.inject({
      method: 'GET',
      url: `/api/tickets/${ticketB}`,
      headers: { cookie: staffCookie },
    })
    expect(detail.json().status).toBe('deleted')

    const delClient = await app.inject({
      method: 'DELETE',
      url: `/api/clients/${clientB}`,
      headers: { cookie: staffCookie },
    })
    expect(delClient.statusCode).toBe(409)

    const extra = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: staffCookie },
      payload: { clientId: clientA, subject: 'Short-lived' },
    })
    expect(extra.statusCode).toBe(201)
    const extraId = extra.json().id
    const delExtra = await app.inject({
      method: 'DELETE',
      url: `/api/tickets/${extraId}`,
      headers: { cookie: staffCookie },
    })
    expect(delExtra.statusCode).toBe(204)
    const contactDetail = await app.inject({
      method: 'GET',
      url: `/api/tickets/${extraId}`,
      headers: { cookie: contactCookie },
    })
    expect(contactDetail.statusCode).toBe(404)
  })
})
