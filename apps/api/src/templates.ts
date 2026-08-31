import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import { db } from './db'
import { clients, contactClients, contacts, emailTemplates, settings } from './db/schema'

// {{dotted.path}} placeholder rendering. Unknown paths render as an empty
// string so a missing optional variable never leaks a literal placeholder.
export function renderTemplate(text: string, vars: Record<string, unknown>): string {
  return text.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_.]*)\s*\}\}/g, (_all, path: string) => {
    let current: unknown = vars
    for (const part of path.split('.')) {
      if (current !== null && typeof current === 'object' && part in (current as Record<string, unknown>)) {
        current = (current as Record<string, unknown>)[part]
      } else {
        return ''
      }
    }
    if (current === null || current === undefined) return ''
    return typeof current === 'string' ? current : String(current)
  })
}

export interface TemplateRow {
  id: string
  key: string
  name: string
  subject: string
  body: string
  enabled: boolean
}

function rowView(row: typeof emailTemplates.$inferSelect): TemplateRow {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    subject: row.subject,
    body: row.body,
    enabled: row.enabled,
  }
}

export async function listTemplates(): Promise<TemplateRow[]> {
  const rows = await db.select().from(emailTemplates)
  return rows.map(rowView)
}

export async function getTemplate(key: string): Promise<TemplateRow | null> {
  const [row] = await db.select().from(emailTemplates).where(eq(emailTemplates.key, key))
  return row ? rowView(row) : null
}

export async function getEnabledTemplate(key: string): Promise<TemplateRow | null> {
  const template = await getTemplate(key)
  return template?.enabled ? template : null
}

// The context every template renders against (PLAN item 11).
export interface TemplateContext {
  ticket: {
    id: string
    number: number
    subject: string
    status: string
    priority: string
    alias: string | null
    createdAt: Date
  }
  // the staff author of the triggering event, when there is one
  agentName?: string
  // the staff message that triggered the event, when there is one
  body?: string
  clientId: string
}

export async function buildTemplateVars(context: TemplateContext) {
  const [instanceRow] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, 'instance'))
  const instanceName = ((instanceRow?.value as { name?: string } | null) ?? {}).name ?? 'Kipple'
  let clientName = 'unknown client'
  const [client] = await db
    .select({ name: clients.name })
    .from(clients)
    .where(eq(clients.id, context.clientId))
  if (client) clientName = client.name
  const links = await db
    .select({ contactId: contactClients.contactId, isPrimary: contactClients.isPrimary })
    .from(contactClients)
    .where(and(eq(contactClients.clientId, context.clientId)))
  const ordered = [...links].sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary))
  let contactName = ''
  for (const link of ordered) {
    const [contact] = await db
      .select({ name: contacts.name })
      .from(contacts)
      .where(eq(contacts.id, link.contactId))
    if (contact?.name) {
      contactName = contact.name
      break
    }
  }
  return {
    ticket: {
      id: context.ticket.id,
      number: context.ticket.number,
      subject: context.ticket.subject,
      status: context.ticket.status,
      priority: context.ticket.priority,
      alias: context.ticket.alias ?? '',
      url: `${process.env.PUBLIC_URL ?? 'http://localhost:3000'}/portal`,
    },
    client: { name: clientName },
    contact: { name: contactName },
    agent: { name: context.agentName ?? 'Support' },
    instance: { name: instanceName },
    body: context.body ?? '',
  }
}

// Seeded once at first-run setup, all disabled: nothing auto-sends until the
// admin edits + enables a template and a rule references it.
const DEFAULT_TEMPLATES: Array<Pick<TemplateRow, 'key' | 'name' | 'subject' | 'body'>> = [
  {
    key: 'ticket_new',
    name: 'New ticket notice',
    subject: 'Your new ticket #{{ticket.number}}: {{ticket.subject}}',
    body:
      'Hi {{client.name}},\n\nWe have received your ticket.\n\n' +
      '  Ticket #{{ticket.number}}: {{ticket.subject}}\n' +
      '  Status: {{ticket.status}}\n  Priority: {{ticket.priority}}\n\n' +
      '{{body}}\n\n— {{instance.name}}',
  },
  {
    key: 'ticket_reply',
    name: 'Reply from us',
    subject: '[KIP-{{ticket.number}}] {{ticket.subject}}',
    body: 'Hi {{client.name}},\n\n{{body}}\n\n— {{agent.name}}, {{instance.name}}',
  },
  {
    key: 'ticket_close',
    name: 'Ticket closed notice',
    subject: 'Ticket #{{ticket.number}} closed: {{ticket.subject}}',
    body:
      'Hi {{client.name}},\n\nYour ticket has been closed.\n\n' +
      '  Ticket #{{ticket.number}}: {{ticket.subject}}\n\n' +
      '{{body}}\n\n— {{instance.name}}',
  },
  {
    key: 'csat',
    name: 'Satisfaction survey',
    subject: 'How did we do? (ticket #{{ticket.number}})',
    body:
      'Hi {{client.name}},\n\n' +
      'We closed your ticket #{{ticket.number}} ({{ticket.subject}}).\n\n' +
      'How did we do? Reply with a rating:\n' +
      '  1 = great · 2 = okay · 3 = poor\n\n— {{instance.name}}',
  },
]

export async function seedDefaultTemplates(): Promise<void> {
  for (const template of DEFAULT_TEMPLATES) {
    await db
      .insert(emailTemplates)
      .values({ id: randomUUID(), ...template, enabled: false })
      .onConflictDoNothing({ target: emailTemplates.key })
  }
}
