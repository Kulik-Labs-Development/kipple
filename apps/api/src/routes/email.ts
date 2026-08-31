import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { testImapConnection } from '@kipple/mail'
import {
  EmailSettings,
  EmailTemplateCreate,
  EmailTemplateUpdate,
  ImapSettings,
  OutboxTestSend,
} from '@kipple/shared'
import { badRequest, notFound, requireRole } from '../access'
import { logAudit } from '../audit'
import {
  describeEmailSettings,
  describeImapSettings,
  enqueueOutbox,
  listOutbox,
  loadEmailSettings,
  loadImapSettings,
  providerFromSettings,
  retryOutbox,
  saveEmailSettings,
  saveImapSettings,
} from '../mail'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { emailTemplates, settings, tickets } from '../db/schema'
import {
  buildTemplateVars,
  getTemplate,
  listTemplates,
  renderTemplate,
} from '../templates'

export async function registerEmailRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/email', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    return describeEmailSettings(await loadEmailSettings())
  })

  app.post('/api/email', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const parsed = EmailSettings.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    await saveEmailSettings(parsed.data, session.user.id)
    return describeEmailSettings(parsed.data)
  })

  app.post('/api/email/test-connection', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const parsed = EmailSettings.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    if (!parsed.data.smtp) {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'no smtp configuration to test' })
    }
    const provider = providerFromSettings(parsed.data)
    const result = await provider.testConnection()
    await logAudit(session.user.id, 'email.test_connection', 'setting', 'email', {
      ok: result.ok,
    })
    return result
  })

  app.get('/api/imap', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    return describeImapSettings(await loadImapSettings())
  })

  app.post('/api/imap', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const parsed = ImapSettings.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    await saveImapSettings(parsed.data, session.user.id)
    return describeImapSettings(parsed.data)
  })

  app.post('/api/imap/test-connection', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const parsed = ImapSettings.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    const result = await testImapConnection(parsed.data)
    await logAudit(session.user.id, 'imap.test_connection', 'setting', 'imap', {
      ok: result.ok,
    })
    return result
  })

  app.get('/api/outbox', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    const query = request.query as Record<string, string | undefined>
    const limit = Math.min(Number(query.limit) || 100, 500)
    return listOutbox({ status: query.status, provider: query.provider, limit })
  })

  app.get('/api/outbox/provider', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    const settingsValue = await loadEmailSettings()
    if (!settingsValue?.smtp) {
      return { configured: false, status: { ok: false, detail: 'email not configured' } }
    }
    return { configured: true, status: providerFromSettings(settingsValue).status() }
  })

  app.post('/api/outbox/test', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    const parsed = OutboxTestSend.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    const settingsValue = await loadEmailSettings()
    if (!settingsValue?.smtp) {
      return reply
        .code(400)
        .send({ error: 'bad_request', message: 'email not configured' })
    }
    const [instance] = await db
      .select({ value: settings.value })
      .from(settings)
      .where(eq(settings.key, 'instance'))
    const instanceName = (instance?.value as { name?: string } | null)?.name ?? 'Kipple'
    const id = await enqueueOutbox({
      to: parsed.data.to,
      from: settingsValue.smtp.from,
      fromName: settingsValue.smtp.fromName || null,
      subject: `[${instanceName}] Test email`,
      body: `This is a test send from ${instanceName}.\n\nIf you can read this, outbound email is working.`,
      messageId: `<${randomUUID()}@${settingsValue.domain}>`,
    })
    await logAudit(session.user.id, 'outbox.test_send', 'outbox', id, { to: parsed.data.to })
    return reply.code(202).send({ id, status: 'queued' })
  })

  app.post('/api/outbox/:id/retry', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    const { id } = request.params as { id: string }
    const row = await retryOutbox(id)
    if (!row) return reply.code(404).send(notFound())
    await logAudit(session.user.id, 'outbox.retry', 'outbox', id)
    return row
  })

  // ---------------------------------------------------------------- templates

  app.get('/api/email/templates', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    return listTemplates()
  })

  app.post('/api/email/templates', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const parsed = EmailTemplateCreate.safeParse(request.body)
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    const { key, ...rest } = parsed.data
    try {
      const [row] = await db
        .insert(emailTemplates)
        .values({ id: randomUUID(), key, ...rest })
        .returning()
      await logAudit(session.user.id, 'template.create', 'email_template', row.id, { key })
      return reply.code(201).send(row)
    } catch (error) {
      const cause = (error as { cause?: { code?: string } })?.cause
      if (cause?.code === '23505') {
        return reply
          .code(409)
          .send({ error: 'conflict', message: `a template with key "${key}" already exists` })
      }
      throw error
    }
  })

  app.patch('/api/email/templates/:key', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const { key } = request.params as { key: string }
    const parsed = EmailTemplateUpdate.safeParse(request.body ?? {})
    if (!parsed.success) return reply.code(400).send(badRequest(parsed.error))
    const [row] = await db
      .update(emailTemplates)
      .set(parsed.data)
      .where(eq(emailTemplates.key, key))
      .returning()
    if (!row) return reply.code(404).send(notFound())
    await logAudit(session.user.id, 'template.update', 'email_template', row.id, {
      key,
      fields: Object.keys(parsed.data),
    })
    return row
  })

  app.delete('/api/email/templates/:key', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser'])
    if (!session) return null
    const { key } = request.params as { key: string }
    const [row] = await db
      .delete(emailTemplates)
      .where(eq(emailTemplates.key, key))
      .returning()
    if (!row) return reply.code(404).send(notFound())
    await logAudit(session.user.id, 'template.delete', 'email_template', row.id, { key })
    return reply.code(204).send()
  })

  // Render a template against a real ticket so the editor can show exactly
  // what would be sent (PLAN item 11: "test rule" preview).
  app.post('/api/email/templates/preview', async (request, reply) => {
    const session = await requireRole(request, reply, ['superuser', 'admin', 'agent'])
    if (!session) return null
    const body = request.body as { key?: string; ticketId?: string } | null
    const template = body?.key ? await getTemplate(body.key) : null
    if (!template) return reply.code(404).send(notFound())
    const [ticket] = body?.ticketId
      ? await db.select().from(tickets).where(eq(tickets.id, body.ticketId))
      : []
    if (body?.ticketId && !ticket) return reply.code(404).send(notFound())
    if (!ticket) {
      // no ticket: render with placeholders left empty
      return {
        subject: renderTemplate(template.subject, {}),
        body: renderTemplate(template.body, {}),
      }
    }
    const vars = await buildTemplateVars({
      ticket: {
        id: ticket.id,
        number: ticket.number,
        subject: ticket.subject,
        status: ticket.status,
        priority: ticket.priority,
        alias: ticket.alias,
        createdAt: ticket.createdAt,
      },
      agentName: session.user.name,
      clientId: ticket.clientId,
    })
    return {
      subject: renderTemplate(template.subject, vars),
      body: renderTemplate(template.body, vars),
    }
  })
}
