import { randomUUID } from 'node:crypto'
import { db } from './db'
import { audit } from './db/schema'

export async function logAudit(
  actorId: string | null,
  action: string,
  entityType?: string,
  entityId?: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  await db.insert(audit).values({
    id: randomUUID(),
    actorId,
    action,
    entityType: entityType ?? null,
    entityId: entityId ?? null,
    meta: meta ?? null,
  })
}
