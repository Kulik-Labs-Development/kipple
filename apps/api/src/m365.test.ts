import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildApp } from './app'
import { db } from './db'
import { runMigrations } from './db/migrate'
import { emailOutbox, settings, users } from './db/schema'
import { closeMail, processOutboxJob } from './mail'
import { encryptAtRest } from '@kipple/shared'

type App = Awaited<ReturnType<typeof buildApp>>

// CI fixtures only — fake tenant/client ids and a fake secret. The secret
// must never appear anywhere except as this constant in the test source.
const TENANT = '99999999-8888-7777-6666-555555555555'
const CLIENT = '00000000-1111-2222-3333-444444444444'
const CLIENT2 = 'cccccccc-0000-1111-2222-333333333333'
const SECRET = 'ci-fake-m365-secret'
const SENDER = 'helpdesk@ci-kipple.test'

const owner = {
  instanceName: 'CI Test MSP',
  ownerName: 'CI Owner',
  ownerEmail: 'ci-owner@ci-kipple.test',
  password: 'ci-owner-pass-123',
}

function cookiesFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie']
  const list = Array.isArray(raw) ? raw : [raw]
  return list
    .filter(Boolean)
    .map((cookie) => String(cookie).split(';')[0])
    .join('; ')
}

async function wipe() {
  await db.delete(emailOutbox)
  await db.delete(settings)
  await db.delete(users)
}

// Network stub at the fetch level: the m365 provider does real HTTP in
// production (token + graph); here login.microsoftonline.com and
// graph.microsoft.com are answered in-process. Other URLs pass through to
// the real fetch so nothing else in the app is affected.
const fetchLog: Array<{ url: string; init: RequestInit }> = []
let tokenStatus = 200
let tokenBody: Record<string, unknown> = { access_token: 'ci-token', expires_in: 3600 }
const userStatus = 200

const stubFetch = (async (input: string | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input)
  fetchLog.push({ url, init: init ?? {} })
  if (url.includes('/oauth2/v2.0/token')) {
    return new Response(JSON.stringify(tokenBody), {
      status: tokenStatus,
      headers: { 'content-type': 'application/json' },
    })
  }
  if (url.includes('/sendMail')) {
    return new Response('{}', { status: 202, headers: { 'content-type': 'application/json' } })
  }
  if (/\/users\/[^/]+$/.test(url)) {
    return new Response(JSON.stringify({ displayName: 'CI Helpdesk' }), {
      status: userStatus,
      headers: { 'content-type': 'application/json' },
    })
  }
  // Anything else (nothing else in this suite should fetch): quiet 200.
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })
}) as typeof fetch

describe('m365 outbound mail provider (api e2e)', () => {
  let app: App
  let cookie: string

  beforeAll(async () => {
    vi.stubGlobal('fetch', stubFetch)
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
    cookie = cookiesFrom(login)
  })

  afterAll(async () => {
    await app.close()
    await closeMail()
    await wipe()
    vi.unstubAllGlobals()
  })

  it('back-compat: a legacy settings row (no provider field) reads as smtp, unchanged', async () => {
    // The exact pre-M365 persisted shape: no provider, no m365, enc1: password.
    const legacy = {
      domain: 'legacy-kipple.test',
      smtp: {
        host: 'smtp.legacy-kipple.test',
        port: 587,
        secure: false,
        startTls: true,
        from: 'support@legacy-kipple.test',
        auth: {
          username: 'relay',
          password: encryptAtRest('hunter2', process.env.AUTH_SECRET!),
        },
      },
    }
    await db
      .insert(settings)
      .values({ key: 'email', value: legacy })
      .onConflictDoUpdate({ target: settings.key, set: { value: legacy } })

    const res = await app.inject({ method: 'GET', url: '/api/email', headers: { cookie } })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({
      configured: true,
      provider: 'smtp',
      domain: 'legacy-kipple.test',
      m365: null,
    })

    const providerRes = await app.inject({
      method: 'GET',
      url: '/api/outbox/provider',
      headers: { cookie },
    })
    expect(providerRes.json()).toMatchObject({
      configured: true,
      status: { ok: true },
    })
    expect(providerRes.json().status.detail).toContain('smtp.legacy-kipple.test:587')
  })

  it('saves m365 settings with the client secret encrypted at rest and masked on read', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/email',
      headers: { cookie },
      payload: {
        domain: 'ci-kipple.test',
        provider: 'm365',
        m365: {
          tenantId: TENANT,
          clientId: CLIENT,
          clientSecret: SECRET,
          senderAddress: SENDER,
          mode: 'graph',
        },
      },
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body).toMatchObject({
      configured: true,
      provider: 'm365',
      m365: {
        tenantId: TENANT,
        clientId: CLIENT,
        senderAddress: SENDER,
        mode: 'graph',
        hasSecret: true,
      },
    })
    const wire = JSON.stringify(body)
    expect(wire).not.toContain(SECRET)

    // At rest: enc1: ciphertext, plaintext absent.
    const [row] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'email'))
    const atRest = JSON.stringify(row?.value)
    expect(atRest).toContain('enc1:')
    expect(atRest).not.toContain(SECRET)

    // Re-read through GET (DB → decrypt → mask round trip).
    const getRes = await app.inject({ method: 'GET', url: '/api/email', headers: { cookie } })
    expect(getRes.json()).toMatchObject({ configured: true, provider: 'm365' })
    expect(getRes.json().m365).toMatchObject({ hasSecret: true })
    expect(JSON.stringify(getRes.json())).not.toContain(SECRET)
  })

  it('validates the m365 shape (rejects non-GUID ids)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/email',
      headers: { cookie },
      payload: {
        provider: 'm365',
        m365: {
          tenantId: 'not-a-guid',
          clientId: CLIENT,
          clientSecret: SECRET,
          senderAddress: SENDER,
          mode: 'graph',
        },
      },
    })
    expect(res.statusCode).toBe(400)
  })

  it('dispatches test-connection to the m365 provider (token + sender probe)', async () => {
    fetchLog.length = 0
    const res = await app.inject({
      method: 'POST',
      url: '/api/email/test-connection',
      headers: { cookie },
      payload: {
        provider: 'm365',
        m365: {
          tenantId: TENANT,
          clientId: CLIENT,
          clientSecret: SECRET,
          senderAddress: SENDER,
          mode: 'graph',
        },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().ok).toBe(true)
    // The real provider ran against the stubbed network: token first (with
    // the fake secret), then the sender probe with the bearer.
    const tokenCall = fetchLog.find((c) => c.url.includes('/oauth2/v2.0/token'))
    expect(tokenCall).toBeDefined()
    const tokenBody = new URLSearchParams(tokenCall!.init.body as string)
    expect(tokenBody.get('client_secret')).toBe(SECRET)
    expect(tokenBody.get('scope')).toBe('https://graph.microsoft.com/.default')
    const userCall = fetchLog.find((c) => c.url.includes('/users/'))
    expect(userCall).toBeDefined()
    expect((userCall!.init.headers as Record<string, string>).authorization).toBe(
      'Bearer ci-token',
    )
  })

  it('surfaces a rejected client (bad secret) as a failed test-connection', async () => {
    tokenStatus = 400
    tokenBody = {
      error: 'invalid_client',
      error_description: 'AADSTS7000215: Invalid client secret provided.',
    }
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/email/test-connection',
        headers: { cookie },
        payload: {
          provider: 'm365',
          m365: {
            tenantId: TENANT,
            clientId: CLIENT,
            clientSecret: 'wrong-secret',
            senderAddress: SENDER,
            mode: 'graph',
          },
        },
      })
      expect(res.statusCode).toBe(200)
      expect(res.json().ok).toBe(false)
      expect(res.json().detail).toContain('AADSTS7000215')
    } finally {
      tokenStatus = 200
      tokenBody = { access_token: 'ci-token', expires_in: 3600 }
    }
  })

  it('one-click test send enqueues on the m365 provider and delivers via graph', async () => {
    fetchLog.length = 0
    const res = await app.inject({
      method: 'POST',
      url: '/api/outbox/test',
      headers: { cookie },
      payload: { to: 'ops@ci-kipple.test' },
    })
    expect(res.statusCode).toBe(202)
    const id = res.json().id

    const [row] = await db.select().from(emailOutbox).where(eq(emailOutbox.id, id))
    expect(row.from).toBe(SENDER)
    expect(row.provider).toBe('m365')
    expect(row.status).toBe('queued')

    const result = await processOutboxJob(id)
    expect(result.action).toBe('sent')

    const sendCall = fetchLog.find((c) => c.url.includes('/sendMail'))
    expect(sendCall).toBeDefined()
    expect(sendCall!.url).toContain(`/users/${encodeURIComponent(SENDER)}/sendMail`)
    const payload = JSON.parse(sendCall!.init.body as string) as {
      message: { isMessageMime: boolean; body: { content: string } }
    }
    expect(payload.message.isMessageMime).toBe(true)
    expect(payload.message.body.content).toContain('To: ops@ci-kipple.test')
    expect(payload.message.body.content).toContain('outbound email is working')

    const [after] = await db.select().from(emailOutbox).where(eq(emailOutbox.id, id))
    expect(after.status).toBe('sent')
    expect(after.attempts).toBe(1)
  })

  it('a saved m365 config without a secret is not configured', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/email',
      headers: { cookie },
      payload: {
        provider: 'm365',
        m365: {
          tenantId: TENANT,
          clientId: CLIENT2,
          senderAddress: SENDER,
          mode: 'graph',
        },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ configured: false, provider: null, m365: { hasSecret: false } })

    const providerRes = await app.inject({
      method: 'GET',
      url: '/api/outbox/provider',
      headers: { cookie },
    })
    expect(providerRes.json().configured).toBe(false)

    const testRes = await app.inject({
      method: 'POST',
      url: '/api/outbox/test',
      headers: { cookie },
      payload: { to: 'ops@ci-kipple.test' },
    })
    expect(testRes.statusCode).toBe(400)
  })

  it('a blank client secret with the same identity keeps the stored secret', async () => {
    // First save stores the secret encrypted.
    const first = await app.inject({
      method: 'POST',
      url: '/api/email',
      headers: { cookie },
      payload: {
        provider: 'm365',
        m365: {
          tenantId: TENANT,
          clientId: CLIENT,
          clientSecret: SECRET,
          senderAddress: SENDER,
          mode: 'graph',
        },
      },
    })
    expect(first.statusCode).toBe(200)

    // The panel cannot read the masked secret back, so a re-save of the same
    // identity with a blank secret must keep the stored credential.
    const res = await app.inject({
      method: 'POST',
      url: '/api/email',
      headers: { cookie },
      payload: {
        provider: 'm365',
        m365: {
          tenantId: TENANT,
          clientId: CLIENT,
          senderAddress: SENDER,
          mode: 'graph',
        },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ configured: true, provider: 'm365', m365: { hasSecret: true } })

    const [row] = await db.select().from(settings).where(eq(settings.key, 'email'))
    const value = row.value as { m365?: { clientSecret: string } }
    expect(value.m365?.clientSecret).toMatch(/^enc1:/)

    // A different identity with a blank secret clears it.
    const cleared = await app.inject({
      method: 'POST',
      url: '/api/email',
      headers: { cookie },
      payload: {
        provider: 'm365',
        m365: {
          tenantId: TENANT,
          clientId: CLIENT2,
          senderAddress: SENDER,
          mode: 'graph',
        },
      },
    })
    expect(cleared.json()).toMatchObject({ configured: false, provider: null, m365: { hasSecret: false } })
  })
})
