import { afterEach, describe, expect, it, vi } from 'vitest'
import { dynamicTrustedOrigins } from './auth'

/**
 * The "Invalid origin" sign-out / re-sign-in bug (Max's report, 09-02):
 * better-auth's origin check only runs once a request carries a cookie, and
 * the trusted list was static (PUBLIC_URL + dev origins), so a browser
 * addressed to the instance from a different host 403'd on every
 * cookie-bearing auth call — sign-out failed invisibly, re-sign-in failed
 * on the login screen. The fix trusts the origin the request is addressed
 * to (Host, or X-Forwarded-Host/Proto behind a trusted proxy).
 *
 * Unit tests of the resolver itself: under vitest better-auth disables its
 * origin middleware (isTest() → skipOriginCheck), so the middleware path
 * cannot be exercised in the suite — the resolver is the unit under test.
 */
const publicUrl = process.env.PUBLIC_URL ?? 'http://localhost:3000'
const staticOrigins = [publicUrl, 'http://localhost:5173', 'http://127.0.0.1:5173']

/**
 * Mirrors the runtime shape: auth-routes.ts builds the Request from the
 * raw Node headers (`fromNodeHeaders`), which always carry the wire
 * `Host` header. undici's Request does not expose the URL-derived host
 * (live-probed on node 22), so the test passes it explicitly, exactly as
 * the runtime does.
 */
function requestFor(host: string, extra: Record<string, string> = {}): Request {
  return new Request(`http://${host}/api/auth/sign-in/email`, {
    headers: { host, ...extra },
  })
}

describe('dynamicTrustedOrigins', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('returns exactly the static list when no request is supplied', () => {
    expect(dynamicTrustedOrigins()).toEqual(staticOrigins)
  })

  it('trusts the origin the request is addressed to, both schemes (the reported case)', () => {
    vi.stubEnv('TRUST_PROXY', 'false')
    const origins = dynamicTrustedOrigins(requestFor('192.168.0.15:3000'))
    expect(origins.slice(0, staticOrigins.length)).toEqual(staticOrigins)
    expect(origins).toContain('http://192.168.0.15:3000')
    expect(origins).toContain('https://192.168.0.15:3000')
    expect(origins).not.toContain('http://evil.example')
  })

  it('honors X-Forwarded-Host/Proto when TRUST_PROXY=true', () => {
    vi.stubEnv('TRUST_PROXY', 'true')
    const origins = dynamicTrustedOrigins(
      requestFor('192.168.0.15:3000', {
        'x-forwarded-host': 'example.com',
        'x-forwarded-proto': 'https',
      }),
    )
    expect(origins).toContain('https://example.com')
    expect(origins).not.toContain('http://example.com')
  })

  it('ignores a client-spoofed X-Forwarded-Host when TRUST_PROXY is off', () => {
    vi.stubEnv('TRUST_PROXY', 'false')
    const origins = dynamicTrustedOrigins(
      requestFor('192.168.0.15:3000', {
        'x-forwarded-host': 'evil.example',
        'x-forwarded-proto': 'https',
      }),
    )
    expect(origins).not.toContain('https://evil.example')
    expect(origins).not.toContain('http://evil.example')
    // Falls back to the host the request is actually addressed to.
    expect(origins).toContain('http://192.168.0.15:3000')
  })

  it('does not throw on an unparseable forwarded host and keeps the static list', () => {
    vi.stubEnv('TRUST_PROXY', 'true')
    const origins = dynamicTrustedOrigins(
      requestFor('192.168.0.15:3000', { 'x-forwarded-host': 'bad host!!' }),
    )
    expect(origins).toEqual(staticOrigins)
  })
})
