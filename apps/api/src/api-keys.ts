import { eq } from 'drizzle-orm'
import type { FastifyRequest } from 'fastify'
import { apiKeyFromHeader, sha256Hex, type ApiKeyScope } from '@kipple/shared'
import { db } from './db'
import { apiKeys, users } from './db/schema'

// Bearer API key auth (Phase 2, row 1), parallel to the cookie session path
// which is left untouched.
//
// A request carrying `Authorization: Bearer kip_...` is resolved to the key's
// row by sha256 lookup and proceeds AS THE CREATING USER: every existing RBAC
// check (requireRole) and client-scope rule (clientScope) applies unchanged,
// and a key never elevates. A dead / unknown / expired key is a 401 in the
// house error shape. Scope model v1: a small fixed scope enum over the staff
// route groups (shared API_KEY_SCOPES); every /api route maps to exactly one
// scope below — a key hitting a route outside its scopes is a 403 (the
// out-of-scope=404 rule belongs to CONTACT users and does not apply here).
// Routes with no mapping (users, email, SLA, rules, instance settings, key
// management, portal, setup, /api/me, /api/auth/*, ...) are unreachable by
// any key.
//
// last_used_at is touched at most once per 60s per key (simple throttle —
// activity resolution, not telemetry).
//
// A valid key also bypasses the MFA-on-first-login session gate: that gate
// exists to force TOTP enrollment on an interactive login, and there is no
// interactive session here.

export interface ApiKeyUser {
  id: string
  name: string
  email: string
  emailVerified: boolean
  role: string
  presence: string
  authSource: string
  mfaRequired: boolean
}

export interface ApiKeyIdentity {
  user: ApiKeyUser
  keyId: string
  keyName: string
  scopes: string[]
}

export type ApiKeyAuth =
  | { status: 'none' }
  | { status: 'unauthorized'; reason: 'unknown' | 'revoked' | 'expired' }
  | ({ status: 'ok' } & ApiKeyIdentity)

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the preHandler hook in app.ts when the request authenticated
     * with a valid, in-scope API key. */
    apiKeyAuth?: ApiKeyIdentity | null
  }
}

const EXACT: Record<string, ApiKeyScope> = {
  'GET /api/tickets': 'tickets:read',
  'POST /api/tickets': 'tickets:write',
  'GET /api/clients': 'clients:read',
  'POST /api/clients': 'clients:write',
  'GET /api/time': 'time:read',
  'GET /api/time/active': 'time:read',
  'POST /api/time/start': 'time:write',
  'POST /api/time/stop': 'time:write',
  'POST /api/time/entries': 'time:write',
}

const PARAM: Array<{ pattern: RegExp; scopes: Partial<Record<string, ApiKeyScope>> }> = [
  {
    pattern: /^\/api\/tickets\/[^/]+$/,
    scopes: { GET: 'tickets:read', PATCH: 'tickets:write', DELETE: 'tickets:write' },
  },
  { pattern: /^\/api\/tickets\/[^/]+\/updates$/, scopes: { POST: 'tickets:write' } },
  {
    pattern: /^\/api\/clients\/[^/]+$/,
    scopes: { GET: 'clients:read', PATCH: 'clients:write', DELETE: 'clients:write' },
  },
  {
    pattern: /^\/api\/clients\/[^/]+\/logo$/,
    scopes: { GET: 'clients:read', POST: 'clients:write', DELETE: 'clients:write' },
  },
  {
    pattern: /^\/api\/clients\/[^/]+\/contacts$/,
    scopes: { GET: 'contacts:read', POST: 'contacts:write' },
  },
  {
    pattern: /^\/api\/contacts\/[^/]+$/,
    scopes: { GET: 'contacts:read', PATCH: 'contacts:write' },
  },
  { pattern: /^\/api\/contacts\/[^/]+\/clients$/, scopes: { POST: 'contacts:write' } },
  {
    pattern: /^\/api\/contacts\/[^/]+\/clients\/[^/]+$/,
    scopes: { DELETE: 'contacts:write' },
  },
  {
    pattern: /^\/api\/attachments\/[^/]+$/,
    scopes: { GET: 'tickets:read', DELETE: 'tickets:write' },
  },
  { pattern: /^\/api\/time\/[^/]+$/, scopes: { PATCH: 'time:write', DELETE: 'time:write' } },
]

/**
 * The scope a (method, path) requires, or null when the route is not
 * reachable by API keys at all (which means a keyed request 403s).
 */
export function scopeForRoute(method: string, url: string): ApiKeyScope | null {
  const path = url.split('?')[0]
  const exact = EXACT[`${method} ${path}`]
  if (exact) return exact
  for (const entry of PARAM) {
    if (entry.pattern.test(path)) return entry.scopes[method] ?? null
  }
  return null
}

const LAST_USED_THROTTLE_MS = 60_000

export async function authWithApiKey(request: FastifyRequest): Promise<ApiKeyAuth> {
  const raw = apiKeyFromHeader(request.headers.authorization)
  if (!raw) return { status: 'none' }
  const [row] = await db
    .select({ key: apiKeys, user: users })
    .from(apiKeys)
    .innerJoin(users, eq(apiKeys.userId, users.id))
    .where(eq(apiKeys.keyHash, sha256Hex(raw)))
  if (!row) return { status: 'unauthorized', reason: 'unknown' }
  if (row.key.revokedAt) return { status: 'unauthorized', reason: 'revoked' }
  const now = new Date()
  if (row.key.expiresAt && row.key.expiresAt.getTime() < now.getTime()) {
    return { status: 'unauthorized', reason: 'expired' }
  }
  if (
    !row.key.lastUsedAt ||
    now.getTime() - row.key.lastUsedAt.getTime() >= LAST_USED_THROTTLE_MS
  ) {
    await db.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.key.id))
  }
  return {
    status: 'ok',
    user: {
      id: row.user.id,
      name: row.user.name,
      email: row.user.email,
      emailVerified: row.user.emailVerified,
      role: row.user.role,
      presence: row.user.presence,
      authSource: row.user.authSource,
      mfaRequired: row.user.mfaRequired,
    },
    keyId: row.key.id,
    keyName: row.key.name,
    scopes: row.key.scopes,
  }
}
