import { describe, expect, it, vi } from 'vitest'
import type { EmailSettings } from '@kipple/shared'
import type { MailProvider, OutboundMessage } from './providers'
import type { OutboxPatch, OutboxRecord } from './deliver'
import { deliverOutbox, defaultBackoffMs } from './deliver'

const NOW = new Date('2026-08-31T12:00:00.000Z')

function makeRow(overrides: Partial<OutboxRecord> = {}): OutboxRecord {
  return {
    id: 'outbox-1',
    to: 'ada@acme.test',
    from: 'support@msp.test',
    fromName: 'MSP Support',
    subject: 'Re: [KIP-12] Printer is on fire',
    body: 'body text',
    replyTo: 'support+12@msp.test',
    messageId: '<12@msp.test>',
    provider: 'smtp',
    status: 'queued',
    error: null,
    attempts: 0,
    sentAt: null,
    ...overrides,
  }
}

const SETTINGS: EmailSettings = {
  domain: 'msp.test',
  provider: 'smtp',
  smtp: {
    host: 'mail.msp.test',
    port: 587,
    secure: false,
    startTls: true,
    auth: { username: 'relay', password: 'secret' },
    from: 'support@msp.test',
  },
}

function makeHarness(opts: {
  row?: OutboxRecord
  settings?: EmailSettings | null
  sendImpl?: (message: OutboundMessage) => Promise<unknown>
  createProviderError?: string
} = {}) {
  const row = opts.row ?? makeRow()
  const patches: OutboxPatch[] = []
  const send = vi.fn(opts.sendImpl ?? (async () => ({ ok: true, detail: 'accepted' })))
  const provider: MailProvider = {
    name: 'smtp',
    send: send as MailProvider['send'],
    testConnection: vi.fn().mockResolvedValue({ ok: true, detail: 'ok' }),
    status: () => ({ ok: true, detail: 'ok' }),
  }
  const deps: Parameters<typeof deliverOutbox>[1] = {
    loadRow: vi.fn(async () => row),
    patchRow: vi.fn(async (_id: string, patch: OutboxPatch) => {
      patches.push(patch)
      if (patch.status !== undefined) row.status = patch.status
      if (patch.error !== undefined) row.error = patch.error
      if (patch.attempts !== undefined) row.attempts = patch.attempts
      if (patch.sentAt !== undefined) row.sentAt = patch.sentAt
    }),
    loadSettings: vi.fn(async () =>
      opts.settings === undefined ? SETTINGS : opts.settings,
    ),
    createProvider: vi.fn(() => {
      if (opts.createProviderError) throw new Error(opts.createProviderError)
      return provider
    }),
    now: () => NOW,
  }
  return { deps, row, patches, send }
}

describe('deliverOutbox', () => {
  it('marks a row sent on provider success', async () => {
    const { deps, patches, send } = makeHarness()
    const result = await deliverOutbox('outbox-1', deps)
    expect(result).toEqual({ action: 'sent' })
    expect(send).toHaveBeenCalledWith({
      to: 'ada@acme.test',
      from: 'support@msp.test',
      fromName: 'MSP Support',
      subject: 'Re: [KIP-12] Printer is on fire',
      body: 'body text',
      replyTo: 'support+12@msp.test',
      messageId: '<12@msp.test>',
    })
    expect(patches).toEqual([
      expect.objectContaining({ status: 'sent', attempts: 1, error: null, sentAt: expect.any(Date) }),
    ])
  })

  it('skips rows that are not queued', async () => {
    for (const status of ['sent', 'failed', 'bounced']) {
      const { deps, send } = makeHarness({ row: makeRow({ status }) })
      const result = await deliverOutbox('outbox-1', deps)
      expect(result).toEqual({ action: 'skipped', reason: status })
      expect(send).not.toHaveBeenCalled()
    }
  })

  it('skips missing rows', async () => {
    const { deps } = makeHarness()
    vi.mocked(deps.loadRow).mockResolvedValue(null)
    const result = await deliverOutbox('gone', deps)
    expect(result).toEqual({ action: 'skipped', reason: 'not_found' })
  })

  it('fails with email_not_configured when no smtp settings exist', async () => {
    const { deps, patches } = makeHarness({ settings: { domain: 'msp.test', provider: 'smtp' } })
    const result = await deliverOutbox('outbox-1', deps)
    expect(result).toEqual({ action: 'failed', reason: 'email_not_configured' })
    expect(patches).toEqual([
      expect.objectContaining({ status: 'failed', error: 'email_not_configured' }),
    ])
  })

  it('fails when the provider cannot be created', async () => {
    const { deps, patches } = makeHarness({ createProviderError: 'unknown provider' })
    const result = await deliverOutbox('outbox-1', deps)
    expect(result.action).toBe('failed')
    expect(patches[0]).toEqual(
      expect.objectContaining({ status: 'failed', error: 'provider: unknown provider' }),
    )
  })

  it('retries transient errors with exponential backoff, then gives up', async () => {
    const { deps, patches, send } = makeHarness({
      sendImpl: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:25')
      },
    })
    for (let attempt = 1; attempt <= 4; attempt++) {
      const result = await deliverOutbox('outbox-1', deps)
      expect(result).toEqual({
        action: 'retry',
        nextTryAt: new Date(NOW.getTime() + defaultBackoffMs(attempt)),
      })
    }
    const final = await deliverOutbox('outbox-1', deps)
    expect(final).toEqual({ action: 'failed', reason: 'connect ECONNREFUSED 127.0.0.1:25' })
    expect(send).toHaveBeenCalledTimes(5)
    const last = patches[patches.length - 1]
    expect(last).toEqual(
      expect.objectContaining({ status: 'failed', attempts: 5, error: 'connect ECONNREFUSED 127.0.0.1:25' }),
    )
    expect(patches.slice(0, 4).every((patch) => patch.status === 'queued' && patch.nextTryAt)).toBe(true)
  })

  it('succeeds after transient failures', async () => {
    let calls = 0
    const { deps, send } = makeHarness({
      sendImpl: async () => {
        calls += 1
        if (calls < 2) throw new Error('timeout')
        return { ok: true, detail: 'accepted' }
      },
    })
    const first = await deliverOutbox('outbox-1', deps)
    expect(first.action).toBe('retry')
    const second = await deliverOutbox('outbox-1', deps)
    expect(second).toEqual({ action: 'sent' })
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('does not retry permanent (auth) errors', async () => {
    const { deps, patches, send } = makeHarness({
      sendImpl: async () => {
        throw Object.assign(new Error('Invalid login'), { responseCode: 535 })
      },
    })
    const result = await deliverOutbox('outbox-1', deps)
    expect(result).toEqual({ action: 'failed', reason: 'Invalid login' })
    expect(send).toHaveBeenCalledTimes(1)
    expect(patches[0]).toEqual(
      expect.objectContaining({ status: 'failed', attempts: 1, error: 'Invalid login' }),
    )
  })

  it('respects custom maxAttempts', async () => {
    const { deps, send } = makeHarness({
      sendImpl: async () => {
        throw new Error('flaky')
      },
    })
    deps.maxAttempts = 2
    const first = await deliverOutbox('outbox-1', deps)
    expect(first.action).toBe('retry')
    const second = await deliverOutbox('outbox-1', deps)
    expect(second.action).toBe('failed')
    expect(send).toHaveBeenCalledTimes(2)
  })
})

describe('defaultBackoffMs', () => {
  it('doubles per attempt and caps at an hour', () => {
    expect(defaultBackoffMs(1)).toBe(30_000)
    expect(defaultBackoffMs(2)).toBe(60_000)
    expect(defaultBackoffMs(3)).toBe(120_000)
    expect(defaultBackoffMs(10)).toBe(3_600_000)
  })
})
