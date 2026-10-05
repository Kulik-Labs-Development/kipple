import { randomUUID } from 'node:crypto'
import { and, desc, eq } from 'drizzle-orm'
import { ApiKeyCreate, generateApiKey } from '@kipple/shared'
import type { FastifyInstance } from 'fastify'
import { badRequest, notFound, requireRole } from '../access'
import { logAudit } from '../audit'
import { db } from '../db'
import { apiKeys } from '../db/schema'

// Superuser API key management (Phase 2, row 1).
//
// The full key value is returned exactly once — in the 201 create response.
// The database only ever sees the sha256 hash + a 12-char display prefix, and
// no list/other response or audit row carries the full key.

function keyView(row: typeof apiKeys.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    prefix: row.keyPrefix,
    scopes: row.scopes,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  }
}

export async function registerKeyRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/keys', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const parsed = ApiKeyCreate.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    const expiresAt = parsed.data.expiresAt ?? null
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'expiresAt must be in the future' })
    }
    const [existing] = await db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.userId, session.user.id), eq(apiKeys.name, parsed.data.name)))
    if (existing) {
      return reply
        .code(409)
        .send({ error: 'conflict', message: 'an api key with this name already exists' })
    }
    const generated = generateApiKey()
    let row: typeof apiKeys.$inferSelect
    try {
      [row] = await db
        .insert(apiKeys)
        .values({
          id: randomUUID(),
          name: parsed.data.name,
          keyHash: generated.keyHash,
          keyPrefix: generated.keyPrefix,
          scopes: parsed.data.scopes,
          userId: session.user.id,
          expiresAt,
        })
        .returning()
    } catch (error) {
      // drizzle wraps the postgres error in .cause (the house 409 pattern)
      const cause = (error as { cause?: { code?: string } })?.cause
      if (cause?.code === '23505') {
        return reply
          .code(409)
          .send({ error: 'conflict', message: 'an api key with this name already exists' })
      }
      throw error
    }
    await logAudit(session.user.id, 'api_key.create', 'api_key', row.id, {
      name: row.name,
      prefix: row.keyPrefix,
      scopes: row.scopes,
    })
    // The full key rides out exactly once, alongside the list-shape row.
    return reply.code(201).send({ ...keyView(row), key: generated.key })
  })

  app.get('/api/keys', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const rows = await db
      .select()
      .from(apiKeys)
      .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
    return rows.map(keyView)
  })

  app.delete('/api/keys/:id', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const { id } = request.params as { id: string }
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id))
    if (!row) return reply.code(404).send(notFound())
    if (row.revokedAt) {
      return reply
        .code(409)
        .send({ error: 'conflict', message: 'api key is already revoked' })
    }
    const [updated] = await db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.id, id))
      .returning()
    await logAudit(session.user.id, 'api_key.revoke', 'api_key', id, {
      name: row.name,
      prefix: row.keyPrefix,
    })
    return keyView(updated)
  })
}
