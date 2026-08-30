import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { buildApp } from './app'
import { db } from './db'
import { runMigrations } from './db/migrate'
import { settings, users } from './db/schema'

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

describe('first-run setup + auth', () => {
  let app: App

  beforeAll(async () => {
    await runMigrations()
    await db.delete(users)
    await db.delete(settings)
    app = await buildApp()
  })

  afterAll(async () => {
    await app.close()
    await db.delete(users)
    await db.delete(settings)
  })

  it('reports setup required on an empty instance', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/setup/status' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ setupRequired: true })
  })

  it('rejects setup payloads that fail validation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { ...owner, password: 'short' },
    })
    expect(res.statusCode).toBe(400)
  })

  it('completes setup, creates a superuser, and returns a session', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: owner })
    expect(res.statusCode).toBe(200)
    expect(cookiesFrom(res)).not.toBe('')

    const [user] = await db.select().from(users)
    expect(user.email).toBe(owner.ownerEmail)
    expect(user.role).toBe('superuser')

    const [row] = await db.select().from(settings).where(eq(settings.key, 'instance'))
    expect(row.value).toEqual({ name: owner.instanceName })
  })

  it('blocks a second setup attempt', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: owner })
    expect(res.statusCode).toBe(409)
  })

  it('reports setup complete after setup', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/setup/status' })
    expect(res.json()).toEqual({ setupRequired: false })
  })

  it('blocks public sign-up after setup', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-up/email',
      payload: {
        name: 'Intruder',
        email: 'intruder@kuliklabs.dev',
        password: 'correct-horse-battery',
      },
    })
    expect(res.statusCode).toBe(403)
  })

  it('signs the owner in with email + password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: owner.ownerEmail, password: owner.password },
    })
    expect(res.statusCode).toBe(200)
    expect(cookiesFrom(res)).not.toBe('')
  })

  it('resolves /api/me with the session cookie', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: owner.ownerEmail, password: owner.password },
    })
    const res = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: cookiesFrom(login) },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().user).toMatchObject({
      email: owner.ownerEmail,
      role: 'superuser',
    })
  })

  it('rejects /api/me without a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me' })
    expect(res.statusCode).toBe(401)
  })
})

describe('theme preferences', () => {
  let app: App
  let cookie: string

  beforeAll(async () => {
    await db.delete(users)
    await db.delete(settings)
    app = await buildApp()
    const setup = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: owner,
    })
    expect(setup.statusCode).toBe(200)
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: owner.ownerEmail, password: owner.password },
    })
    expect(login.statusCode).toBe(200)
    cookie = cookiesFrom(login)
  })

  afterAll(async () => {
    await app.close()
    await db.delete(users)
    await db.delete(settings)
  })

  it('exposes the default instance theme and empty preferences', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.instanceTheme).toBe('slate')
    expect(body.preferences).toEqual({ theme: null, colorMode: 'system' })
  })

  it('updates color mode and theme', async () => {
    let res = await app.inject({
      method: 'PATCH',
      url: '/api/preferences',
      headers: { cookie },
      payload: { colorMode: 'dark' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ theme: null, colorMode: 'dark' })

    res = await app.inject({
      method: 'PATCH',
      url: '/api/preferences',
      headers: { cookie },
      payload: { theme: 'graphite' },
    })
    expect(res.json()).toEqual({ theme: 'graphite', colorMode: 'dark' })

    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })
    expect(me.json().preferences).toEqual({ theme: 'graphite', colorMode: 'dark' })
  })

  it('rejects unknown theme ids and empty patches', async () => {
    const badTheme = await app.inject({
      method: 'PATCH',
      url: '/api/preferences',
      headers: { cookie },
      payload: { theme: 'plaid' },
    })
    expect(badTheme.statusCode).toBe(400)
    const empty = await app.inject({
      method: 'PATCH',
      url: '/api/preferences',
      headers: { cookie },
      payload: {},
    })
    expect(empty.statusCode).toBe(400)
  })

  it('clears a theme override back to null', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/preferences',
      headers: { cookie },
      payload: { theme: null },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ theme: null, colorMode: 'dark' })
  })

  it('reads the instance theme from settings', async () => {
    await db.insert(settings).values({ key: 'theme', value: { id: 'graphite' } })
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })
    expect(me.json().instanceTheme).toBe('graphite')
    await db.delete(settings).where(eq(settings.key, 'theme'))
  })
})
