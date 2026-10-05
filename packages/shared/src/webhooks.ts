import { z } from 'zod'
import { RULE_EVENTS } from './schemas'

// --- Instance webhooks (Phase 2, arc #4) -----------------------------------

// Outbound delivery queue (BullMQ). The webhook_deliveries row is the source
// of truth (audit log); the queue is only the trigger — a Redis blip loses no
// delivery (mirrors the email-outbox pattern, §5b).
export const WEBHOOKS_DELIVER_QUEUE = 'webhooks-deliver'

export const WebhookJobPayload = z.object({ deliveryId: z.string().min(1) })
export type WebhookJobPayload = z.infer<typeof WebhookJobPayload>

// Outbound webhooks subscribe to the house ticket events — the same emission
// points the rules engine listens to.
export const WebhookEvent = z.enum(RULE_EVENTS)
export type WebhookEvent = z.infer<typeof WebhookEvent>

// Admin diagnostic, never a ticket event.
export const WEBHOOK_TEST_EVENT = 'webhook.test'

export const WebhookCreate = z.object({
  url: z.string().url().max(2000),
  events: z.array(WebhookEvent).min(1).max(RULE_EVENTS.length),
  enabled: z.boolean().optional().default(true),
})
export type WebhookCreate = z.infer<typeof WebhookCreate>

export const WebhookUpdate = z.object({
  url: z.string().url().max(2000).optional(),
  events: z.array(WebhookEvent).min(1).max(RULE_EVENTS.length).optional(),
  enabled: z.boolean().optional(),
})
export type WebhookUpdate = z.infer<typeof WebhookUpdate>

export const WebhookDeliveryStatus = z.enum(['queued', 'sent', 'failed'])
export type WebhookDeliveryStatus = z.infer<typeof WebhookDeliveryStatus>

// --- Inbound NMS alerts -> tickets ------------------------------------------
//
// Seven supported alert sources. The per-source secret rides the URL path
// (POST /api/webhooks/inbound/{source}/{secret}). That is a deliberate,
// documented ceiling: the secret appears in the request line and can therefore
// show up in vendor/proxy access logs (owner's call — docs/DEPLOYMENT.md).
// There is no body HMAC, no timestamp header, and no replay window.
export const NMS_SOURCES = [
  'prtg',
  'zabbix',
  'watcher',
  'uptimerobot',
  'kuma',
  'onlineornot',
  'custom',
] as const
export type NmsSource = (typeof NMS_SOURCES)[number]

// Per-source inbound config (settings key 'webhooks_inbound'). secret is
// stored as enc1: ciphertext at rest; '' = not generated yet.
export const InboundSourceConfig = z.object({
  enabled: z.boolean().default(false),
  secret: z.string().max(1024).default(''),
})
export type InboundSourceConfig = z.infer<typeof InboundSourceConfig>

export const InboundWebhooksSettings = z.object({
  // The client inbound alerts create tickets for. null = not configured;
  // while null, inbound alerts are rejected with 409.
  defaultClientId: z.string().min(1).nullable().optional().default(null),
  prtg: InboundSourceConfig.optional(),
  zabbix: InboundSourceConfig.optional(),
  watcher: InboundSourceConfig.optional(),
  uptimerobot: InboundSourceConfig.optional(),
  kuma: InboundSourceConfig.optional(),
  onlineornot: InboundSourceConfig.optional(),
  custom: InboundSourceConfig.optional(),
})
export type InboundWebhooksSettings = z.infer<typeof InboundWebhooksSettings>

export const InboundSettingsPatch = z.object({
  defaultClientId: z.string().min(1).nullable().optional(),
})
export type InboundSettingsPatch = z.infer<typeof InboundSettingsPatch>

export const InboundSourcePatch = z.object({
  enabled: z.boolean(),
})
export type InboundSourcePatch = z.infer<typeof InboundSourcePatch>

// Normalized alert: every vendor parser converges to this shape.
export type NmsAlertState = 'down' | 'up'

export interface NormalizedNmsAlert {
  source: NmsSource
  // Stable vendor identity for the monitored object (sensor id, monitor id,
  // host+trigger, ...). With the source it forms the dedupe signature.
  targetId: string
  name: string
  // 'down' = alerting, 'up' = recovery
  state: NmsAlertState
  // Maps to the ticket priority when a ticket is created (default 'normal')
  severity?: 'low' | 'normal' | 'high' | 'urgent'
  message?: string
  url?: string
}
