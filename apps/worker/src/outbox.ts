import { Worker, type WorkerOptions } from 'bullmq'
import pino from 'pino'
import { processOutboxJob } from '@kipple/api/src/mail'
import { EMAIL_OUTBOX_QUEUE, OutboxJobPayload } from '@kipple/shared'

const log = pino({ name: 'worker:outbox' })

export function createOutboxWorker(connection: WorkerOptions['connection']): Worker {
  return new Worker(
    EMAIL_OUTBOX_QUEUE,
    async (job) => {
      const parsed = OutboxJobPayload.safeParse(job.data)
      if (!parsed.success) throw new Error('invalid outbox job payload')
      const result = await processOutboxJob(parsed.data.outboxId)
      log.info({ jobId: job.id, ...result }, 'outbox job processed')
    },
    { connection, concurrency: 2 },
  )
}
