import pino from 'pino'
import { processInboundMessage } from '@kipple/api/src/ingest'
import { loadImapSettings } from '@kipple/api/src/mail'
import { createImapClient, parseEmail } from '@kipple/mail'
import type { ImapSettings } from '@kipple/shared'

const log = pino({ name: 'worker:ingest' })

const INITIAL_SCAN_LIMIT = 100
const NOT_CONFIGURED_POLL_MS = 30_000
const INITIAL_BACKOFF_MS = 5_000
const MAX_BACKOFF_MS = 300_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function runIngestLoop(): Promise<void> {
  let backoff = INITIAL_BACKOFF_MS
  for (;;) {
    let settings: ImapSettings | null = null
    try {
      settings = await loadImapSettings()
    } catch (error) {
      log.warn({ err: error instanceof Error ? error.message : error }, 'failed to load imap settings')
    }
    if (!settings) {
      await sleep(NOT_CONFIGURED_POLL_MS)
      continue
    }
    try {
      await connectAndIdle(settings)
      backoff = INITIAL_BACKOFF_MS
    } catch (error) {
      log.error({ err: error instanceof Error ? error.message : error }, 'ingest connection failed')
      await sleep(backoff)
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
    }
  }
}

async function connectAndIdle(settings: ImapSettings): Promise<void> {
  const client = createImapClient(settings)
  await client.connect()
  const mailbox = await client.mailboxOpen(settings.mailbox, { readOnly: true })
  log.info({ mailbox: mailbox.path, messages: mailbox.exists }, 'ingest mailbox open')

  const processSource = async (seq: number): Promise<void> => {
    try {
      const fetched = await client.fetchAll(seq, { source: true })
      const source = fetched.find((message) => message.source)?.source
      if (!source) return
      const email = await parseEmail(source)
      const result = await processInboundMessage(email)
      log.info({ seq, ...result }, 'inbound message handled')
    } catch (error) {
      log.error({ seq, err: error instanceof Error ? error.message : error }, 'inbound message failed')
    }
  }

  // Catch up on anything unread since the last run; the Message-ID dedupe
  // makes rescanning safe, and we leave mail unseen (readOnly) so a missed
  // scan is picked up next time.
  const unread = await client.search({ seen: false })
  if (unread) {
    log.info({ count: unread.length }, 'catch-up scan')
    for (const seq of unread.slice(-INITIAL_SCAN_LIMIT)) await processSource(seq)
  }

  // Live: EXISTS updates carry the previous count, so new messages are
  // prevCount+1..count. IMAPFlow re-issues IDLE automatically.
  client.on('exists', (data) => {
    for (let seq = data.prevCount + 1; seq <= data.count; seq++) {
      void processSource(seq)
    }
  })
  client.on('error', (error) => log.error({ err: error.message }, 'ingest client error'))

  await client.idle()
  await new Promise<void>((resolve) => client.once('close', () => resolve()))
  log.warn('ingest connection closed; reconnecting')
}
