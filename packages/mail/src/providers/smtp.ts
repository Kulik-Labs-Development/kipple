import type { SmtpEmailConfig } from '@kipple/shared'
import nodemailer from 'nodemailer'
import type { MailProvider, OutboundMessage, ProviderStatus } from './types'

export class SmtpProvider implements MailProvider {
  name = 'smtp'

  private readonly transport: nodemailer.Transporter

  constructor(private readonly config: SmtpEmailConfig) {
    this.transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      requireTLS: !config.secure && config.startTls,
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
      // false is not part of the typed options; omit the key instead
      ...(config.auth?.username
        ? { auth: { user: config.auth.username, pass: config.auth.password ?? '' } }
        : {}),
    })
  }

  async send(message: OutboundMessage): Promise<ProviderStatus> {
    const info = await this.transport.sendMail({
      from: message.fromName ? `"${message.fromName}" <${message.from}>` : message.from,
      to: message.to,
      replyTo: message.replyTo,
      inReplyTo: message.inReplyTo,
      messageId: message.messageId,
      subject: message.subject,
      text: message.body,
    })
    return { ok: true, detail: `accepted: ${info.messageId}` }
  }

  async testConnection(): Promise<ProviderStatus> {
    try {
      await this.transport.verify()
      return { ok: true, detail: `connected to ${this.config.host}:${this.config.port}` }
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) }
    }
  }

  status(): ProviderStatus {
    return {
      ok: true,
      detail: `smtp ${this.config.host}:${this.config.port}${
        this.config.secure ? ' (tls)' : this.config.startTls ? ' (starttls)' : ' (plain)'
      }${this.config.auth?.username ? `, auth ${this.config.auth.username}` : ', no auth'}`,
    }
  }
}

export function createSmtpProvider(config: SmtpEmailConfig): MailProvider {
  return new SmtpProvider(config)
}
