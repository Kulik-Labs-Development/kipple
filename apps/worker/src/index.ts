import { Worker } from 'bullmq'
import pino from 'pino'

const log = pino({ name: 'worker' })

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379'

const worker = new Worker(
  'email-ingest',
  async (job) => {
    log.info({ jobId: job.id }, 'job processed (scaffold placeholder)')
  },
  { connection: { url: redisUrl } },
)

worker.on('failed', (job, error) => {
  log.error({ jobId: job?.id, err: error.message }, 'job failed')
})

log.info({ queue: 'email-ingest', redisUrl }, 'worker ready')
