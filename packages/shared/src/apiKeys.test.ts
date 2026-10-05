import { describe, expect, it } from 'vitest'
import {
  API_KEY_PREFIX,
  API_KEY_SCOPES,
  ApiKeyCreate,
  apiKeyFromHeader,
  generateApiKey,
  sha256Hex,
} from './apiKeys'

const BASE64URL = /^[A-Za-z0-9_-]+$/

describe('generateApiKey', () => {
  it('produces kip_ + 32 random bytes as base64url', () => {
    const { key } = generateApiKey()
    const secret = key.slice(API_KEY_PREFIX.length)
    expect(secret).toHaveLength(43) // 32 bytes -> 43 base64url chars
    expect(BASE64URL.test(secret)).toBe(true)
  })

  it('stores only the hash + a 12-char display prefix', () => {
    const { key, keyHash, keyPrefix } = generateApiKey()
    expect(keyHash).toMatch(/^[a-f0-9]{64}$/)
    expect(keyHash).toBe(sha256Hex(key))
    const secret = key.slice(API_KEY_PREFIX.length)
    expect(keyPrefix).toBe(secret.slice(0, 12))
  })

  it('never repeats a key', () => {
    const keys = new Set(Array.from({ length: 500 }, () => generateApiKey().key))
    expect(keys.size).toBe(500)
  })
})

describe('sha256Hex', () => {
  it('is deterministic and distinct per value', () => {
    expect(sha256Hex('kip_abc')).toBe(sha256Hex('kip_abc'))
    expect(sha256Hex('kip_abc')).not.toBe(sha256Hex('kip_abd'))
  })
})

describe('apiKeyFromHeader', () => {
  it('reads Bearer kip_... values', () => {
    expect(apiKeyFromHeader('Bearer kip_deadbeef')).toBe('kip_deadbeef')
  })

  it('returns null for missing / non-kip headers', () => {
    expect(apiKeyFromHeader(undefined)).toBeNull()
    expect(apiKeyFromHeader(null)).toBeNull()
    expect(apiKeyFromHeader('')).toBeNull()
    expect(apiKeyFromHeader('Bearer session-token')).toBeNull()
    expect(apiKeyFromHeader('kip_noauth')).toBeNull() // no Bearer, no cookie path either
    expect(apiKeyFromHeader('basic kip_deadbeef')).toBeNull()
  })
})

describe('ApiKeyCreate', () => {
  it('accepts a valid request', () => {
    const parsed = ApiKeyCreate.safeParse({
      name: 'CI runner',
      scopes: ['tickets:read'],
      expiresAt: null,
    })
    expect(parsed.success).toBe(true)
  })

  it('requires at least one known scope', () => {
    expect(ApiKeyCreate.safeParse({ name: 'x', scopes: [] }).success).toBe(false)
    expect(ApiKeyCreate.safeParse({ name: 'x', scopes: ['tickets:readall'] }).success).toBe(false)
  })

  it('accepts an absent or null expiry', () => {
    expect(ApiKeyCreate.safeParse({ name: 'x', scopes: ['time:read'] }).success).toBe(true)
    expect(ApiKeyCreate.safeParse({ name: 'x', scopes: ['time:read'], expiresAt: null }).success).toBe(
      true,
    )
    expect(
      ApiKeyCreate.safeParse({
        name: 'x',
        scopes: ['time:read'],
        expiresAt: '2027-01-01T00:00:00Z',
      }).success,
    ).toBe(true)
  })

  it('rejects empty names', () => {
    expect(ApiKeyCreate.safeParse({ name: '   ', scopes: API_KEY_SCOPES }).success).toBe(false)
  })
})
