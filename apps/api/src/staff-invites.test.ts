import { createHash, createHmac } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { db } from './db'
import { runMigrations } from './db/migrate'
import {
  emailOutbox,
  settings,
  staffInvites,
  twoFactor,
  users,
  verifications,
} from './db/schema'
import { eq } from 'drizzle-orm'

type App = Awaited<ReturnType<typeof buildApp>>

const owner = {
  instanceName: 'Kulik Labs IT',
  ownerName: 'Max Kulik',
  ownerEmail: 'max@kuliklabs.dev',
  password: 'correct-horse-battery',
}

const invited = {
  email: 'new.agent@kuliklabs.dev',
  password: 'new-agent-pass-0903',
  name: 'New Agent',
}

function cookiesFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie']
  const list = Array.isArray(raw) ? raw : [raw]
  return list
    .filter(Boolean)
    .map((cookie) => String(cookie).split(';')[0])
    .join('; ')
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

// --- inline TOTP (RFC 6238, SHA-1, 6 digits / 30s) — no new dependency ---

function base32Decode(input: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    value = (value << 5) | alphabet.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

function totp(secretBase32: string, atMs: number, period = 30, digits = 6): string {
  const counter = Math.floor(atMs / 1000 / period)
  const key = base32Decode(secretBase32)
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  const hash = createHmac('sha1', key).update(buf).digest()
  const offset = hash[hash.length - 1] & 0x0f
  const code =
    ((hash[offset] & 0x7f) << 24) |
    (hash[offset + 1] << 16) |
    (hash[offset + 2] << 8) |
    hash[offset + 3]
  return String(code % 10 ** digits).padStart(digits, '0')
}

async function wipe() {
  await db.delete(verifications)
  await db.delete(emailOutbox)
  await db.delete(twoFactor)
  await db.delete(staffInvites)
  await db.delete(users)
  await db.delete(settings)
}

describe('agent invites — email token link + MFA on first login (issue #32)', () => {
  let app: App
  let ownerCookie: string
  let adminCookie: string
  let inviteToken: string
  let inviteId: string

  async function signIn(email: string, password: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email, password },
    })
    expect(res.statusCode).toBe(200)
    return cookiesFrom(res)
  }

  beforeAll(async () => {
    await runMigrations()
    await wipe()
    app = await buildApp()

    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: owner })
    expect(setup.statusCode).toBe(200)
    ownerCookie = await signIn(owner.ownerEmail, owner.password)

    // A non-superuser staff account for the role-gate test.
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
    adminCookie = await signIn('dana@kuliklabs.dev', 'dana-pass-0903')
  })

  afterAll(async () => {
    await app.close()
    await wipe()
  })

  it('a superuser can send an invite: row, email, and hashed token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/invites',
      headers: { cookie: ownerCookie },
      payload: { email: invited.email },
    })
    expect(res.statusCode).toBe(201)
    expect(res.json()).toMatchObject({ email: invited.email, role: 'agent' })
    inviteId = res.json().id

    const [row] = await db.select().from(staffInvites).where(eq(staffInvites.id, inviteId))
    expect(row.email).toBe(invited.email)
    expect(row.role).toBe('agent')

    // The email carries the link; the DB stores only its sha256.
    const [outbox] = await db.select().from(emailOutbox).orderBy(emailOutbox.createdAt)
    expect(outbox.to).toBe(invited.email)
    const link = outbox.body
      .split('\n')
      .find((line) => line.includes('/invite/')) as string
    expect(link).toContain('http')
    inviteToken = link.split('/invite/')[1].trim()
    expect(row.tokenHash).toBe(sha256Hex(inviteToken))
    expect(row.tokenHash).not.toContain(inviteToken)
  })

  it('refuses to invite an existing account or duplicate a pending invite', async () => {
    const existing = await app.inject({
      method: 'POST',
      url: '/api/invites',
      headers: { cookie: ownerCookie },
      payload: { email: owner.ownerEmail },
    })
    expect(existing.statusCode).toBe(409)
    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/invites',
      headers: { cookie: ownerCookie },
      payload: { email: invited.email },
    })
    expect(duplicate.statusCode).toBe(409)
  })

  it('only superusers manage invites', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/invites',
      headers: { cookie: adminCookie },
      payload: { email: 'other@kuliklabs.dev' },
    })
    expect(res.statusCode).toBe(403)
  })

  it('the invited person creates the account through the public token link', async () => {
    const status = await app.inject({
      method: 'GET',
      url: `/api/invites/accept?token=${inviteToken}`,
    })
    expect(status.statusCode).toBe(200)
    expect(status.json()).toMatchObject({ email: invited.email, role: 'agent' })

    const accept = await app.inject({
      method: 'POST',
      url: '/api/invites/accept',
      payload: { token: inviteToken, name: invited.name, password: invited.password },
    })
    expect(accept.statusCode).toBe(201)
    expect(accept.json()).toMatchObject({ email: invited.email, role: 'agent', mfaRequired: true })

    const [user] = await db.select().from(users).where(eq(users.email, invited.email))
    expect(user).toBeDefined()
    expect(user.mfaRequired).toBe(true)
    expect(user.emailVerified).toBe(true)
    const [invite] = await db.select().from(staffInvites).where(eq(staffInvites.id, inviteId))
    expect(invite.acceptedAt).not.toBeNull()

    // The token is single-use.
    const again = await app.inject({
      method: 'POST',
      url: '/api/invites/accept',
      payload: { token: inviteToken, name: 'Impostor', password: 'wrong-wrong-wrong' },
    })
    expect(again.statusCode).toBe(404)
  })

  it('MFA on first login: gated until TOTP is enrolled, then the gate lifts', async () => {
    const cookie = await signIn(invited.email, invited.password)

    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })
    expect(me.statusCode).toBe(200)
    expect(me.json().user.mfaRequired).toBe(true)

    // Everything else is gated…
    const tickets = await app.inject({ method: 'GET', url: '/api/tickets', headers: { cookie } })
    expect(tickets.statusCode).toBe(403)
    expect(tickets.json().error).toBe('mfa_required')
    const clients = await app.inject({ method: 'GET', url: '/api/clients', headers: { cookie } })
    expect(clients.statusCode).toBe(403)

    // …except the two-factor setup endpoints.
    const enable = await app.inject({
      method: 'POST',
      url: '/api/auth/two-factor/enable',
      headers: { cookie },
      payload: { password: invited.password, method: 'totp' },
    })
    expect(enable.statusCode).toBe(200)
    expect(enable.json().method).toBe('totp')
    const totpURI = enable.json().totpURI as string
    expect(totpURI).toContain('otpauth://totp/')
    expect((enable.json().backupCodes as string[]).length).toBeGreaterThan(0)

    // Still gated before the device is confirmed.
    const stillGated = await app.inject({ method: 'GET', url: '/api/tickets', headers: { cookie } })
    expect(stillGated.statusCode).toBe(403)

    const secret = (totpURI.match(/[?&]secret=([A-Z2-7]+)/) ?? [])[1] as string
    expect(secret).toBeTruthy()
    const code = totp(secret, Date.now())
    const verify = await app.inject({
      method: 'POST',
      url: '/api/auth/two-factor/verify-totp',
      headers: { cookie },
      payload: { code },
    })
    expect(verify.statusCode).toBe(200)
    // The success body is the (rotated) session token, not a status flag.
    expect(verify.json().token).toBeTruthy()

    // The gate lifts (verify-totp rotated the session cookie — reuse it).
    const freshCookie = cookiesFrom(verify) || cookie
    const open = await app.inject({ method: 'GET', url: '/api/tickets', headers: { cookie: freshCookie } })
    expect(open.statusCode).toBe(200)
    const after = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: freshCookie } })
    expect(after.statusCode).toBe(200)
    expect(after.json().user.mfaRequired).toBe(false)
    const [user] = await db.select().from(users).where(eq(users.email, invited.email))
    expect(user.mfaRequired).toBe(false)
    expect(user.twoFactorEnabled).toBe(true)
  })

  it('revoked and expired invites are dead', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/invites',
      headers: { cookie: ownerCookie },
      payload: { email: 'second@kuliklabs.dev', role: 'admin' },
    })
    expect(create.statusCode).toBe(201)
    const revoke = await app.inject({
      method: 'DELETE',
      url: `/api/invites/${create.json().id}`,
      headers: { cookie: ownerCookie },
    })
    expect(revoke.statusCode).toBe(204)
    // The revoked link is gone even with the right token (fetched from the
    // outbox row for that email).
    const [mail] = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.to, 'second@kuliklabs.dev'))
    const linkToken = mail.body
      .split('\n')
      .find((line) => line.includes('/invite/'))
      ?.split('/invite/')[1]
      .trim()
    expect(linkToken).toBeTruthy()
    const status = await app.inject({
      method: 'GET',
      url: `/api/invites/accept?token=${linkToken}`,
    })
    expect(status.statusCode).toBe(404)

    // Expired: insert directly with a past expiry (the API only mints fresh
    // rows, so the row is a fixture here).
    const expiredId = '00000000-0000-4000-8000-000000000099'
    await db.insert(staffInvites).values({
      id: expiredId,
      email: 'expired@kuliklabs.dev',
      role: 'agent',
      tokenHash: sha256Hex('expired-token-value'),
      createdAt: new Date(Date.now() - 80 * 60 * 60 * 1000),
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    })
    const expired = await app.inject({
      method: 'POST',
      url: '/api/invites/accept',
      payload: { token: 'expired-token-value', name: 'Too Late', password: 'late-late-late-1' },
    })
    expect(expired.statusCode).toBe(404)
    await db.delete(staffInvites).where(eq(staffInvites.id, expiredId))
  })

  it('the kill switch disables (and re-enables) invitations', async () => {
    const disable = await app.inject({
      method: 'POST',
      url: '/api/instance/invites',
      headers: { cookie: ownerCookie },
      payload: { enabled: false },
    })
    expect(disable.statusCode).toBe(200)
    const stateOff = await app.inject({
      method: 'GET',
      url: '/api/instance/invites',
      headers: { cookie: ownerCookie },
    })
    expect(stateOff.json()).toEqual({ enabled: false })
    const blocked = await app.inject({
      method: 'POST',
      url: '/api/invites',
      headers: { cookie: ownerCookie },
      payload: { email: 'blocked@kuliklabs.dev' },
    })
    expect(blocked.statusCode).toBe(400)

    const enable = await app.inject({
      method: 'POST',
      url: '/api/instance/invites',
      headers: { cookie: ownerCookie },
      payload: { enabled: true },
    })
    expect(enable.statusCode).toBe(200)
    const stateOn = await app.inject({
      method: 'GET',
      url: '/api/instance/invites',
      headers: { cookie: ownerCookie },
    })
    expect(stateOn.json()).toEqual({ enabled: true })
  })

  it('the pending list shows only live invites', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/invites',
      headers: { cookie: ownerCookie },
    })
    expect(res.statusCode).toBe(200)
    // The accepted and the revoked invite are both gone; nothing else was
    // ever minted in this suite.
    expect(res.json()).toEqual([])
  })
})
