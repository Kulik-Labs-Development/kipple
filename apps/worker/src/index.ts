import { Worker } from 'bullmq'
import pino from 'pino'
import { createOutboxWorker } from './outbox'
import { runIngestLoop } from './ingest'
import { createSlaWorker, scheduleSlaTick } from './sla'

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
const sla = createSlaWorker(connection)

ingest.on('failed', (job, error) => {
  log.error({ jobId: job?.id, err: error.message }, 'ingest job failed')
})
outbox.on('failed', (job, error) => {
  log.error({ jobId: job?.id, err: error.message }, 'outbox job failed')
})
sla.on('failed', (job, error) => {
  log.error({ jobId: job?.id, err: error.message }, 'sla tick failed')
})

void runIngestLoop()
void scheduleSlaTick(connection).catch((error) => {
  log.error({ err: error }, 'failed to schedule sla tick (redis down?)')
})

log.info({ redisUrl }, 'worker ready: email-ingest (IMAP IDLE) + email-outbox + sla tick')
