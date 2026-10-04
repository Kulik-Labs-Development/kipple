import { afterAll, describe, expect, it } from 'vitest'
import { SMTPServer } from 'smtp-server'
import { isPermanentMailError } from '../deliver'
import {
  GRAPH_BASE_URL,
  GraphSendError,
  M365Provider,
  M365TokenClient,
  M365TokenError,
  createM365Provider,
  type M365ProviderOptions,
} from './m365'
import type { M365EmailConfig } from '@kipple/shared'

// Fake Entra / Graph server for the token client + graph paths. Records every
// request and plays back canned responses per URL.
interface FakeFetchCall {
  url: string
  init: RequestInit
}
interface FakeFetch {
  fn: typeof fetch
  calls: FakeFetchCall[]
}

function fakeFetch(routes: Array<{ match: RegExp; status?: number; body?: unknown }>): FakeFetch {
  const calls: FakeFetchCall[] = []
  const fn = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init: init ?? {} })
    const route = routes.find((r) => r.match.test(url))
    const status = route?.status ?? 200
    const body = route?.body ?? { access_token: 'tok-1', expires_in: 3600 }
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fn, calls }
}

const TENANT = '11111111-2222-3333-4444-555555555555'
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function cfg(overrides: Partial<M365EmailConfig> = {}): M365EmailConfig {
  return {
    tenantId: TENANT,
    clientId: CLIENT,
    clientSecret: 'fake-secret',
    senderAddress: 'helpdesk@contoso.com',
    mode: 'graph',
    ...overrides,
  }
}

// A controllable clock so expiry/skew are deterministic.
function clock(start = 1_700_000_000_000) {
  let t = start
  return { now: () => t, advance: (ms: number) => (t += ms), value: () => t }
}

const TOKEN_URL = `${'https://login.microsoftonline.com'}/${TENANT}/oauth2/v2.0/token`

describe('M365TokenClient (client-credentials, zero-dep)', () => {
  it('POSTs the client-credentials grant to the tenant token endpoint with the right scope', async () => {
    const { fn, calls } = fakeFetch([{ match: /oauth2\/v2.0\/token/ }])
    const client = new M365TokenClient(cfg({ mode: 'graph' }), { fetchImpl: fn, now: clock().now })
    await client.accessToken()
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(TOKEN_URL)
    const body = new URLSearchParams(calls[0].init.body as string)
    expect(body.get('grant_type')).toBe('client_credentials')
    expect(body.get('client_id')).toBe(CLIENT)
    expect(body.get('client_secret')).toBe('fake-secret')
    expect(body.get('scope')).toBe('https://graph.microsoft.com/.default')
  })

  it('uses the Exchange scope in smtp mode', async () => {
    const { fn, calls } = fakeFetch([{ match: /oauth2\/v2.0\/token/ }])
    const client = new M365TokenClient(cfg({ mode: 'smtp' }), { fetchImpl: fn, now: clock().now })
    await client.accessToken()
    const body = new URLSearchParams(calls[0].init.body as string)
    expect(body.get('scope')).toBe('https://outlook.office365.com/.default')
  })

  it('caches the token: a second call within expiry does not refetch', async () => {
    const { fn, calls } = fakeFetch([{ match: /oauth2\/v2.0\/token/ }])
    const c = clock()
    const client = new M365TokenClient(cfg(), { fetchImpl: fn, now: c.now })
    expect(await client.accessToken()).toBe('tok-1')
    c.advance(30_000) // well inside the 1h life
    expect(await client.accessToken()).toBe('tok-1')
    expect(calls).toHaveLength(1)
  })

  it('refreshes after the token expires (clock-injected)', async () => {
    const { fn, calls } = fakeFetch([{ match: /oauth2\/v2.0\/token/ }])
    const c = clock()
    const client = new M365TokenClient(cfg(), { fetchImpl: fn, now: c.now })
    await client.accessToken()
    c.advance(3_600_000) // past the 1h lifetime
    await client.accessToken()
    expect(calls).toHaveLength(2)
  })

  it('refreshes 60s before expiry (skew margin)', async () => {
    const { fn, calls } = fakeFetch([{ match: /oauth2\/v2.0\/token/ }])
    const c = clock()
    const client = new M365TokenClient(cfg(), { fetchImpl: fn, now: c.now })
    await client.accessToken()
    c.advance(3_600_000 - 30_000) // 30s left, inside the 60s margin
    await client.accessToken()
    expect(calls).toHaveLength(2)
  })

  it('coalesces concurrent calls into one fetch (in-flight dedupe)', async () => {
    const { fn, calls } = fakeFetch([{ match: /oauth2\/v2.0\/token/ }])
    const client = new M365TokenClient(cfg(), { fetchImpl: fn, now: clock().now })
    const [a, b] = await Promise.all([client.accessToken(), client.accessToken()])
    expect(a).toBe(b)
    expect(calls).toHaveLength(1)
  })

  it('throws a permanent (535) token error on a rejected client (4xx)', async () => {
    const { fn } = fakeFetch([
      {
        match: /oauth2\/v2.0\/token/,
        status: 400,
        body: {
          error: 'invalid_client',
          error_description: 'AADSTS7000215: Invalid client secret provided.',
        },
      },
    ])
    const client = new M365TokenClient(cfg(), { fetchImpl: fn, now: clock().now })
    await expect(client.accessToken()).rejects.toBeInstanceOf(M365TokenError)
    let caught: unknown
    try {
      await client.accessToken()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(M365TokenError)
    expect(isPermanentMailError(caught)).toBe(true)
    expect(String((caught as Error).message)).toContain('AADSTS7000215')
  })

  it('treats a 5xx token failure as retryable (no responseCode)', async () => {
    const { fn } = fakeFetch([{ match: /oauth2\/v2.0\/token/, status: 503, body: { error: 'server_error' } }])
    const client = new M365TokenClient(cfg(), { fetchImpl: fn, now: clock().now })
    let caught: unknown
    try {
      await client.accessToken()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(M365TokenError)
    expect(isPermanentMailError(caught)).toBe(false)
  })
})

describe('M365Provider (graph mode)', () => {
  const graphRoutes = (extra: Array<{ match: RegExp; status?: number; body?: unknown }> = []) => [
    { match: /oauth2\/v2.0\/token/ },
    ...extra,
  ]

  it('sends via POST /users/{sender}/sendMail with the MIME message', async () => {
    const { fn, calls } = fakeFetch(
      graphRoutes([{ match: /sendMail$/, status: 202, body: {} }]),
    )
    const provider = new M365Provider(cfg({ mode: 'graph' }), { fetchImpl: fn, now: clock().now })
    const result = await provider.send({
      to: 'ada@acme.com',
      from: 'helpdesk@contoso.com',
      fromName: 'Contoso Support',
      subject: 'Re: [KIP-12] Printer',
      body: 'Let us know when the smoke clears.',
      replyTo: 'support+12@contoso.com',
      messageId: '<abc@contoso.com>',
    })
    expect(result.ok).toBe(true)

    const sendCall = calls.find((c) => c.url.endsWith('/sendMail'))
    expect(sendCall).toBeDefined()
    // The UPN is URL-encoded in the path segment (Graph accepts %40).
    expect(sendCall!.url).toBe(
      `${GRAPH_BASE_URL}/users/helpdesk%40contoso.com/sendMail`,
    )
    expect((sendCall!.init.headers as Record<string, string>).authorization).toBe('Bearer tok-1')
    const payload = JSON.parse(sendCall!.init.body as string) as {
      message: { isMessageMime: boolean; body: { content: string } }
      saveToSentItems: boolean
    }
    expect(payload.saveToSentItems).toBe(false)
    expect(payload.message.isMessageMime).toBe(true)
    const mime = payload.message.body.content
    expect(mime).toContain('To: ada@acme.com')
    expect(mime).toContain('From: "Contoso Support" <helpdesk@contoso.com>')
    expect(mime).toContain('Subject: Re: [KIP-12] Printer')
    expect(mime).toContain('Message-ID: <abc@contoso.com>')
    expect(mime).toContain('Reply-To: support+12@contoso.com')
    expect(mime).toContain('Content-Type: text/plain; charset=utf-8')
    expect(mime).toContain('Let us know when the smoke clears.')
  })

  it('B-encodes non-ASCII header values', async () => {
    const { fn, calls } = fakeFetch(graphRoutes([{ match: /sendMail$/, status: 202, body: {} }]))
    const provider = new M365Provider(cfg(), { fetchImpl: fn, now: clock().now })
    await provider.send({
      to: 'ada@acme.com',
      from: 'helpdesk@contoso.com',
      subject: 'Problème réseau',
      body: 'ok',
    })
    const sendCall = calls.find((c) => c.url.endsWith('/sendMail'))
    const mime = (JSON.parse(sendCall!.init.body as string) as { message: { body: { content: string } } })
      .message.body.content
    // "Problème réseau" base64
    expect(mime).toContain(`=?UTF-8?B?${Buffer.from('Problème réseau', 'utf8').toString('base64')}?=`)
  })

  it('maps a graph 401 to a permanent (535) error', async () => {
    const { fn } = fakeFetch(
      graphRoutes([
        {
          match: /sendMail$/,
          status: 401,
          body: { error: { code: 'Authorization_RequestDenied', message: 'Invalid token.' } },
        },
      ]),
    )
    const provider = new M365Provider(cfg(), { fetchImpl: fn, now: clock().now })
    let caught: unknown
    try {
      await provider.send({ to: 'a@b.com', from: 'helpdesk@contoso.com', subject: 's', body: 'b' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(GraphSendError)
    expect(isPermanentMailError(caught)).toBe(true)
    expect(String((caught as Error).message)).toContain('Authorization_RequestDenied')
  })

  it('maps a graph 404 (unknown sender) to permanent (550)', async () => {
    const { fn } = fakeFetch(
      graphRoutes([
        { match: /sendMail$/, status: 404, body: { error: { code: 'userNotFound', message: 'User not found' } } },
      ]),
    )
    const provider = new M365Provider(cfg(), { fetchImpl: fn, now: clock().now })
    let caught: unknown
    try {
      await provider.send({ to: 'a@b.com', from: 'helpdesk@contoso.com', subject: 's', body: 'b' })
    } catch (error) {
      caught = error
    }
    expect(isPermanentMailError(caught)).toBe(true)
  })

  it('keeps a graph 429 (throttled) retryable', async () => {
    const { fn } = fakeFetch(
      graphRoutes([{ match: /sendMail$/, status: 429, body: { error: { code: 'throttled', message: 'slow down' } } }]),
    )
    const provider = new M365Provider(cfg(), { fetchImpl: fn, now: clock().now })
    let caught: unknown
    try {
      await provider.send({ to: 'a@b.com', from: 'helpdesk@contoso.com', subject: 's', body: 'b' })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(GraphSendError)
    expect(isPermanentMailError(caught)).toBe(false)
  })
})

describe('M365Provider (testConnection, graph)', () => {
  it('ok when the token is accepted and the sender exists', async () => {
    const { fn } = fakeFetch([
      { match: /oauth2\/v2.0\/token/ },
      { match: /\/users\/helpdesk%40contoso\.com$/, status: 200, body: { displayName: 'Helpdesk' } },
    ])
    const provider = new M365Provider(cfg(), { fetchImpl: fn, now: clock().now })
    const result = await provider.testConnection()
    expect(result.ok).toBe(true)
    expect(result.detail).toContain('helpdesk@contoso.com')
  })

  it('ok (with a note) when the token is accepted but the sender read is 403 — a Mail.Send-only app', async () => {
    const { fn } = fakeFetch([
      { match: /oauth2\/v2.0\/token/ },
      {
        match: /\/users\/helpdesk%40contoso\.com$/,
        status: 403,
        body: { error: { code: 'Authorization_RequestDenied', message: 'Insufficient privileges' } },
      },
    ])
    const provider = new M365Provider(cfg(), { fetchImpl: fn, now: clock().now })
    const result = await provider.testConnection()
    expect(result.ok).toBe(true)
    expect(result.detail).toContain('test send')
  })

  it('fails with the token error when the client is rejected', async () => {
    const { fn } = fakeFetch([
      {
        match: /oauth2\/v2.0\/token/,
        status: 400,
        body: { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret provided.' },
      },
    ])
    const provider = new M365Provider(cfg(), { fetchImpl: fn, now: clock().now })
    const result = await provider.testConnection()
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('AADSTS7000215')
  })

  it('fails when the sender check 404s', async () => {
    const { fn } = fakeFetch([
      { match: /oauth2\/v2.0\/token/ },
      { match: /\/users\/helpdesk%40contoso\.com$/, status: 404, body: { error: { code: 'userNotFound' } } },
    ])
    const provider = new M365Provider(cfg(), { fetchImpl: fn, now: clock().now })
    const result = await provider.testConnection()
    expect(result.ok).toBe(false)
  })
})

describe('M365Provider (smtp mode — AUTH XOAUTH2)', () => {
  interface Captured {
    mailFrom: string
    rcptTo: string[]
    data: string
    auth: { method?: string; username?: string; accessToken?: string } | null
  }

  function startXoAuthServer(opts: { expectToken?: string }) {
    const captured: Captured = { mailFrom: '', rcptTo: [], data: '', auth: null }
    const server = new SMTPServer({
      secure: false,
      allowInsecureAuth: true,
      disabledCommands: ['STARTTLS'],
      authMethods: ['XOAUTH2'],
      onAuth(auth, _session, callback) {
        captured.auth = auth as Captured['auth']
        if (opts.expectToken && auth.accessToken !== opts.expectToken) {
          return callback(new Error('Authentication unsuccessful'))
        }
        callback(null, { user: auth.username })
      },
      onMailFrom(address, _session, callback) {
        captured.mailFrom = address.address
        callback()
      },
      onRcptTo(address, _session, callback) {
        captured.rcptTo.push(address.address)
        callback()
      },
      onData(stream, _session, callback) {
        const chunks: Buffer[] = []
        stream.on('data', (chunk: Buffer) => chunks.push(chunk))
        stream.on('end', () => {
          captured.data = Buffer.concat(chunks).toString('utf8')
          callback(null, 'OK')
        })
      },
    })
    return new Promise<{ port: number; captured: Captured; close: () => Promise<void> }>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.server.address()
        resolve({
          port: typeof address === 'object' && address ? address.port : 0,
          captured,
          close: () => new Promise((done) => server.close(done)),
        })
      })
    })
  }

  let close: (() => Promise<void>) | null = null
  afterAll(async () => {
    await close?.()
  })

  function smtpOpts(port: number, overrides: M365ProviderOptions = {}): M365ProviderOptions {
    return {
      smtpHost: '127.0.0.1',
      smtpPort: port,
      requireTls: false,
      ...overrides,
    }
  }

  it('sends over a real AUTH XOAUTH2 handshake with the fetched bearer', async () => {
    const { port, captured, close: serverClose } = await startXoAuthServer({ expectToken: 'tok-1' })
    close = serverClose
    const { fn } = fakeFetch([{ match: /oauth2\/v2.0\/token/ }])
    const provider = new M365Provider(cfg({ mode: 'smtp' }), {
      fetchImpl: fn,
      now: clock().now,
      ...smtpOpts(port),
    })
    const result = await provider.send({
      to: 'ada@acme.com',
      from: 'helpdesk@contoso.com',
      fromName: 'Contoso Support',
      subject: 'Hi',
      body: 'body',
    })
    expect(result.ok).toBe(true)
    expect(captured.auth?.method).toBe('XOAUTH2')
    expect(captured.auth?.username).toBe('helpdesk@contoso.com')
    expect(captured.auth?.accessToken).toBe('tok-1')
    expect(captured.mailFrom).toBe('helpdesk@contoso.com')
    expect(captured.rcptTo).toEqual(['ada@acme.com'])
    expect(captured.data).toContain('To: ada@acme.com')
    // nodemailer only quotes the display name when RFC 5322 requires it
    // ("Contoso Support" has no specials — no quotes)
    expect(captured.data).toContain('From: Contoso Support <helpdesk@contoso.com>')
  })

  it('testConnection does the handshake and reports success', async () => {
    const { port, close: serverClose } = await startXoAuthServer({ expectToken: 'tok-1' })
    close = serverClose
    const { fn } = fakeFetch([{ match: /oauth2\/v2.0\/token/ }])
    const provider = new M365Provider(cfg({ mode: 'smtp' }), {
      fetchImpl: fn,
      now: clock().now,
      ...smtpOpts(port),
    })
    const result = await provider.testConnection()
    expect(result.ok).toBe(true)
    expect(result.detail).toContain('oauth2')
  })

  it('testConnection fails when the bearer is rejected (535)', async () => {
    const { port, close: serverClose } = await startXoAuthServer({ expectToken: 'the-wrong-token' })
    close = serverClose
    const { fn } = fakeFetch([{ match: /oauth2\/v2.0\/token/ }])
    const provider = new M365Provider(cfg({ mode: 'smtp' }), {
      fetchImpl: fn,
      now: clock().now,
      ...smtpOpts(port),
    })
    const result = await provider.testConnection()
    expect(result.ok).toBe(false)
    expect(result.detail).toBeTruthy()
  })

  it('createM365Provider returns an m365-named provider whose status reports the config', () => {
    const provider = createM365Provider(cfg({ mode: 'graph' }))
    expect(provider.name).toBe('m365')
    const status = provider.status()
    expect(status.ok).toBe(true)
    expect(status.detail).toContain('graph')
    expect(status.detail).toContain('helpdesk@contoso.com')
    expect(status.detail).toContain(TENANT)
  })
})
