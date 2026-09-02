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

async function signIn(app: App, email: string, password: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/email',
    payload: { email, password },
  })
  expect(res.statusCode).toBe(200)
  return cookiesFrom(res)
}

describe('instance defaults (superuser)', () => {
  let app: App
  let superuserCookie: string
  let agentCookie: string

  beforeAll(async () => {
    await runMigrations()
    await db.delete(updates)
    await db.delete(tickets)
    await db.delete(contactClients)
    await db.delete(contacts)
    await db.delete(clients)
    await db.delete(audit)
    await db.delete(users)
    await db.delete(settings)
    app = await buildApp()
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: owner })
    expect(setup.statusCode).toBe(200)
    superuserCookie = await signIn(app, owner.ownerEmail, owner.password)
    const agentId = randomUUID()
    await db.insert(users).values({
      id: agentId,
      name: 'Riley Agent',
      email: 'riley@kuliklabs.dev',
      role: 'agent',
    })
    await db.insert(accounts).values({
      id: randomUUID(),
      providerId: 'credential',
      issuer: 'local:credential',
      accountId: agentId,
      userId: agentId,
      password: await hashPassword('riley-pass-123'),
    })
    agentCookie = await signIn(app, 'riley@kuliklabs.dev', 'riley-pass-123')
  })

  afterAll(async () => {
    await app.close()
    await db.delete(updates)
    await db.delete(tickets)
    await db.delete(contactClients)
    await db.delete(contacts)
    await db.delete(clients)
    await db.delete(audit)
    await db.delete(users)
    await db.delete(settings)
  })

  it('reports the built-in defaults until the superuser sets them', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/instance/defaults',
      headers: { cookie: superuserCookie },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ agentTheme: null, portalTheme: null })
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: agentCookie } })
    expect(me.statusCode).toBe(200)
    expect(me.json().agentDefaultTheme).toBe('console')
    expect(me.json().instanceTheme).toBe('slate')
  })

  it('superuser can set both defaults and /api/me reflects them', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/instance/defaults',
      headers: { cookie: superuserCookie },
      payload: { agentTheme: 'graphite', portalTheme: 'slate' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ agentTheme: 'graphite', portalTheme: 'slate' })
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: agentCookie } })
    expect(me.json().agentDefaultTheme).toBe('graphite')
    expect(me.json().instanceTheme).toBe('slate')
  })

  it('clears a default back to the built-in with null', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/instance/defaults',
      headers: { cookie: superuserCookie },
      payload: { agentTheme: null },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ agentTheme: null, portalTheme: 'slate' })
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: agentCookie } })
    expect(me.json().agentDefaultTheme).toBe('console')
  })

  it('rejects unknown themes and empty patches', async () => {
    for (const payload of [{ agentTheme: 'plaid' }, {}]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/instance/defaults',
        headers: { cookie: superuserCookie },
        payload,
      })
      expect(res.statusCode).toBe(400)
    }
  })

  it('keeps the endpoints superuser-only', async () => {
    for (const method of ['GET', 'POST'] as const) {
      const res = await app.inject({
        method,
        url: '/api/instance/defaults',
        headers: { cookie: agentCookie },
      })
      expect(res.statusCode).toBe(403)
    }
  })
})
