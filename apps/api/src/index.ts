import pino from 'pino'
import { buildApp } from './app'
import { runMigrations } from './db/migrate'

const log = pino({ name: 'api' })

async function main() {
  await runMigrations()
  const app = await buildApp()

  const port = Number(process.env.PORT ?? 3000)
  const host = process.env.HOST ?? '0.0.0.0'

  await app.listen({ port, host })
  log.info({ port, host }, 'api listening')
}

main().catch((error) => {
  log.fatal({ err: error }, 'api failed to start')
  process.exit(1)
})
