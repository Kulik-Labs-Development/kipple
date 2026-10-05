import { describe, expect, it } from 'vitest'
import { RULE_EVENTS } from './schemas'
import {
  InboundSourceConfig,
  InboundWebhooksSettings,
  NMS_SOURCES,
  WebhookCreate,
  WebhookUpdate,
  WEBHOOK_TEST_EVENT,
} from './webhooks'

describe('webhook schemas', () => {
  it('accepts a valid webhook create with house events', () => {
    const parsed = WebhookCreate.parse({
      url: 'https://hooks.example.com/kipple',
      events: ['ticket.created', 'ticket.status_changed'],
    })
    expect(parsed.url).toBe('https://hooks.example.com/kipple')
    expect(parsed.events).toEqual(['ticket.created', 'ticket.status_changed'])
    expect(parsed.enabled).toBe(true)
  })

  it('rejects a webhook create without events or with an unknown event', () => {
    expect(WebhookCreate.safeParse({ url: 'https://x.example.com', events: [] }).success).toBe(false)
    expect(
      WebhookCreate.safeParse({ url: 'https://x.example.com', events: ['ticket.exploded'] }).success,
    ).toBe(false)
  })

  it('rejects a non-url target', () => {
    expect(WebhookCreate.safeParse({ url: 'not a url', events: ['ticket.created'] }).success).toBe(false)
  })

  it('lets webhook update patch any subset of fields', () => {
    expect(WebhookUpdate.parse({}).events).toBeUndefined()
    const parsed = WebhookUpdate.parse({ enabled: false })
    expect(parsed.enabled).toBe(false)
    expect(
      WebhookUpdate.safeParse({ url: 'https://x.example.com', events: [] }).success,
    ).toBe(false)
  })

  it('exposes the seven NMS sources', () => {
    expect(NMS_SOURCES).toEqual([
      'prtg',
      'zabbix',
      'watcher',
      'uptimerobot',
      'kuma',
      'onlineornot',
      'custom',
    ])
  })

  it('parses inbound settings with defaults (all sources off, no client)', () => {
    const settings = InboundWebhooksSettings.parse({})
    expect(settings.defaultClientId).toBeNull()
    expect(settings.prtg).toBeUndefined()
  })

  it('defaults a source config to disabled with no secret', () => {
    const config = InboundSourceConfig.parse({})
    expect(config.enabled).toBe(false)
    expect(config.secret).toBe('')
  })

  it('keeps the test-ping event out of the house event list', () => {
    expect(RULE_EVENTS).not.toContain(WEBHOOK_TEST_EVENT)
  })
})
