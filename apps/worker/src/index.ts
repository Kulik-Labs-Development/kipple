import { Worker } from 'bullmq'
import pino from 'pino'
import { createOutboxWorker } from './outbox'
import { runIngestLoop } from './ingest'

const log = pino({ name: 'worker' })

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379'
const connection = { url: redisUrl }

const ingest = new Worker(
  'email-ingest',
  async (job) => {
    log.info({ jobId: job.id }, 'job processed (scaffold placeholder)')
  },
  { connection },
)

const outbox = createOutboxWorker(connection)

ingest.on('failed', (job, error) => {
  log.error({ jobId: job?.id, err: error.message }, 'ingest job failed')
})
outbox.on('failed', (job, error) => {
  log.error({ jobId: job?.id, err: error.message }, 'outbox job failed')
})

void runIngestLoop()

log.info({ redisUrl }, 'worker ready: email-ingest (IMAP IDLE) + email-outbox')
