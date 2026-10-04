import { describe, expect, it } from 'vitest'
import {
  EmailSettings,
  M365EmailConfig,
  StoredEmailSettings,
  outboundSender,
} from './schemas'

const TENANT = '11111111-2222-3333-4444-555555555555'
const CLIENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

function smtpConfig(overrides: Record<string, unknown> = {}) {
  return {
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    startTls: true,
    from: 'support@example.com',
    ...overrides,
  }
}

function m365Config(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    clientId: CLIENT,
    clientSecret: 'not-a-real-secret',
    senderAddress: 'helpdesk@example.com',
    mode: 'graph' as const,
    ...overrides,
  }
}

describe('EmailSettings provider extension (Phase 2 — M365 outbound)', () => {
  it('back-compat: a row with no provider field deserializes as smtp', () => {
    // The pre-M365 persisted shape — exactly what an existing instance has.
    const parsed = EmailSettings.parse({ domain: 'example.com', smtp: smtpConfig() })
    expect(parsed.provider).toBe('smtp')
    expect(parsed.m365).toBeUndefined()
    expect(outboundSender(parsed)).toEqual({
      from: 'support@example.com',
      fromName: null,
    })
  })

  it('defaults to smtp and kipple.local when both are absent', () => {
    const parsed = EmailSettings.parse({})
    expect(parsed.provider).toBe('smtp')
    expect(parsed.domain).toBe('kipple.local')
  })

  it('accepts provider m365 with an m365 config', () => {
    const parsed = EmailSettings.parse({ provider: 'm365', m365: m365Config() })
    expect(parsed.provider).toBe('m365')
    expect(outboundSender(parsed)).toEqual({
      from: 'helpdesk@example.com',
      fromName: null,
    })
  })

  it('defaults the m365 mode to graph', () => {
    const parsed = M365EmailConfig.parse({
      tenantId: TENANT,
      clientId: CLIENT,
      clientSecret: 'x',
      senderAddress: 'helpdesk@example.com',
    })
    expect(parsed.mode).toBe('graph')
  })

  it('allows a blank or absent client secret (unset / cleared on save)', () => {
    expect(M365EmailConfig.parse(m365Config({ clientSecret: '' })).clientSecret).toBe('')
    expect(M365EmailConfig.parse(m365Config({ clientSecret: undefined })).clientSecret).toBeUndefined()
  })

  it('rejects unknown providers and bad m365 shapes', () => {
    expect(EmailSettings.safeParse({ provider: 'google' }).success).toBe(false)
    expect(
      M365EmailConfig.safeParse(m365Config({ tenantId: 'not-a-guid' })).success,
    ).toBe(false)
    expect(M365EmailConfig.safeParse(m365Config({ tenantId: '12345' })).success).toBe(false)
    expect(M365EmailConfig.safeParse(m365Config({ clientId: 'nope' })).success).toBe(false)
    expect(
      M365EmailConfig.safeParse(m365Config({ senderAddress: 'helpdesk' })).success,
    ).toBe(false)
    expect(M365EmailConfig.safeParse(m365Config({ mode: 'imap' })).success).toBe(false)
    expect(
      M365EmailConfig.safeParse(m365Config({ clientSecret: 'x'.repeat(4097) })).success,
    ).toBe(false)
  })

  it('accepts GUIDs case-insensitively', () => {
    expect(
      M365EmailConfig.safeParse(
        m365Config({ tenantId: TENANT.toUpperCase(), clientId: CLIENT.toUpperCase() }),
      ).success,
    ).toBe(true)
  })
})

describe('StoredEmailSettings (at-rest shapes)', () => {
  it('parses a legacy smtp-only stored row (enc1: password) unchanged', () => {
    const parsed = StoredEmailSettings.parse({
      domain: 'example.com',
      smtp: { ...smtpConfig(), auth: { username: 'relay', password: 'enc1:iv:tag:ct' } },
    })
    expect(parsed.provider).toBe('smtp')
    expect(parsed.smtp?.auth?.password).toBe('enc1:iv:tag:ct')
  })

  it('parses a stored row with an m365 client secret ciphertext', () => {
    const parsed = StoredEmailSettings.parse({
      provider: 'm365',
      m365: m365Config({ clientSecret: 'enc1:iv:tag:ct' }),
    })
    expect(parsed.m365?.clientSecret).toBe('enc1:iv:tag:ct')
    expect(outboundSender(parsed)).toEqual({
      from: 'helpdesk@example.com',
      fromName: null,
    })
  })
})

describe('outboundSender (active provider resolution)', () => {
  it('smtp provider: configured → sender, missing config → null', () => {
    expect(
      outboundSender(
        EmailSettings.parse({ provider: 'smtp', smtp: smtpConfig({ fromName: 'Help Desk' }) }),
      ),
    ).toEqual({ from: 'support@example.com', fromName: 'Help Desk' })
    expect(outboundSender(EmailSettings.parse({ provider: 'smtp' }))).toBeNull()
  })

  it('m365 provider: no config or blank secret → not configured', () => {
    expect(outboundSender(EmailSettings.parse({ provider: 'm365' }))).toBeNull()
    expect(
      outboundSender(EmailSettings.parse({ provider: 'm365', m365: m365Config({ clientSecret: '' }) })),
    ).toBeNull()
  })

  it('m365 provider: the m365 sender wins even when a legacy smtp config is stored', () => {
    const parsed = EmailSettings.parse({
      provider: 'm365',
      smtp: smtpConfig(),
      m365: m365Config(),
    })
    expect(outboundSender(parsed)).toEqual({ from: 'helpdesk@example.com', fromName: null })
  })
})
