import { existsSync } from 'node:fs'
import path from 'node:path'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pino from 'pino'
import { db } from './index'

const log = pino({ name: 'migrate' })

function migrationsFolder(): string | null {
  const cwd = process.cwd()
  const candidates = [
    process.env.MIGRATIONS_FOLDER,
    path.resolve(cwd, 'drizzle'),
    path.resolve(cwd, 'apps/api/drizzle'),
  ].filter((value): value is string => Boolean(value))
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

export async function runMigrations(): Promise<void> {
  const folder = migrationsFolder()
  if (!folder) {
    log.warn('migrations folder not found; skipping')
    return
  }
  await migrate(db, { migrationsFolder: folder })
  log.info({ folder }, 'migrations applied')
}
