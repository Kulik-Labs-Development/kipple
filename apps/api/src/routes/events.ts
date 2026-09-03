import type { FastifyInstance } from 'fastify'
import { requireUser } from '../access'
import { sseReply } from '../events'

// SSE event channel (issue #96): the presence fan-out rides this connection.
// Contacts may connect (the payload is presence only), but only staff render
// it; the web only opens the stream in the workspace.
export async function registerEventRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/events', async (request, reply) => {
    const session = await requireUser(request, reply)
    if (!session) return
    await sseReply(reply)
  })
}
