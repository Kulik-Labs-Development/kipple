import { Queue, Worker } from 'bullmq'
import { tickSla } from '@kipple/api/src/sla'

// SLA tick: one durable repeatable job per minute. The DB is the source of
// truth (ticket states); the job only drives transitions, so a missed tick
// self-heals on the next one.

export const SLA_QUEUE = 'sla'
export const SLA_TICK_SCHEDULE_ID = 'sla-tick'
const TICK_MS = 60_000

export function createSlaWorker(connection: { url: string }): Worker {
  return new Worker(
    SLA_QUEUE,
    async (job) => {
      if (job.name !== 'tick') return
      return { emitted: await tickSla() }
    },
    { connection },
  )
}

export async function scheduleSlaTick(connection: { url: string }): Promise<Queue> {
  const queue = new Queue(SLA_QUEUE, { connection })
  await queue.upsertJobScheduler(SLA_TICK_SCHEDULE_ID, { every: TICK_MS }, { name: 'tick' })
  return queue
}
