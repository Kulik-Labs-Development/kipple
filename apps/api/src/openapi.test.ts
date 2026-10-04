import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { db } from './db'
import { runMigrations } from './db/migrate'
import { audit, clients, contactClients, contacts, settings, tickets, updates, users } from './db/schema'

type App = Awaited<ReturnType<typeof buildApp>>

describe('openapi.json (Phase 2 row 1)', () => {
  let app: App

  beforeAll(async () => {
    await runMigrations()
    await db.delete(updates)
    await db.delete(tickets)
    await db.delete(contactClients)
    await db.delete(contacts)
    await db.delete(clients)
    await db.delete(audit)
    await db.delete(users)
    await db.delete(settings)
    app = await buildApp()
  })

  afterAll(async () => {
    await app.close()
    await db.delete(updates)
    await db.delete(tickets)
    await db.delete(contactClients)
    await db.delete(contacts)
    await db.delete(clients)
    await db.delete(audit)
    await db.delete(users)
    await db.delete(settings)
  })

  it('serves a 3.1 document with the bearer scheme + core paths (no auth needed)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/openapi.json' })
    expect(res.statusCode).toBe(200)
    const spec = res.json() as Record<string, unknown>
    expect(spec.openapi).toBe('3.1.0')

    const components = spec.components as Record<string, unknown>
    const securitySchemes = components.securitySchemes as Record<string, Record<string, unknown>>
    expect(securitySchemes.bearerAuth.type).toBe('http')
    expect(securitySchemes.bearerAuth.scheme).toBe('bearer')

    const paths = spec.paths as Record<string, unknown>
    for (const path of [
      '/api/keys',
      '/api/keys/{id}',
      '/api/clients',
      '/api/clients/{id}',
      '/api/clients/{clientId}/contacts',
      '/api/contacts/{id}',
      '/api/tickets',
      '/api/tickets/{id}',
      '/api/tickets/{id}/updates',
    ]) {
      expect(paths, `missing path ${path}`).toHaveProperty(path)
    }
    // 3.1 validity: the generator's 3.0-style nullable flag must be normalized
    expect(res.payload.includes('"nullable"')).toBe(false)
  })

  it('schemas come from the shared Zod objects', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/openapi.json' })
    const spec = res.json() as {
      components: { schemas: Record<string, Record<string, unknown>> }
    }
    const ticketCreate = spec.components.schemas.TicketCreate
    expect(ticketCreate.required).toEqual(expect.arrayContaining(['clientId', 'subject']))
    const properties = ticketCreate.properties as Record<string, { enum?: unknown[] }>
    expect(properties.priority.enum).toEqual(['low', 'normal', 'high', 'urgent'])
    const apiKeyCreate = spec.components.schemas.ApiKeyCreate
    const scopes = apiKeyCreate.properties as Record<string, { items?: { enum?: unknown[] } }>
    expect(scopes.scopes.items?.enum).toEqual(
      expect.arrayContaining(['tickets:read', 'time:write']),
    )
    const apiKeyView = spec.components.schemas.ApiKeyView
    const viewProps = apiKeyView.properties as Record<string, Record<string, unknown>>
    // nullable dates in the 3.1 anyOf form
    expect(viewProps.revokedAt).toMatchObject({
      anyOf: [expect.anything(), { type: 'null' }],
    })
  })
})
