import { asc, ne } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { requireRole } from '../access'
import { db } from '../db'
import { users } from '../db/schema'

export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/users', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    return db
      .select({
        id: users.id,
        name: users.name,
        email: users.email,
        role: users.role,
        presence: users.presence,
        image: users.image,
      })
      .from(users)
      .where(ne(users.role, 'contact'))
      .orderBy(asc(users.name))
  })
}
