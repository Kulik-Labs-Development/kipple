import { Worker, type WorkerOptions } from 'bullmq'
import pino from 'pino'
import { processWebhookDelivery } from '@kipple/api/src/webhooks'
import { WEBHOOKS_DELIVER_QUEUE, WebhookJobPayload } from '@kipple/shared'

const log = pino({ name: 'worker:webhooks' })

export function createWebhookWorker(connection: WorkerOptions['connection']): Worker {
  return new Worker(
    WEBHOOKS_DELIVER_QUEUE,
    async (job) => {
      const parsed = WebhookJobPayload.safeParse(job.data)
      if (!parsed.success) throw new Error('invalid webhook job payload')
      const result = await processWebhookDelivery(parsed.data.deliveryId)
      log.info({ jobId: job.id, ...result }, 'webhook delivery processed')
    },
    { connection, concurrency: 2 },
  )
}
