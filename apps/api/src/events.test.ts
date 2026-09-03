import { hashPassword } from 'better-auth/crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { db } from './db'
import { runMigrations } from './db/migrate'
import { registerClient } from './events'
import {
  accounts,
  audit,
  clients,
  contactClients,
  contacts,
  notifications,
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

async function createUserRow(name: string, email: string, role: string, password: string): Promise<string> {
  const id = crypto.randomUUID()
  await db.insert(users).values({ id, name, email, role })
  await db.insert(accounts).values({
    id: crypto.randomUUID(),
    providerId: 'credential',
    issuer: 'local:credential',
    accountId: id,
    userId: id,
    password: await hashPassword(password),
  })
  return id
}

async function wipe() {
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

describe('real-time presence — SSE channel + fan-out (issue #96)', () => {
  let app: App
  let agentCookie: string
  let agentUserId: string

  beforeAll(async () => {
    await runMigrations()
    await wipe()
    app = await buildApp()
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: owner })
    expect(setup.statusCode).toBe(200)
    // the owner session exists so the instance is set up + a signed-in user
    // is available; the tests drive fan-out through the agent + a fresh sign-in
    await signIn(app, owner.ownerEmail, owner.password)
    agentUserId = await createUserRow('Riley Agent', 'riley@kuliklabs.dev', 'agent', 'riley-pass-123')
    agentCookie = await signIn(app, 'riley@kuliklabs.dev', 'riley-pass-123')
  })

  afterAll(async () => {
    await app.close()
    await wipe()
  })

  it('GET /api/events requires a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/events' })
    expect(res.statusCode).toBe(401)
  })

  it('sign-in fans out the online presence to registered clients', async () => {
    const frames: string[] = []
    const unregister = registerClient((frame) => frames.push(frame))
    // the sign-in itself is the trigger (session-create hook)
    const userId = await createUserRow('Sofia Agent', 'sofia@kuliklabs.dev', 'agent', 'sofia-pass-123')
    const cookie = await signIn(app, 'sofia@kuliklabs.dev', 'sofia-pass-123')
    expect(cookie).toBeTruthy()
    const presenceFrames = frames.filter((frame) => frame.startsWith('event: presence'))
    expect(presenceFrames.length).toBe(1)
    const data = JSON.parse(presenceFrames[0].split('\n')[1].slice('data: '.length))
    expect(data).toEqual({ userId, presence: 'online' })
    const [row] = await db.select({ presence: users.presence }).from(users).where(eq(users.id, userId))
    expect(row.presence).toBe('online')
    unregister()
  })

  it('PATCH /api/me/presence fans out the change to registered clients', async () => {
    const frames: string[] = []
    const unregister = registerClient((frame) => frames.push(frame))
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/me/presence',
      headers: { cookie: agentCookie },
      payload: { presence: 'busy' },
    })
    expect(res.statusCode).toBe(200)
    const presenceFrames = frames.filter((frame) => frame.startsWith('event: presence'))
    expect(presenceFrames.length).toBe(1)
    const data = JSON.parse(presenceFrames[0].split('\n')[1].slice('data: '.length))
    expect(data).toEqual({ userId: agentUserId, presence: 'busy' })
    const [row] = await db.select({ presence: users.presence }).from(users).where(eq(users.id, agentUserId))
    expect(row.presence).toBe('busy')
    unregister()
  })

  it('unsubscribed clients stop receiving frames', async () => {
    const a: string[] = []
    const b: string[] = []
    const unregisterA = registerClient((frame) => a.push(frame))
    const unregisterB = registerClient((frame) => b.push(frame))
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/me/presence',
      headers: { cookie: agentCookie },
      payload: { presence: 'away' },
    })
    expect(res.statusCode).toBe(200)
    unregisterA()
    const again = await app.inject({
      method: 'PATCH',
      url: '/api/me/presence',
      headers: { cookie: agentCookie },
      payload: { presence: 'online' },
    })
    expect(again.statusCode).toBe(200)
    expect(a.filter((f) => f.startsWith('event: presence')).length).toBe(1)
    expect(b.filter((f) => f.startsWith('event: presence')).length).toBe(2)
    unregisterB()
  })
})
