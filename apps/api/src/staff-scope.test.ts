import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { db } from './db'
import { runMigrations } from './db/migrate'
import {
  attachments,
  audit,
  clients,
  contactClients,
  contacts,
  settings,
  tickets,
  updates,
  users,
} from './db/schema'
import { eq } from 'drizzle-orm'

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
  await db.delete(attachments)
  await db.delete(updates)
  await db.delete(tickets)
  await db.delete(contactClients)
  await db.delete(contacts)
  await db.delete(clients)
  await db.delete(audit)
  await db.delete(users)
  await db.delete(settings)
}

type Part = { name: string; filename?: string; contentType?: string; content: string | Buffer }

function multipartBody(boundary: string, parts: Part[]): Buffer {
  const chunks: Buffer[] = []
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`))
    chunks.push(
      Buffer.from(
        part.filename
          ? `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`
          : `Content-Disposition: form-data; name="${part.name}"\r\n`,
      ),
    )
    chunks.push(Buffer.from(`Content-Type: ${part.contentType ?? 'text/plain'}\r\n\r\n`))
    chunks.push(Buffer.isBuffer(part.content) ? part.content : Buffer.from(part.content))
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return Buffer.concat(chunks)
}

describe('staff per-client access restriction (issue #31)', () => {
  let app: App
  let storageDir: string
  let ownerCookie: string
  let ownerId: string
  let clientA: string
  let clientB: string
  let ticketA: string
  let ticketB: string
  let attachmentB: string
  let adminId: string
  let adminCookie: string
  let agentCookie: string

  beforeAll(async () => {
    storageDir = mkdtempSync(path.join(tmpdir(), 'kipple-staff-scope-'))
    process.env.STORAGE_DIR = storageDir
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
    ownerCookie = cookiesFrom(login)
    const [ownerRow] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, owner.ownerEmail))
    ownerId = ownerRow.id

    const resA = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie: ownerCookie },
      payload: { name: 'Acme Corp', domain: 'acme.test' },
    })
    expect(resA.statusCode).toBe(201)
    clientA = resA.json().id
    const resB = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie: ownerCookie },
      payload: { name: 'Globex', domain: 'globex.test' },
    })
    expect(resB.statusCode).toBe(201)
    clientB = resB.json().id

    const ticketResA = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: ownerCookie },
      payload: { clientId: clientA, subject: 'Acme printer on fire', body: 'It is on fire.' },
    })
    expect(ticketResA.statusCode).toBe(201)
    ticketA = ticketResA.json().id
    const ticketResB = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: ownerCookie },
      payload: { clientId: clientB, subject: 'Globex VPN down', body: 'Cannot connect.' },
    })
    expect(ticketResB.statusCode).toBe(201)
    ticketB = ticketResB.json().id

    // One public attachment on the B ticket (house multipart pattern).
    const boundary = 'staff-scope-test-boundary'
    const upload = await app.inject({
      method: 'POST',
      url: `/api/tickets/${ticketB}/updates`,
      headers: {
        cookie: ownerCookie,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: multipartBody(boundary, [
        { name: 'kind', content: 'public' },
        { name: 'body', content: 'VPN log attached' },
        { name: 'file', filename: 'vpn.log', content: Buffer.from('log lines') },
      ]),
    })
    expect(upload.statusCode).toBe(201)
    const [att] = await db.select({ id: attachments.id }).from(attachments)
    attachmentB = att.id

    // Scoped admin: created by the superuser, then assigned to client A via
    // the superuser-only association route.
    const adminCreate = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: ownerCookie },
      payload: {
        name: 'Dana Admin',
        email: 'dana@kuliklabs.dev',
        password: 'dana-pass-0903',
        role: 'admin',
      },
    })
    expect(adminCreate.statusCode).toBe(200)
    adminId = adminCreate.json().id
    const adminScope = await app.inject({
      method: 'PATCH',
      url: `/api/users/${adminId}`,
      headers: { cookie: ownerCookie },
      payload: { clientId: clientA },
    })
    expect(adminScope.statusCode).toBe(200)
    const adminLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'dana@kuliklabs.dev', password: 'dana-pass-0903' },
    })
    expect(adminLogin.statusCode).toBe(200)
    adminCookie = cookiesFrom(adminLogin)

    // Unrestricted agent: created by the superuser, no client association.
    const agentCreate = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: ownerCookie },
      payload: {
        name: 'Evan Agent',
        email: 'evan@kuliklabs.dev',
        password: 'evan-pass-0903',
        role: 'agent',
      },
    })
    expect(agentCreate.statusCode).toBe(200)
    const agentLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'evan@kuliklabs.dev', password: 'evan-pass-0903' },
    })
    expect(agentLogin.statusCode).toBe(200)
    agentCookie = cookiesFrom(agentLogin)
  })

  afterAll(async () => {
    await app.close()
    await wipe()
    rmSync(storageDir, { recursive: true, force: true })
  })

  it('staff without a client association are unrestricted by default', async () => {
    const ticketsRes = await app.inject({
      method: 'GET',
      url: '/api/tickets',
      headers: { cookie: agentCookie },
    })
    expect(ticketsRes.statusCode).toBe(200)
    expect(ticketsRes.json().map((t: { id: string }) => t.id).sort()).toEqual(
      [ticketA, ticketB].sort(),
    )
    const clientsRes = await app.inject({
      method: 'GET',
      url: '/api/clients',
      headers: { cookie: agentCookie },
    })
    expect(clientsRes.statusCode).toBe(200)
    expect(clientsRes.json().map((c: { id: string }) => c.id).sort()).toEqual(
      [clientA, clientB].sort(),
    )
  })

  it('a staff member with a client association sees only that client', async () => {
    const ticketsRes = await app.inject({
      method: 'GET',
      url: '/api/tickets',
      headers: { cookie: adminCookie },
    })
    expect(ticketsRes.statusCode).toBe(200)
    expect(ticketsRes.json()).toHaveLength(1)
    expect(ticketsRes.json()[0].id).toBe(ticketA)
    const clientsRes = await app.inject({
      method: 'GET',
      url: '/api/clients',
      headers: { cookie: adminCookie },
    })
    expect(clientsRes.statusCode).toBe(200)
    expect(clientsRes.json()).toHaveLength(1)
    expect(clientsRes.json()[0].id).toBe(clientA)
    const otherClient = await app.inject({
      method: 'GET',
      url: `/api/clients/${clientB}`,
      headers: { cookie: adminCookie },
    })
    expect(otherClient.statusCode).toBe(404)
  })

  it('a scoped admin cannot read, patch, or create on the other client', async () => {
    const detail = await app.inject({
      method: 'GET',
      url: `/api/tickets/${ticketB}`,
      headers: { cookie: adminCookie },
    })
    expect(detail.statusCode).toBe(404)
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/tickets/${ticketB}`,
      headers: { cookie: adminCookie },
      payload: { priority: 'high' },
    })
    expect(patch.statusCode).toBe(404)
    const create = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: adminCookie },
      payload: { clientId: clientB, subject: 'Nope', body: 'Cannot create here.' },
    })
    expect(create.statusCode).toBe(404)
  })

  it('a scoped admin can read, patch, and delete their own client\'s ticket', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/tickets/${ticketA}`,
      headers: { cookie: adminCookie },
      payload: { priority: 'high' },
    })
    expect(patch.statusCode).toBe(200)
    expect(patch.json().priority).toBe('high')
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/tickets/${ticketA}`,
      headers: { cookie: adminCookie },
    })
    expect(del.statusCode).toBe(204)
  })

  it('a scoped admin cannot delete the other client\'s ticket', async () => {
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/tickets/${ticketB}`,
      headers: { cookie: adminCookie },
    })
    expect(del.statusCode).toBe(404)
    const [row] = await db
      .select({ id: tickets.id, status: tickets.status })
      .from(tickets)
      .where(eq(tickets.id, ticketB))
    expect(row.status).not.toBe('deleted')
  })

  it('a scoped admin cannot fetch or delete the other client\'s attachment', async () => {
    const get = await app.inject({
      method: 'GET',
      url: `/api/attachments/${attachmentB}`,
      headers: { cookie: adminCookie },
    })
    expect(get.statusCode).toBe(404)
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/attachments/${attachmentB}`,
      headers: { cookie: adminCookie },
    })
    expect(del.statusCode).toBe(404)
    const [row] = await db.select({ id: attachments.id }).from(attachments)
    expect(row.id).toBe(attachmentB)
    // Unrestricted staff can still fetch it.
    const open = await app.inject({
      method: 'GET',
      url: `/api/attachments/${attachmentB}`,
      headers: { cookie: agentCookie },
    })
    expect(open.statusCode).toBe(200)
    expect(open.headers['content-length']).toBe(String(Buffer.from('log lines').length))
  })

  it('superusers are exempt from scoping even with a client association', async () => {
    const selfScope = await app.inject({
      method: 'PATCH',
      url: `/api/users/${ownerId}`,
      headers: { cookie: ownerCookie },
      payload: { clientId: clientA },
    })
    expect(selfScope.statusCode).toBe(200)
    const ticketsRes = await app.inject({
      method: 'GET',
      url: '/api/tickets',
      headers: { cookie: ownerCookie },
    })
    expect(ticketsRes.statusCode).toBe(200)
    expect(ticketsRes.json().map((t: { id: string }) => t.id).sort()).toEqual(
      [ticketA, ticketB].sort(),
    )
    const clientsRes = await app.inject({
      method: 'GET',
      url: '/api/clients',
      headers: { cookie: ownerCookie },
    })
    expect(clientsRes.statusCode).toBe(200)
    expect(clientsRes.json().map((c: { id: string }) => c.id).sort()).toEqual(
      [clientA, clientB].sort(),
    )
  })

  it('deleting a client clears the staff association (FK ON DELETE SET NULL)', async () => {
    const clientC = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie: ownerCookie },
      payload: { name: 'Initech', domain: 'initech.test' },
    })
    expect(clientC.statusCode).toBe(201)
    const reScope = await app.inject({
      method: 'PATCH',
      url: `/api/users/${adminId}`,
      headers: { cookie: ownerCookie },
      payload: { clientId: clientC.json().id },
    })
    expect(reScope.statusCode).toBe(200)
    const scopedList = await app.inject({
      method: 'GET',
      url: '/api/tickets',
      headers: { cookie: adminCookie },
    })
    expect(scopedList.statusCode).toBe(200)
    expect(scopedList.json()).toHaveLength(0)
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/clients/${clientC.json().id}`,
      headers: { cookie: ownerCookie },
    })
    expect(del.statusCode).toBe(204)
    const [adminRow] = await db
      .select({ clientId: users.clientId })
      .from(users)
      .where(eq(users.id, adminId))
    expect(adminRow.clientId).toBeNull()
    const unscopedList = await app.inject({
      method: 'GET',
      url: '/api/tickets',
      headers: { cookie: adminCookie },
    })
    expect(unscopedList.statusCode).toBe(200)
    expect(unscopedList.json().map((t: { id: string }) => t.id).sort()).toEqual(
      [ticketA, ticketB].sort(),
    )
  })
})
