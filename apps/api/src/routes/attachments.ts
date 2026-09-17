import { createReadStream } from 'node:fs'
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { clientScope, inScope, notFound, requireRole, requireUser } from '../access'
import { logAudit } from '../audit'
import { db } from '../db'
import { attachments, tickets, updates } from '../db/schema'
import { s3PresignGet } from '../s3'
import {
  attachmentFileSize,
  attachmentPath,
  cleanFilename,
  deleteAttachmentFile,
  storageBackend,
} from '../storage'

// content-disposition needs a quoted-printable-safe ascii fallback name; the
// UTF-8 original rides in the filename* parameter.
function asciiFilename(filename: string): string {
  return cleanFilename(filename).replace(/[^\x20-\x7e]/g, '_')
}

export async function registerAttachmentRoutes(app: FastifyInstance): Promise<void> {
  // Download. Session required; everyone is scope-checked against the
  // ticket's client (issue #31), and contact users may only fetch files
  // that belong to a PUBLIC update (internal-update and out-of-scope cases
  // both 404 — no existence leaks).
  app.get('/api/attachments/:id', async (request, reply) => {
    const session = await requireUser(request, reply)
    if (!session) return null
    const { id } = request.params as { id: string }
    const [row] = await db
      .select({
        id: attachments.id,
        filename: attachments.filename,
        mime: attachments.mime,
        storageKey: attachments.storageKey,
        kind: updates.kind,
        clientId: tickets.clientId,
      })
      .from(attachments)
      .innerJoin(updates, eq(attachments.updateId, updates.id))
      .innerJoin(tickets, eq(updates.ticketId, tickets.id))
      .where(eq(attachments.id, id))
    if (!row) return reply.code(404).send(notFound())
    const scope = await clientScope(session.user)
    if (!inScope(scope, row.clientId)) return reply.code(404).send(notFound())
    if (session.user.role === 'contact' && row.kind !== 'public') {
      return reply.code(404).send(notFound())
    }
    const size = await attachmentFileSize(row.storageKey)
    if (size === null) return reply.code(404).send(notFound())
    const filename = cleanFilename(row.filename)
    const disposition = `attachment; filename="${asciiFilename(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`
    if (storageBackend() === 's3') {
      // S3 backend: mint a short-lived presigned URL and let the browser pull
      // the bytes straight from the bucket (direct-to-S3 download — plan row
      // 18 part 2). Every scope check ran above, so the URL is only ever
      // issued for a file the caller may see; the response overrides keep the
      // DB mime + disposition on the direct response (the object itself is
      // stored without a trusted content-type).
      return reply.redirect(
        s3PresignGet(row.storageKey, {
          responseContentType: row.mime || 'application/octet-stream',
          responseContentDisposition: disposition,
        }),
        302,
      )
    }
    reply.header('content-type', row.mime || 'application/octet-stream')
    reply.header('content-length', String(size))
    reply.header('content-disposition', disposition)
    reply.header('x-content-type-options', 'nosniff')
    // reply.send() takes over the stream: fastify pipes it, owns backpressure,
    // aborts on client close, and handles stream errors (a file removed mid-
    // response races deletion and surfaces as a cut connection, not a leak).
    return reply.send(createReadStream(attachmentPath(row.storageKey)))
  })

  // Delete = staff only, scope-checked against the ticket's client
  // (issue #31); removes the row and the file, audit-logged.
  app.delete('/api/attachments/:id', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    const { id } = request.params as { id: string }
    const [row] = await db
      .select({
        id: attachments.id,
        filename: attachments.filename,
        storageKey: attachments.storageKey,
        updateId: updates.id,
        ticketId: tickets.id,
        clientId: tickets.clientId,
      })
      .from(attachments)
      .innerJoin(updates, eq(attachments.updateId, updates.id))
      .innerJoin(tickets, eq(updates.ticketId, tickets.id))
      .where(eq(attachments.id, id))
    if (!row) return reply.code(404).send(notFound())
    const scope = await clientScope(session.user)
    if (!inScope(scope, row.clientId)) return reply.code(404).send(notFound())
    await db.delete(attachments).where(eq(attachments.id, id))
    await deleteAttachmentFile(row.storageKey)
    await logAudit(session.user.id, 'attachment.delete', 'attachment', id, {
      ticketId: row.ticketId,
      updateId: row.updateId,
      filename: row.filename,
    })
    return reply.code(204).send()
  })
}
