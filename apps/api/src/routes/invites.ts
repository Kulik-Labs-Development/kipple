import { createHash, randomUUID } from 'node:crypto'
import { and, eq, gt, isNull } from 'drizzle-orm'
import { InviteAccept, InviteCreate, InstanceInvites } from '@kipple/shared'
import type { FastifyInstance } from 'fastify'
import { hashPassword } from 'better-auth/crypto'
import { badRequest, notFound, requireRole } from '../access'
import { logAudit } from '../audit'
import { db } from '../db'
import { accounts, settings, staffInvites, users } from '../db/schema'
import { sendInviteEmail } from '../mail'

// Admin invites (issue #32 / PLAN §3): staff are admin-invited via an email
// token link and must enroll MFA on first login. The token is a UUID and
// only its sha256 is stored, so a leaked DB does not leak live links; the
// accept endpoints are public because the token IS the credential (brute
// force is infeasible on 122 bits of UUID).

const INVITE_TTL_MS = 72 * 60 * 60 * 1000
const INVITES_KEY = 'invites'

function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

// PLAN: "admin can disable signups entirely". Settings row 'invites'
// {enabled: false} = off; absent row = on (same absent-means-default pattern
// as the theme rows).
async function invitesDisabled(): Promise<boolean> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, INVITES_KEY))
  return (row?.value as { enabled?: boolean } | null)?.enabled === false
}

async function loadValidInvite(token: string) {
  const now = new Date()
  const [invite] = await db
    .select()
    .from(staffInvites)
    .where(
      and(
        eq(staffInvites.tokenHash, tokenHash(token)),
        isNull(staffInvites.acceptedAt),
        isNull(staffInvites.revokedAt),
        gt(staffInvites.expiresAt, now),
      ),
    )
  if (!invite) return null
  // If the account already exists (concurrent accept), the link is spent.
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, invite.email))
  if (user) return null
  return invite
}

async function activeInviteForEmail(email: string) {
  const now = new Date()
  const rows = await db
    .select({ id: staffInvites.id })
    .from(staffInvites)
    .where(
      and(
        eq(staffInvites.email, email),
        isNull(staffInvites.acceptedAt),
        isNull(staffInvites.revokedAt),
        gt(staffInvites.expiresAt, now),
      ),
    )
  return rows.length > 0
}

export async function registerInviteRoutes(app: FastifyInstance): Promise<void> {
  // ---- management: company settings surface, superuser-only (same bar as
  // creating users directly) ----

  app.post('/api/invites', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    if (await invitesDisabled()) {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'invitations are disabled for this instance' })
    }
    const parsed = InviteCreate.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    const email = parsed.data.email.trim().toLowerCase()
    const role = parsed.data.role
    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email))
    if (existing) {
      return reply
        .code(409)
        .send({ error: 'conflict', message: 'that email already has an account' })
    }
    if (await activeInviteForEmail(email)) {
      return reply
        .code(409)
        .send({ error: 'conflict', message: 'an invitation is already pending for that email' })
    }
    const id = randomUUID()
    const token = randomUUID()
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS)
    await db.insert(staffInvites).values({
      id,
      email,
      role,
      tokenHash: tokenHash(token),
      invitedBy: session.user.id,
      expiresAt,
    })
    const base = process.env.PUBLIC_URL ?? 'http://localhost:3000'
    await sendInviteEmail(email, role, `${base}/invite/${token}`)
    await logAudit(session.user.id, 'invite.create', 'invite', id, { email, role })
    return reply.code(201).send({ id, email, role, createdAt: new Date().toISOString(), expiresAt })
  })

  app.get('/api/invites', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const now = new Date()
    const rows = await db
      .select({ id: staffInvites.id, email: staffInvites.email, role: staffInvites.role, createdAt: staffInvites.createdAt, expiresAt: staffInvites.expiresAt })
      .from(staffInvites)
      .where(
        and(isNull(staffInvites.acceptedAt), isNull(staffInvites.revokedAt), gt(staffInvites.expiresAt, now)),
      )
      .orderBy(staffInvites.createdAt)
    return rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
    }))
  })

  app.delete('/api/invites/:id', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const { id } = request.params as { id: string }
    const [row] = await db
      .update(staffInvites)
      .set({ revokedAt: new Date() })
      .where(and(eq(staffInvites.id, id), isNull(staffInvites.acceptedAt), isNull(staffInvites.revokedAt)))
      .returning()
    if (!row) return reply.code(404).send(notFound())
    await logAudit(session.user.id, 'invite.revoke', 'invite', id, { email: row.email })
    return reply.code(204).send()
  })

  // The kill switch (PLAN: "admin can disable signups entirely"). Absent row
  // = enabled; POST true deletes the row.
  app.get('/api/instance/invites', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    return { enabled: !(await invitesDisabled()) }
  })

  app.post('/api/instance/invites', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const parsed = InstanceInvites.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    if (parsed.data.enabled) {
      await db.delete(settings).where(eq(settings.key, INVITES_KEY))
    } else {
      await db
        .insert(settings)
        .values({ key: INVITES_KEY, value: { enabled: false } })
        .onConflictDoUpdate({ target: settings.key, set: { value: { enabled: false } } })
    }
    await logAudit(session.user.id, 'instance.invites', 'instance', undefined, parsed.data)
    return { enabled: parsed.data.enabled }
  })

  // ---- accept flow: public, token is the credential ----

  // Status for the /invite/<token> page: valid link shape + role, or a
  // uniform 404 (expired/revoked/used/unknown are indistinguishable on
  // purpose).
  app.get('/api/invites/accept', async (request, reply) => {
    const { token } = request.query as { token?: string }
    if (!token) {
      return reply.code(400).send({ error: 'bad_request', message: 'token required' })
    }
    const invite = await loadValidInvite(token)
    if (!invite) return reply.code(404).send(notFound())
    return { email: invite.email, role: invite.role, expiresAt: invite.expiresAt.toISOString() }
  })

  app.post('/api/invites/accept', async (request, reply) => {
    const parsed = InviteAccept.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    const invite = await loadValidInvite(parsed.data.token)
    if (!invite) return reply.code(404).send(notFound())
    const userId = randomUUID()
    try {
      await db
        .insert(users)
        .values({
          id: userId,
          name: parsed.data.name.trim(),
          email: invite.email,
          role: invite.role,
          // emailVerified mirrors the app-created staff accounts (the
          // magic-link selfserve landmine — an unverified account loses its
          // sessions on the first magic-link verify).
          emailVerified: true,
          // The MFA gate (app.ts) blocks this account until TOTP setup.
          mfaRequired: true,
        })
      await db.insert(accounts).values({
        id: randomUUID(),
        providerId: 'credential',
        issuer: 'local:credential',
        accountId: userId,
        userId,
        password: await hashPassword(parsed.data.password),
      })
    } catch {
      return reply
        .code(409)
        .send({ error: 'conflict', message: 'that email already has an account' })
    }
    await db
      .update(staffInvites)
      .set({ acceptedAt: new Date() })
      .where(eq(staffInvites.id, invite.id))
    await logAudit(null, 'invite.accepted', 'invite', invite.id, {
      email: invite.email,
      role: invite.role,
    })
    return reply
      .code(201)
      .send({ id: userId, email: invite.email, role: invite.role, mfaRequired: true })
  })
}
