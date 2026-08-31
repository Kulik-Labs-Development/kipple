import { randomUUID } from 'node:crypto'
import { db, pool } from './src/db'
import { runMigrations } from './src/db/migrate'
import { slaPolicies } from './src/db/schema'

await runMigrations()
await db.delete(slaPolicies)
await db.insert(slaPolicies).values({ id: randomUUID(), name: 'Dup', targets: {} })
try {
  await db.insert(slaPolicies).values({ id: randomUUID(), name: 'Dup', targets: {} })
} catch (error) {
  const e = error as { message?: string; cause?: { message?: string; code?: string } }
  console.log('cause ctor:', error?.constructor?.name)
  console.log('cause.message:', e.cause?.message)
  console.log('cause.code:', e.cause?.code)
  console.log('full tail:', String(e.message).slice(-160))
}
await db.delete(slaPolicies)
await pool.end()
