export interface OutboundMessage {
  to: string
  from: string
  fromName?: string
  subject: string
  body: string
  replyTo?: string
  inReplyTo?: string
  messageId?: string
}

export interface ProviderStatus {
  ok: boolean
  detail: string
}

export interface MailProvider {
  name: string
  send(message: OutboundMessage): Promise<ProviderStatus>
  testConnection(): Promise<ProviderStatus>
  status(): ProviderStatus
}
