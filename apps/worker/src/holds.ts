import { Queue, Worker } from 'bullmq'
import { tickHolds } from '@kipple/api/src/holds'

// Hold tick: one durable repeatable job per minute, mirroring the SLA tick.
// The DB is the source of truth (hold_since / hold_warned_at); the job only
// drives the pre-close warning + auto-close transitions, so a missed tick
// self-heals on the next one.

export const HOLD_QUEUE = 'hold'
export const HOLD_TICK_SCHEDULE_ID = 'hold-tick'
const TICK_MS = 60_000

export function createHoldWorker(connection: { url: string }): Worker {
  return new Worker(
    HOLD_QUEUE,
    async (job) => {
      if (job.name !== 'tick') return
      return await tickHolds()
    },
    { connection },
  )
}

export async function scheduleHoldTick(connection: { url: string }): Promise<Queue> {
  const queue = new Queue(HOLD_QUEUE, { connection })
  await queue.upsertJobScheduler(HOLD_TICK_SCHEDULE_ID, { every: TICK_MS }, { name: 'tick' })
  return queue
}
