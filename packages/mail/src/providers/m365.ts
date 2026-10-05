import type { M365EmailConfig } from '@kipple/shared'
import nodemailer, { type Transporter } from 'nodemailer'
import type { MailProvider, OutboundMessage, ProviderStatus } from './types'

// Microsoft 365 / Exchange Online outbound (PLAN §5b, Phase 2).
//
// OAuth2 client credentials: a service principal (app registration) with an
// admin-consented app permission — Mail.Send for graph mode, SMTP.SendAsApp
// for smtp mode (Exchange service, not Graph). No user is involved; the
// sender mailbox is the configured `senderAddress`.
//
// The token client is zero-dependency on purpose (house pattern, like the
// S3 SigV4 client): node:fetch against the identity platform's v2.0 token
// endpoint. `fetch` and the clock are injectable so tests run offline.
//
// NOTE on scope (flagged in the PR): the Microsoft identity platform
// requires the `scope` parameter for the client-credentials grant to be the
// resource identifier + ".default" — NOT a user scope. offline_access is
// only meaningful for refresh-token (delegated) flows; with
// client_credentials it would issue a token carrying no scopes, which Graph
// and Exchange would reject. The mode therefore maps to:
//   graph → https://graph.microsoft.com/.default   (Mail.Send app permission)
//   smtp  → https://outlook.office365.com/.default (SMTP.SendAsApp, Exchange)
// which is exactly the set of admin-consented app permissions — nothing
// more is requested.

export const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0'
const IDENTITY_BASE_URL = 'https://login.microsoftonline.com'
const GRAPH_DEFAULT_SCOPE = 'https://graph.microsoft.com/.default'
const EXCHANGE_DEFAULT_SCOPE = 'https://outlook.office365.com/.default'
const EXCHANGE_SMTP_HOST = 'smtp-mail.outlook.com'
const EXCHANGE_SMTP_PORT = 587
// Refresh this long before expiry so a clock skew (or a slow token endpoint)
// never hands a call an already-dead token.
const REFRESH_MARGIN_MS = 60_000
const DEFAULT_TOKEN_LIFETIME_S = 3600

export interface M365TokenClientOptions {
  /** Injectable fetch (tests stub this; production uses node:fetch). */
  fetchImpl?: typeof fetch
  /** Injectable clock in ms (tests drive expiry/skew deterministically). */
  now?: () => number
}

interface TokenEntry {
  accessToken: string
  expiresAt: number
}

// Client-credentials token client with an in-memory cache and a
// 60s-before-expiry refresh. The cache lives on the provider instance, so
// two providers (e.g. a saved-settings provider plus a test-connection
// provider) never share tokens.
export class M365TokenClient {
  private token: TokenEntry | null = null
  private inflight: Promise<TokenEntry> | null = null

  constructor(
    private readonly config: M365EmailConfig,
    private readonly options: M365TokenClientOptions = {},
  ) {}

  /** The resolved fetch implementation (injected or node:fetch) — the graph
   *  call paths reuse it so every HTTP hop is testable. */
  get fetch(): typeof fetch {
    return this.options.fetchImpl ?? fetch
  }

  /** Returns a valid access token, fetching (or reusing) one. */
  async accessToken(): Promise<string> {
    const now = this.now()
    if (this.token && this.token.expiresAt - now > REFRESH_MARGIN_MS) {
      return this.token.accessToken
    }
    if (this.inflight) return (await this.inflight).accessToken
    const pending = this.fetchToken()
    this.inflight = pending
    try {
      this.token = await pending
    } finally {
      this.inflight = null
    }
    return this.token.accessToken
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private async fetchToken(): Promise<TokenEntry> {
    const scope =
      this.config.mode === 'smtp' ? EXCHANGE_DEFAULT_SCOPE : GRAPH_DEFAULT_SCOPE
    const res = await this.fetch(
      `${IDENTITY_BASE_URL}/${this.config.tenantId}/oauth2/v2.0/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.config.clientId,
          client_secret: this.config.clientSecret ?? '',
          grant_type: 'client_credentials',
          scope,
        }),
      },
    )
    const text = await res.text()
    let body: {
      access_token?: string
      expires_in?: number
      error?: string
      error_description?: string
    }
    try {
      body = JSON.parse(text)
    } catch {
      body = {}
    }
    // error_description carries the AADSTS code + human text; it never
    // includes the client secret.
    if (!res.ok || !body.access_token) {
      const detail = body.error_description || body.error || 'no access token in response'
      // A 4xx here is a rejected CLIENT (bad secret, bad grant, not
      // registered in Exchange) — it will not fix itself on retry, so map
      // it onto 535 (auth failure) for the delivery pipeline's permanent
      // classification. 5xx and network failures stay retryable.
      const responseCode = res.status >= 400 && res.status < 500 ? 535 : undefined
      throw new M365TokenError(
        `m365 token request failed (http ${res.status}): ${detail}`,
        responseCode,
      )
    }
    const lifetimeS = Number.isFinite(body.expires_in) ? body.expires_in! : DEFAULT_TOKEN_LIFETIME_S
    return { accessToken: body.access_token, expiresAt: this.now() + lifetimeS * 1000 }
  }
}

// A failure carrying (or not) the mapped SMTP responseCode that the
// delivery pipeline's isPermanentMailError() already classifies:
//   535 auth failure (bad token / rejected client)  → permanent
//   550 user unknown  (sender missing / no Mail.Send consent) → permanent
//   no code (429 throttled, 5xx, network) → retry with backoff
export class M365MailError extends Error {
  constructor(
    message: string,
    public readonly responseCode?: number,
  ) {
    super(message)
    this.name = new.target.name
  }
}

export class M365TokenError extends M365MailError {}

export class GraphSendError extends M365MailError {}

// Graph sendMail rejects the message instead of sending when any of these
// apply — they will not fix themselves on retry.
function graphHttpStatusToResponseCode(status: number): number | undefined {
  if (status === 401) return 535
  if (status === 403 || status === 404) return 550
  return undefined
}

// The delivery pipeline hands providers plain text (HTML is stripped at the
// enqueue seam), so the MIME body is text/plain; a future HTML-capable
// pipeline would attach an alternative part here.
function buildMimeMessage(message: OutboundMessage): string {
  const from = message.fromName
    ? `"${message.fromName}" <${message.from}>`
    : message.from
  const lines = [
    `From: ${encodeMimeHeader(from)}`,
    `To: ${encodeMimeHeader(message.to)}`,
    `Subject: ${encodeMimeHeader(message.subject)}`,
  ]
  if (message.messageId) lines.push(`Message-ID: ${message.messageId}`)
  if (message.replyTo) lines.push(`Reply-To: ${message.replyTo}`)
  if (message.inReplyTo) lines.push(`In-Reply-To: ${message.inReplyTo}`)
  lines.push('Content-Type: text/plain; charset=utf-8')
  lines.push('Content-Transfer-Encoding: 8bit')
  lines.push('', message.body)
  return lines.join('\r\n')
}

// RFC 2047 B-encoding for non-ASCII header values (ASCII passes through).
function encodeMimeHeader(value: string): string {
  if (value.length === 0 || /^[\x20-\x7e]*$/.test(value)) return value
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`
}

export interface M365ProviderOptions extends M365TokenClientOptions {
  /** Injectable token client (tests pre-seed or stub it). */
  tokenClient?: M365TokenClient
  // SMTP endpoint overrides — production is Exchange Online's fixed endpoint
  // (smtp-mail.outlook.com:587, STARTTLS). Tests point these at a local
  // smtp-server to exercise the real AUTH XOAUTH2 handshake.
  smtpHost?: string
  smtpPort?: number
  requireTls?: boolean
}

export class M365Provider implements MailProvider {
  name = 'm365'

  private readonly tokenClient: M365TokenClient
  private readonly smtpHost: string
  private readonly smtpPort: number
  private readonly requireTls: boolean

  constructor(
    private readonly config: M365EmailConfig,
    options: M365ProviderOptions = {},
  ) {
    this.tokenClient =
      options.tokenClient ??
      new M365TokenClient(config, { fetchImpl: options.fetchImpl, now: options.now })
    this.smtpHost = options.smtpHost ?? EXCHANGE_SMTP_HOST
    this.smtpPort = options.smtpPort ?? EXCHANGE_SMTP_PORT
    this.requireTls = options.requireTls ?? true
  }

  async send(message: OutboundMessage): Promise<ProviderStatus> {
    if (this.config.mode === 'smtp') return this.sendViaSmtp(message)
    return this.sendViaGraph(message)
  }

  // Graph: POST /v1.0/users/{sender}/sendMail with the full MIME message.
  // Exchange sends it AS the sender (the service principal's Mail.Send app
  // permission authorizes it), so Message-ID / Reply-To / In-Reply-To from
  // the pipeline survive verbatim — threading depends on them.
  private async sendViaGraph(message: OutboundMessage): Promise<ProviderStatus> {
    const token = await this.tokenClient.accessToken()
    const res = await this.tokenClient.fetch(`${GRAPH_BASE_URL}/users/${encodeURIComponent(this.config.senderAddress)}/sendMail`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        message: { isMessageMime: true, body: { content: buildMimeMessage(message) } },
        saveToSentItems: false,
      }),
    })
    if (res.status === 202) {
      return { ok: true, detail: `accepted by graph for ${this.config.senderAddress}` }
    }
    const text = await res.text().catch(() => '')
    throw new GraphSendError(
      `m365 graph send failed (http ${res.status}): ${extractGraphError(text, res.status)}`,
      graphHttpStatusToResponseCode(res.status),
    )
  }

  // SMTP AUTH with an OAuth2 bearer (SmtpAuthAcceptanceOAuth2 must be enabled
  // on the mailbox). The token is fetched at transport-build time — a fresh
  // bearer per send, no client secret ever enters nodemailer's options.
  private async sendViaSmtp(message: OutboundMessage): Promise<ProviderStatus> {
    const transport = await this.buildSmtpTransport()
    try {
      const info = await transport.sendMail({
        from: message.fromName ? `"${message.fromName}" <${message.from}>` : message.from,
        to: message.to,
        replyTo: message.replyTo,
        inReplyTo: message.inReplyTo,
        messageId: message.messageId,
        subject: message.subject,
        text: message.body,
      })
      return { ok: true, detail: `accepted: ${info.messageId}` }
    } finally {
      this.closeQuietly(transport)
    }
  }

  private async buildSmtpTransport(): Promise<Transporter> {
    const token = await this.tokenClient.accessToken()
    return nodemailer.createTransport({
      host: this.smtpHost,
      port: this.smtpPort,
      secure: false,
      requireTLS: this.requireTls,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
      auth: {
        type: 'oauth2',
        user: this.config.senderAddress,
        // The provision callback is nodemailer's documented seam for custom
        // token acquisition — it hands back OUR fetched bearer, so the
        // transport only ever sees a token, never credentials. The transport
        // is single-use (closed after the send), so expires 0 (no internal
        // renewal) is correct.
        provisionCallback: (
          _user: string,
          _renew: boolean,
          callback: (err: Error | null, accessToken: string, expires: number) => void,
        ) => callback(null, token, 0),
      },
    })
  }

  // @types/nodemailer types close() as void but the runtime may return a
  // promise — tolerate both.
  private closeQuietly(transport: Transporter): void {
    try {
      const result = transport.close() as unknown
      if (result instanceof Promise) void result.catch(() => undefined)
    } catch {
      /* single-use transport; nothing left to clean up */
    }
  }

  async testConnection(): Promise<ProviderStatus> {
    if (this.config.mode === 'smtp') {
      try {
        const transport = await this.buildSmtpTransport()
        try {
          await transport.verify()
          return {
            ok: true,
            detail: `smtp oauth2 handshake ok as ${this.config.senderAddress}`,
          }
        } finally {
          this.closeQuietly(transport)
        }
      } catch (error) {
        return { ok: false, detail: error instanceof Error ? error.message : String(error) }
      }
    }
    // graph: fetch a token (the real credential check), then a light probe
    // of the sender. A Mail.Send-only app cannot read /users/{sender} — a 403
    // there means the TOKEN is accepted but the read was not, so report ok
    // with a note instead of failing a correct setup (the test send is the
    // real send-rights check).
    try {
      await this.tokenClient.accessToken()
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
    try {
      const res = await this.tokenClient.fetch(
        `${GRAPH_BASE_URL}/users/${encodeURIComponent(this.config.senderAddress)}`,
        { headers: { authorization: `Bearer ${await this.tokenClient.accessToken()}` } },
      )
      if (res.ok) {
        return { ok: true, detail: `graph: authenticated as ${this.config.senderAddress}` }
      }
      if (res.status === 403) {
        return {
          ok: true,
          detail:
            'graph: token accepted; the sender lookup needs a read permission the Mail.Send-only app may not have — verify sending with a test send',
        }
      }
      return {
        ok: false,
        detail: `graph: sender check failed (http ${res.status}): ${await res
          .text()
          .catch(() => '')}`,
      }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  status(): ProviderStatus {
    return {
      ok: true,
      detail: `m365 ${this.config.mode} ${this.config.senderAddress} (tenant ${this.config.tenantId})`,
    }
  }
}

export function createM365Provider(
  config: M365EmailConfig,
  options: M365ProviderOptions = {},
): MailProvider {
  return new M365Provider(config, options)
}

// The Graph error body is JSON ({ error: { code, message } }) — surface the
// code + message only (never echo the token, which the server does not
// return anyway).
function extractGraphError(text: string, status: number): string {
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } }
    if (parsed?.error?.code || parsed?.error?.message) {
      return [parsed.error?.code, parsed.error?.message].filter(Boolean).join(': ')
    }
  } catch {
    /* not JSON — fall through */
  }
  return text ? text.slice(0, 300) : `http ${status}`
}
