import { ImapFlow, type ImapFlow as ImapFlowClient } from 'imapflow'
import type { ImapSettings } from '@kipple/shared'
import type { ProviderStatus } from './providers/types'

function toConnectOptions(settings: ImapSettings) {
  return {
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    logger: false as const,
    auth: settings.auth?.username
      ? { user: settings.auth.username, pass: settings.auth.password || undefined }
      : undefined,
  }
}

export function createImapClient(settings: ImapSettings): ImapFlowClient {
  return new ImapFlow(toConnectOptions(settings))
}

export async function testImapConnection(settings: ImapSettings): Promise<ProviderStatus> {
  const client = createImapClient(settings)
  try {
    await client.connect()
    const mailbox = await client.mailboxOpen(settings.mailbox, { readOnly: true })
    return {
      ok: true,
      detail: `connected to ${settings.host}:${settings.port}, mailbox ${mailbox.path} (${mailbox.exists} messages)`,
    }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  } finally {
    await client.logout().catch(() => {})
  }
}
