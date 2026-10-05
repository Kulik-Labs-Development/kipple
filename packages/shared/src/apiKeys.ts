import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'

// --- API keys (Phase 2, row 1) --------------------------------------------
//
// A small fixed scope enum over the staff route groups: read/write pairs per
// core resource. A key may hold any non-empty subset. Every /api route maps
// to exactly one scope (apps/api/src/api-keys.ts); a route with no mapping
// (users, email, SLA, rules, instance settings, key management, ...) is
// unreachable by any key and answers 403. Keys never elevate: a request with
// a key proceeds AS the creating user, so all existing RBAC and client
// scoping apply unchanged.

export const API_KEY_SCOPES = [
  'tickets:read',
  'tickets:write',
  'clients:read',
  'clients:write',
  'contacts:read',
  'contacts:write',
  'time:read',
  'time:write',
] as const
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number]

export const ApiKeyScope = z.enum(API_KEY_SCOPES)

// Key management request (superuser panel). expiresAt: absent/null = never
// expires; present = must be in the future (checked in the route).
export const ApiKeyCreate = z.object({
  name: z.string().trim().min(1).max(100),
  scopes: z.array(ApiKeyScope).min(1).max(API_KEY_SCOPES.length),
  expiresAt: z.coerce.date().nullable().optional(),
})
export type ApiKeyCreate = z.infer<typeof ApiKeyCreate>

// A key as returned by the list endpoint. Never carries the hash or the
// full key — the full key exists only in the 201 create response, once.
export const ApiKeyView = z.object({
  id: z.string(),
  name: z.string(),
  prefix: z.string(),
  scopes: z.array(z.string()),
  createdAt: z.coerce.date(),
  lastUsedAt: z.coerce.date().nullable(),
  expiresAt: z.coerce.date().nullable(),
  revokedAt: z.coerce.date().nullable(),
})
export type ApiKeyView = z.infer<typeof ApiKeyView>

export const API_KEY_PREFIX = 'kip_'

// sha256 hex digest — the only form of the key the database ever sees.
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

// Key format: `kip_` + 32 random bytes as base64url (node:crypto).
// The stored prefix is the first 12 characters of the secret (after the
// `kip_`), for human identification in lists.
export function generateApiKey(): { key: string; keyHash: string; keyPrefix: string } {
  const secret = randomBytes(32).toString('base64url')
  const key = `${API_KEY_PREFIX}${secret}`
  return { key, keyHash: sha256Hex(key), keyPrefix: secret.slice(0, 12) }
}

// Extract the raw key from an Authorization header. Strict: the header must
// be exactly `Bearer kip_...`; anything else (including a bare `kip_...`
// value, which is a malformed Authorization header) returns null so the
// request falls through to the cookie session path exactly as before.
export function apiKeyFromHeader(header: string | string[] | null | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header
  if (!value || !value.startsWith('Bearer ')) return null
  const token = value.slice('Bearer '.length)
  if (!token.startsWith(API_KEY_PREFIX)) return null
  return token
}
