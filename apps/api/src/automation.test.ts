import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { hashPassword } from 'better-auth/crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { db } from './db'
import { runMigrations } from './db/migrate'
import {
  accounts,
  clients,
  contactClients,
  contacts,
  emailOutbox,
  emailTemplates,
  notifications,
  ruleRuns,
  rules,
  settings,
  slaPolicies,
  tickets,
  updates,
  users,
  verifications,
} from './db/schema'
import { tickSla } from './sla'

type App = Awaited<ReturnType<typeof buildApp>>

const owner = {
  instanceName: 'Kulik Labs IT',
  ownerName: 'Max Kulik',
  ownerEmail: 'max@kuliklabs.dev',
  password: 'correct-horse-battery',
}

function cookiesFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie']
  const list = Array.isArray(raw) ? raw : [raw]
  return list
    .filter(Boolean)
    .map((cookie) => String(cookie).split(';')[0])
    .join('; ')
}

async function wipe() {
  await db.delete(verifications)
  await db.delete(notifications)
  await db.delete(ruleRuns)
  await db.delete(rules)
  await db.delete(emailTemplates)
  await db.delete(emailOutbox)
  await db.delete(updates)
  await db.delete(tickets)
  await db.delete(slaPolicies)
  await db.delete(contactClients)
  await db.delete(contacts)
  await db.delete(clients)
  await db.delete(users)
  await db.delete(settings)
}

const DEFAULTS = ['ticket_new', 'ticket_reply', 'ticket_close', 'csat']

describe('email templates + rules + notifications (plan item 11)', () => {
  let app: App
  let superCookie: string
  let agentCookie: string
  let contactCookie: string
  let agentId: string
  let clientA: string
  let ticketId: string

  beforeAll(async () => {
    await runMigrations()
    await wipe()
    app = await buildApp()

    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: owner })
    expect(setup.statusCode).toBe(200)
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: owner.ownerEmail, password: owner.password },
    })
    superCookie = cookiesFrom(login)

    agentId = randomUUID()
    await db.insert(users).values({
      id: agentId,
      name: 'Agent One',
      email: 'agent@kuliklabs.dev',
      role: 'agent',
    })
    await db.insert(accounts).values({
      id: randomUUID(),
      providerId: 'credential',
      issuer: 'local:credential',
      accountId: agentId,
      userId: agentId,
      password: await hashPassword('agent-pass-12345'),
    })
    const agentLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'agent@kuliklabs.dev', password: 'agent-pass-12345' },
    })
    agentCookie = cookiesFrom(agentLogin)

    const resA = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie: superCookie },
      payload: { name: 'Acme Corp', domain: 'acme.test' },
    })
    clientA = resA.json().id
    const contactRes = await app.inject({
      method: 'POST',
      url: `/api/clients/${clientA}/contacts`,
      headers: { cookie: superCookie },
      payload: { name: 'Ada Client', email: 'ada@acme.test' },
    })
    const contactId = contactRes.json().id
    const contactUserId = randomUUID()
    await db.insert(users).values({
      id: contactUserId,
      name: 'Ada Client',
      email: 'ada@acme.test',
      role: 'contact',
      contactId: contactId,
    })
    await db.insert(accounts).values({
      id: randomUUID(),
      providerId: 'credential',
      issuer: 'local:credential',
      accountId: contactUserId,
      userId: contactUserId,
      password: await hashPassword('ada-contact-pass'),
    })
    const contactLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/email',
      payload: { email: 'ada@acme.test', password: 'ada-contact-pass' },
    })
    contactCookie = cookiesFrom(contactLogin)

    // SMTP config so the send_template action proceeds to enqueue (no real
    // delivery is exercised — the worker is not registered in tests).
    await app.inject({
      method: 'POST',
      url: '/api/email',
      headers: { cookie: superCookie },
      payload: {
        domain: 'kuliklabs.dev',
        provider: 'smtp',
        smtp: {
          host: '127.0.0.1',
          port: 2525,
          secure: false,
          startTls: false,
          from: 'support@kuliklabs.dev',
          fromName: 'Kulik Labs Support',
          auth: { username: 'relay', password: 'hunter2' },
        },
      },
    })

    const t = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: superCookie },
      payload: { clientId: clientA, subject: 'template + rules fixture' },
    })
    ticketId = t.json().id
  })

  afterAll(async () => {
    await app.close()
    await wipe()
  })

  it('seeds four disabled default templates at setup', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/email/templates',
      headers: { cookie: agentCookie },
    })
    expect(res.statusCode).toBe(200)
    const templates = res.json()
    expect(templates.map((t: { key: string }) => t.key).sort()).toEqual([...DEFAULTS].sort())
    for (const template of templates) expect(template.enabled).toBe(false)
  })

  it('template CRUD is superuser-only; preview renders a real ticket', async () => {
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/email/templates',
      headers: { cookie: agentCookie },
      payload: { key: 'custom', name: 'Custom' },
    })
    expect(forbidden.statusCode).toBe(403)

    const created = await app.inject({
      method: 'POST',
      url: '/api/email/templates',
      headers: { cookie: superCookie },
      payload: {
        key: 'custom',
        name: 'Custom',
        subject: 'Hi {{contact.name}} — {{ticket.number}}',
        body: 'Status: {{ticket.status}} · client {{client.name}} · {{instance.name}} · {{missing.var}}',
      },
    })
    expect(created.statusCode).toBe(201)
    const dup = await app.inject({
      method: 'POST',
      url: '/api/email/templates',
      headers: { cookie: superCookie },
      payload: { key: 'custom', name: 'Custom' },
    })
    expect(dup.statusCode).toBe(409)

    const preview = await app.inject({
      method: 'POST',
      url: '/api/email/templates/preview',
      headers: { cookie: agentCookie },
      payload: { key: 'custom', ticketId },
    })
    expect(preview.statusCode).toBe(200)
    const body = preview.json()
    expect(body.subject).toContain('Ada Client')
    expect(body.subject).toMatch(/— \d+/)
    expect(body.body).toContain('Status: open')
    expect(body.body).toContain('client Acme Corp')
    expect(body.body).toContain('Kulik Labs IT')
    expect(body.body).not.toContain('{{missing.var}}')

    const patched = await app.inject({
      method: 'PATCH',
      url: '/api/email/templates/custom',
      headers: { cookie: superCookie },
      payload: { enabled: true },
    })
    expect(patched.statusCode).toBe(200)
    expect(patched.json().enabled).toBe(true)
    const deleted = await app.inject({
      method: 'DELETE',
      url: '/api/email/templates/custom',
      headers: { cookie: superCookie },
    })
    expect(deleted.statusCode).toBe(204)
  })

  it('rule CRUD is superuser-only', async () => {
    const forbidden = await app.inject({
      method: 'POST',
      url: '/api/rules',
      headers: { cookie: agentCookie },
      payload: {
        name: 'Rogue',
        match: { event: 'ticket.created' },
        action: { type: 'add_tag', tags: ['x'] },
      },
    })
    expect(forbidden.statusCode).toBe(403)

    const created = await app.inject({
      method: 'POST',
      url: '/api/rules',
      headers: { cookie: superCookie },
      payload: {
        name: 'Auto-tag created',
        match: { event: 'ticket.created' },
        action: { type: 'add_tag', tags: ['auto'] },
      },
    })
    expect(created.statusCode).toBe(201)
    expect(created.json().enabled).toBe(false) // disabled until enabled
    const ruleId = created.json().id

    const listed = await app.inject({
      method: 'GET',
      url: '/api/rules',
      headers: { cookie: agentCookie },
    })
    expect(listed.statusCode).toBe(200)
    expect(listed.json().some((r: { id: string }) => r.id === ruleId)).toBe(true)

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/rules/${ruleId}`,
      headers: { cookie: superCookie },
    })
    expect(deleted.statusCode).toBe(204)
  })

  it('send_template fires only when rule and template are both enabled', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/api/email/templates/ticket_new',
      headers: { cookie: superCookie },
      payload: { enabled: true },
    })
    const rule = await app.inject({
      method: 'POST',
      url: '/api/rules',
      headers: { cookie: superCookie },
      payload: {
        name: 'Notify on new ticket',
        match: { event: 'ticket.created', staffOnly: true },
        action: { type: 'send_template', templateKey: 'ticket_new' },
      },
    })
    const ruleId = rule.json().id
    // rule created disabled -> create a ticket, nothing should enqueue
    const before = await app.inject({
      method: 'GET',
      url: '/api/outbox',
      headers: { cookie: superCookie },
    })
    const beforeCount = before.json().length
    await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: superCookie },
      payload: { clientId: clientA, subject: 'disabled rule ticket' },
    })
    const mid = (
      await app.inject({ method: 'GET', url: '/api/outbox', headers: { cookie: superCookie } })
    ).json()
    expect(mid.length).toBe(beforeCount)

    // enable the rule -> now it fires
    await app.inject({
      method: 'PATCH',
      url: `/api/rules/${ruleId}`,
      headers: { cookie: superCookie },
      payload: { enabled: true },
    })
    await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: superCookie },
      payload: { clientId: clientA, subject: 'enabled rule ticket' },
    })
    const after = (
      await app.inject({ method: 'GET', url: '/api/outbox', headers: { cookie: superCookie } })
    ).json()
    expect(after.length).toBe(beforeCount + 1)
    const sent = after[after.length - 1]
    expect(sent.subject).toMatch(/Your new ticket #\d+: enabled rule ticket/)
    // the outbox view hides bodies — verify the rendered body in the DB
    const [sentRow] = await db.select().from(emailOutbox).where(eq(emailOutbox.id, sent.id))
    expect(sentRow.body).toContain('We have received your ticket')
    expect(sentRow.body).toContain('Kulik Labs IT')

    const runs = (
      await app.inject({
        method: 'GET',
        url: `/api/rules/runs?ruleId=${ruleId}`,
        headers: { cookie: superCookie },
      })
    ).json()
    expect(runs.length).toBe(1)
    expect(runs[0].result).toBe('ok')
  })

  it('assign / add_tag / set_status actions mutate the ticket', async () => {
    const mk = (action: object) =>
      app.inject({
        method: 'POST',
        url: '/api/rules',
        headers: { cookie: superCookie },
        payload: { name: 'action rule', enabled: true, match: { event: 'ticket.created' }, action },
      })
    const assignRule = await mk({ type: 'assign', userId: agentId })
    expect(assignRule.statusCode).toBe(201)
    const created = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: superCookie },
      payload: { clientId: clientA, subject: 'assign target' },
    })
    expect(created.json().assignedTo).toBe(agentId)

    // add_tag
    const tagRule = await mk({ type: 'add_tag', tags: ['vip', 'auto'] })
    expect(tagRule.statusCode).toBe(201)
    const created2 = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: superCookie },
      payload: { clientId: clientA, subject: 'tag target' },
    })
    expect(created2.json().tags).toContain('vip')

    // set_status (close)
    const statusRule = await mk({ type: 'set_status', status: 'hold' })
    expect(statusRule.statusCode).toBe(201)
    const created3 = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: superCookie },
      payload: { clientId: clientA, subject: 'status target' },
    })
    expect(created3.json().status).toBe('hold')

    for (const id of [assignRule.json().id, tagRule.json().id, statusRule.json().id]) {
      await app.inject({
        method: 'DELETE',
        url: `/api/rules/${id}`,
        headers: { cookie: superCookie },
      })
    }
  })

  it('match conditions gate firing (priority, tags, status, staffOnly)', async () => {
    // priority: only urgent
    await app.inject({
      method: 'POST',
      url: '/api/rules',
      headers: { cookie: superCookie },
      payload: {
        name: 'urgent only',
        enabled: true,
        match: { event: 'ticket.created', priority: 'urgent' },
        action: { type: 'add_tag', tags: ['urgent-tag'] },
      },
    })
    const normal = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: superCookie },
      payload: { clientId: clientA, subject: 'normal prio' },
    })
    expect(normal.json().tags).not.toContain('urgent-tag')
    const urgent = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: superCookie },
      payload: { clientId: clientA, subject: 'urgent prio', priority: 'urgent' },
    })
    expect(urgent.json().tags).toContain('urgent-tag')

    // tags: requires a pre-existing tag on the ticket
    await app.inject({
      method: 'POST',
      url: '/api/rules',
      headers: { cookie: superCookie },
      payload: {
        name: 'tagged ticket',
        enabled: true,
        match: { event: 'ticket.updated', tags: ['vip'] },
        action: { type: 'add_tag', tags: ['from-vip'] },
      },
    })
    const t2 = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: superCookie },
      payload: { clientId: clientA, subject: 'tag gate', tags: ['vip'] },
    })
    // update the ticket (no status change) -> fires
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/tickets/${t2.json().id}`,
      headers: { cookie: superCookie },
      payload: { subject: 'tag gate 2' },
    })
    expect(patched.json().tags).toContain('from-vip')
    const t3 = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: superCookie },
      payload: { clientId: clientA, subject: 'no vip tag' },
    })
    const patched3 = await app.inject({
      method: 'PATCH',
      url: `/api/tickets/${t3.json().id}`,
      headers: { cookie: superCookie },
      payload: { subject: 'no vip tag 2' },
    })
    expect(patched3.json().tags).not.toContain('from-vip')

    // status: only when transitioning TO closed
    await app.inject({
      method: 'POST',
      url: '/api/rules',
      headers: { cookie: superCookie },
      payload: {
        name: 'on close',
        enabled: true,
        match: { event: 'ticket.status_changed', status: 'closed' },
        action: { type: 'add_tag', tags: ['closed-tag'] },
      },
    })
    const t4 = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: superCookie },
      payload: { clientId: clientA, subject: 'close gate' },
    })
    const toHold = await app.inject({
      method: 'PATCH',
      url: `/api/tickets/${t4.json().id}`,
      headers: { cookie: superCookie },
      payload: { status: 'hold' },
    })
    expect(toHold.json().tags).not.toContain('closed-tag')
    const toClosed = await app.inject({
      method: 'PATCH',
      url: `/api/tickets/${t4.json().id}`,
      headers: { cookie: superCookie },
      payload: { status: 'closed' },
    })
    expect(toClosed.json().tags).toContain('closed-tag')

    for (const r of (
      await app.inject({ method: 'GET', url: '/api/rules', headers: { cookie: superCookie } })
    ).json()) {
      await app.inject({
        method: 'DELETE',
        url: `/api/rules/${r.id}`,
        headers: { cookie: superCookie },
      })
    }
  })

  it('test preview shows what would fire without executing', async () => {
    await app.inject({
      method: 'PATCH',
      url: '/api/email/templates/ticket_reply',
      headers: { cookie: superCookie },
      payload: { enabled: true },
    })
    const rule = await app.inject({
      method: 'POST',
      url: '/api/rules',
      headers: { cookie: superCookie },
      payload: {
        name: 'reply template',
        match: { event: 'ticket.reply', staffOnly: true },
        action: { type: 'send_template', templateKey: 'ticket_reply' },
      },
    })
    const before = (
      await app.inject({ method: 'GET', url: '/api/outbox', headers: { cookie: superCookie } })
    ).json().length

    const preview = await app.inject({
      method: 'POST',
      url: '/api/rules/test',
      headers: { cookie: superCookie },
      payload: { ticketId, event: 'ticket.reply' },
    })
    expect(preview.statusCode).toBe(200)
    const body = preview.json()
    expect(body.matches.length).toBe(1)
    expect(body.matches[0].ruleId).toBe(rule.json().id)
    expect(body.matches[0].enabled).toBe(false) // disabled, so it would NOT fire

    // a reply enqueues exactly the base staff-reply email — nothing more,
    // because the template rule is disabled
    await app.inject({
      method: 'POST',
      url: `/api/tickets/${ticketId}/updates`,
      headers: { cookie: superCookie },
      payload: { kind: 'public', body: 'a reply' },
    })
    const afterRows = (
      await app.inject({ method: 'GET', url: '/api/outbox', headers: { cookie: superCookie } })
    ).json()
    expect(afterRows.length).toBe(before + 1)
    // the base reply carries the agent's text verbatim, not a rendered
    // template (select by ticket: other outbox rows are from other tickets)
    const replyRows = await db
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.ticketId, ticketId))
    expect(replyRows.length).toBe(1)
    expect(replyRows[0].body).toBe('a reply')

    await app.inject({
      method: 'DELETE',
      url: `/api/rules/${rule.json().id}`,
      headers: { cookie: superCookie },
    })
    await app.inject({
      method: 'PATCH',
      url: '/api/email/templates/ticket_reply',
      headers: { cookie: superCookie },
      payload: { enabled: false },
    })
  })

  it('notifications: assignee is notified, actor is not, scoped to self', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: superCookie },
      payload: { clientId: clientA, subject: 'notify me', assignedTo: agentId },
    })
    const tId = created.json().id

    const agentNotifs = await app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { cookie: agentCookie },
    })
    expect(agentNotifs.statusCode).toBe(200)
    const forAgent = agentNotifs.json().filter(
      (n: { message: string }) => n.message.includes('#'),
    )
    expect(forAgent.some((n: { message: string }) => n.message.includes('assigned to you'))).toBe(
      true,
    )

    // actor (superuser) has no self-notification for their own assignment
    const superNotifs = (
      await app.inject({ method: 'GET', url: '/api/notifications', headers: { cookie: superCookie } })
    ).json()
    expect(
      superNotifs.some(
        (n: { message: string }) =>
          n.message.includes('assigned to you') && n.message.includes('notify me'),
      ),
    ).toBe(false)

    // contact sees nothing
    const contactNotifs = await app.inject({
      method: 'GET',
      url: '/api/notifications',
      headers: { cookie: contactCookie },
    })
    expect(contactNotifs.json().length).toBe(0)

    // a reply from the superuser notifies the assignee (agent)
    await app.inject({
      method: 'POST',
      url: `/api/tickets/${tId}/updates`,
      headers: { cookie: superCookie },
      payload: { kind: 'public', body: 'looking into it' },
    })
    const agentCount = (
      await app.inject({ method: 'GET', url: '/api/notifications/count', headers: { cookie: agentCookie } })
    ).json().unread
    expect(agentCount).toBeGreaterThanOrEqual(2)

    // mark all read -> count drops to 0
    const read = await app.inject({
      method: 'POST',
      url: '/api/notifications/read',
      headers: { cookie: agentCookie },
      payload: { all: true },
    })
    expect(read.json().unread).toBe(0)
  })

  it('SLA breach notifies the assignee', async () => {
    // enable SLA + a default policy with tiny targets
    await app.inject({
      method: 'POST',
      url: '/api/sla/settings',
      headers: { cookie: superCookie },
      payload: { enabled: true },
    })
    const policy = await app.inject({
      method: 'POST',
      url: '/api/sla/policies',
      headers: { cookie: superCookie },
      payload: {
        name: 'Tiny',
        isDefault: true,
        targets: {
          responseMinutes: { low: 5, normal: 5, high: 5, urgent: 5 },
          resolveMinutes: { low: 10, normal: 10, high: 10, urgent: 10 },
        },
      },
    })
    expect(policy.statusCode).toBe(201)
    expect(policy.json().isDefault).toBe(true)
    const created = await app.inject({
      method: 'POST',
      url: '/api/tickets',
      headers: { cookie: superCookie },
      payload: { clientId: clientA, subject: 'sla breach notify', assignedTo: agentId },
    })
    const tId = created.json().id
    // force the response due into the past, then tick
    await db
      .update(tickets)
      .set({
        slaResponseDueAt: new Date(Date.now() - 60_000),
        slaResponseState: 'pending',
      })
      .where(eq(tickets.id, tId))
    await tickSla()
    const notifs = (
      await app.inject({ method: 'GET', url: '/api/notifications', headers: { cookie: agentCookie } })
    ).json()
    expect(
      notifs.some((n: { event: string }) => n.event === 'sla.breached'),
    ).toBe(true)
    // clean up SLA so later suites are unaffected
    await app.inject({
      method: 'POST',
      url: '/api/sla/settings',
      headers: { cookie: superCookie },
      payload: { enabled: false },
    })
  })

  it('presence: self-service patch, validated', async () => {
    const bad = await app.inject({
      method: 'PATCH',
      url: '/api/me/presence',
      headers: { cookie: agentCookie },
      payload: { presence: 'napping' },
    })
    expect(bad.statusCode).toBe(400)
    const ok = await app.inject({
      method: 'PATCH',
      url: '/api/me/presence',
      headers: { cookie: agentCookie },
      payload: { presence: 'busy' },
    })
    expect(ok.statusCode).toBe(200)
    expect(ok.json().presence).toBe('busy')
    const [row] = await db.select().from(users).where(eq(users.id, agentId))
    expect(row.presence).toBe('busy')
  })
})
