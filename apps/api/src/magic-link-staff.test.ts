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
  emailOutbox,
  settings,
  tickets,
  updates,
  users,
  verifications,
} from './db/schema'
import { closeMail } from './mail'

type App = Awaited<ReturnType<typeof buildApp>>

const owner = {
  instanceName: 'Kulik Labs IT',
  ownerName: 'Max Kulik',
  ownerEmail: 'max@kuliklabs.dev',
  password: 'correct-horse-battery',
}

const agent = {
  name: 'Sam Staff',
  email: 'sam@kuliklabs.dev',
  password: 'agent-magic-link-pass-1',
  role: 'agent',
}

const contactEmail = 'ada@acme.test'

function cookiesFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie']
  const list = Array.isArray(raw) ? raw : [raw]
  return list
    .filter(Boolean)
    .map((cookie) => String(cookie).split(';')[0])
    .join('; ')
}

function firstSetCookie(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie']
  const list = Array.isArray(raw) ? raw : [raw]
  return String(list.find(Boolean) ?? '').split(';')[0]
}

async function outboxCount(): Promise<number> {
  return (await db.select({ id: emailOutbox.id }).from(emailOutbox)).length
}

async function latestOutboxRow(to: string): Promise<{ subject: string; body: string } | null> {
  const rows = await db
    .select({ subject: emailOutbox.subject, body: emailOutbox.body })
    .from(emailOutbox)
    .where(eq(emailOutbox.to, to))
    .orderBy(emailOutbox.createdAt)
  return rows.length > 0 ? rows[rows.length - 1] : null
}

// Request a magic link, follow the verify link in the latest outbox row, and
// return the session cookie (null when no email was sent).
async function signUserViaMagicLink(
  app: App,
  email: string,
  callbackURL: string,
): Promise<string | null> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/magic-link',
    payload: { email, callbackURL },
  })
  expect(res.statusCode).toBe(200)
  expect(res.json()).toEqual({ status: true })
  const row = await latestOutboxRow(email)
  if (!row) return null
  const linkLine = row.body.split('\n').find((line) => line.startsWith('http'))
  expect(linkLine).toBeTruthy()
  const target = new URL(linkLine as string)
  const verifyRes = await app.inject({
    method: 'GET',
    url: `${target.pathname}${target.search}`,
  })
  expect(verifyRes.statusCode).toBe(302)
  return firstSetCookie(verifyRes) || null
}

async function wipe() {
  await db.delete(verifications)
  await db.delete(emailOutbox)
  await db.delete(updates)
  await db.delete(tickets)
  await db.delete(contactClients)
  await db.delete(contacts)
  await db.delete(clients)
  await db.delete(users)
  await db.delete(settings)
}

describe('self-service magic-link login for staff (issue #98)', () => {
  let app: App
  let staffCookie: string
  let agentCookie: string
  let contactCookie: string

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

    // Email settings: the outbox row is the assertion surface; nothing
    // actually delivers in tests.
    const saveRes = await app.inject({
      method: 'POST',
      url: '/api/email',
      headers: { cookie: staffCookie },
      payload: {
        domain: 'kuliklabs.dev',
        provider: 'smtp',
        smtp: {
          host: '127.0.0.1',
          port: 2525,
          secure: false,
          startTls: false,
          from: 'support@kuliklabs.dev',
        },
      },
    })
    expect(saveRes.statusCode).toBe(200)

    // A fresh agent account — created through the company-settings endpoint,
    // the real staff-creation path.
    const agentRes = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: staffCookie },
      payload: agent,
    })
    expect(agentRes.statusCode).toBe(200)
    const agentLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: agent.email, password: agent.password },
    })
    expect(agentLogin.statusCode).toBe(200)
    agentCookie = cookiesFrom(agentLogin)

    // A portal contact: the pre-existing magic-link flow stays live, and its
    // session cookie doubles as the contact fixture below.
    const client = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie: staffCookie },
      payload: { name: 'Acme Corp', domain: 'acme.test' },
    })
    expect(client.statusCode).toBe(201)
    const contact = await app.inject({
      method: 'POST',
      url: `/api/clients/${client.json().id}/contacts`,
      headers: { cookie: staffCookie },
      payload: { name: 'Ada Client', email: contactEmail },
    })
    expect(contact.statusCode).toBe(201)
    const portal = await app.inject({
      method: 'POST',
      url: `/api/contacts/${contact.json().id}/portal`,
      headers: { cookie: staffCookie },
    })
    expect(portal.statusCode).toBe(201)
    contactCookie = (await signUserViaMagicLink(app, contactEmail, '/portal')) as string
    expect(contactCookie).toBeTruthy()
  })

  afterAll(async () => {
    await app.close()
    await closeMail()
    await wipe()
  })

  it('a fresh staff account has magic-link off and SSO off', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: agentCookie } })
    expect(me.statusCode).toBe(200)
    const body = me.json()
    expect(body.user.magicLinkEnabled).toBe(false)
    expect(body.ssoEnabled).toBe(false)
  })

  it('staff can opt in: the flag, the audit row, and /api/me all reflect it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/me/magic-link',
      headers: { cookie: agentCookie },
      payload: { enabled: true },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ enabled: true })

    const [user] = await db.select().from(users).where(eq(users.email, agent.email))
    expect(user.magicLinkEnabled).toBe(true)

    const rows = await db
      .select()
      .from(audit)
      .where(eq(audit.action, 'auth.magic_link'))
      .orderBy(audit.createdAt)
    const last = rows[rows.length - 1]
    expect(last.entityType).toBe('user')
    expect(last.meta).toEqual({ enabled: true })

    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: agentCookie } })
    expect(me.json().user.magicLinkEnabled).toBe(true)
  })

  it('contacts cannot use the self-service toggle', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/me/magic-link',
      headers: { cookie: contactCookie },
      payload: { enabled: true },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json().message).toBe('magic-link self-service is for staff accounts')
  })

  it('an opted-in agent receives a magic link and the link signs them in', async () => {
    const before = await outboxCount()
    const cookie = await signUserViaMagicLink(app, agent.email, '/')
    expect(cookie).toBeTruthy()
    expect(await outboxCount()).toBe(before + 1)

    const row = await latestOutboxRow(agent.email)
    expect(row).not.toBeNull()
    expect(row?.subject).toContain('Sign in to Kulik Labs IT')
    expect(row?.body).toContain('/api/auth/magic-link/verify')

    const me = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: cookie as string },
    })
    expect(me.statusCode).toBe(200)
    expect(me.json().user.email).toBe(agent.email)
    expect(me.json().user.role).toBe('agent')

    // Regression guard (issue #98 follow-up): verifying a link must not
    // trigger better-auth's unproven-account path, which would delete the
    // account's sessions AND credential account. App-created staff accounts
    // are marked email-verified, so the password session and the credential
    // row both survive the magic-link sign-in.
    const [agentUser] = await db.select().from(users).where(eq(users.email, agent.email))
    expect(agentUser.emailVerified).toBe(true)
    const credentialRows = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.userId, agentUser.id))
    expect(credentialRows).toHaveLength(1)
    const stillIn = await app.inject({
      method: 'GET',
      url: '/api/me',
      headers: { cookie: agentCookie },
    })
    expect(stillIn.statusCode).toBe(200)
  })

  it('a staff account that never opted in gets no email', async () => {
    const before = await outboxCount()
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/magic-link',
      payload: { email: owner.ownerEmail, callbackURL: '/' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: true })
    expect(await outboxCount()).toBe(before)
  })

  it('org-wide SSO 400s the toggle and suppresses every magic link', async () => {
    await db.insert(settings).values({ key: 'sso', value: { enabled: true } })

    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: agentCookie } })
    expect(me.json().ssoEnabled).toBe(true)

    const toggle = await app.inject({
      method: 'POST',
      url: '/api/me/magic-link',
      headers: { cookie: agentCookie },
      payload: { enabled: true },
    })
    expect(toggle.statusCode).toBe(400)
    expect(toggle.json().message).toContain('SSO is enabled')

    const before = await outboxCount()
    // The agent is opted in and the contact always sends — SSO beats both.
    await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/magic-link',
      payload: { email: agent.email, callbackURL: '/' },
    })
    await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/magic-link',
      payload: { email: contactEmail, callbackURL: '/portal' },
    })
    expect(await outboxCount()).toBe(before)
  })

  it('the toggle can be turned off again (and no email follows)', async () => {
    await db.delete(settings).where(eq(settings.key, 'sso'))
    const res = await app.inject({
      method: 'POST',
      url: '/api/me/magic-link',
      headers: { cookie: agentCookie },
      payload: { enabled: false },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ enabled: false })
    const [user] = await db.select().from(users).where(eq(users.email, agent.email))
    expect(user.magicLinkEnabled).toBe(false)

    const before = await outboxCount()
    await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/magic-link',
      payload: { email: agent.email, callbackURL: '/' },
    })
    expect(await outboxCount()).toBe(before)
  })
})
