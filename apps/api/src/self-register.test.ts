import { eq, ilike, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from './app'
import { db } from './db'
import { runMigrations } from './db/migrate'
import {
  accounts,
  audit,
  clients,
  contactClients,
  contacts,
  emailOutbox,
  notifications,
  ruleRuns,
  rules,
  sessions,
  settings,
  tickets,
  timeEntries,
  twoFactor,
  updates,
  users,
  verifications,
} from './db/schema'

type App = Awaited<ReturnType<typeof buildApp>>

const owner = {
  instanceName: 'Kulik SelfReg',
  ownerName: 'Max SelfReg',
  ownerEmail: 'max@selfreg.test',
  password: 'correct-horse-selfreg',
}

async function wipe() {
  await db.delete(verifications)
  await db.delete(twoFactor)
  await db.delete(sessions)
  await db.delete(notifications)
  await db.delete(ruleRuns)
  await db.delete(rules)
  await db.delete(emailOutbox)
  await db.delete(timeEntries)
  await db.delete(updates)
  await db.delete(tickets)
  await db.delete(contactClients)
  await db.delete(contacts)
  await db.delete(clients)
  await db.delete(audit)
  await db.delete(users)
  await db.delete(settings)
}

function cookiesFrom(res: { headers: Record<string, unknown> }): string {
  const raw = res.headers['set-cookie']
  const list = Array.isArray(raw) ? raw : [raw]
  return list
    .filter(Boolean)
    .map((cookie) => String(cookie).split(';')[0])
    .join('; ')
}

describe('client self-registration (issue #33)', () => {
  let app: App
  let staffCookie: string
  let acme: string // self-reg enabled: ['acme.test']
  let globex: string // self-reg off (the default)

  const adaEmail = 'ada@acme.test'
  const benEmail = 'ben@acme.test'
  const doraEmail = 'dora@acme.test'

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
    expect(login.statusCode).toBe(200)
    staffCookie = cookiesFrom(login)

    const resA = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie: staffCookie },
      payload: { name: 'Acme Corp', selfRegDomains: [' ACME.TEST '] },
    })
    expect(resA.statusCode).toBe(201)
    acme = resA.json().id
    // the create path normalizes whitespace + case
    expect(resA.json().selfRegDomains).toEqual(['acme.test'])

    const resB = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie: staffCookie },
      payload: { name: 'Globex' },
    })
    expect(resB.statusCode).toBe(201)
    globex = resB.json().id
    expect(resB.json().selfRegDomains).toBeNull()
  })

  afterAll(async () => {
    await app.close()
    await wipe()
  })

  function selfRegister(email: string, name: string) {
    return app.inject({
      method: 'POST',
      url: '/api/portal/self-register',
      headers: { 'content-type': 'application/json' },
      payload: { email, name },
    })
  }

  function brandingFor(email: string) {
    return app.inject({
      method: 'POST',
      url: '/api/portal/branding',
      headers: { 'content-type': 'application/json' },
      payload: { email },
    })
  }

  it('staff can set, read, and clear the allowed domains per client', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/clients',
      headers: { cookie: staffCookie },
      payload: { name: 'Initech' },
    })
    expect(created.statusCode).toBe(201)
    const initech = created.json().id
    expect(created.json().selfRegDomains).toBeNull()

    const off = await app.inject({
      method: 'GET',
      url: `/api/clients/${initech}`,
      headers: { cookie: staffCookie },
    })
    expect(off.json().selfRegDomains).toBeNull()

    const on = await app.inject({
      method: 'PATCH',
      url: `/api/clients/${initech}`,
      headers: { cookie: staffCookie, 'content-type': 'application/json' },
      payload: { selfRegDomains: [' INITECH.TEST '] },
    })
    expect(on.statusCode).toBe(200)
    expect(on.json().selfRegDomains).toEqual(['initech.test'])

    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/clients/${initech}`,
      headers: { cookie: staffCookie, 'content-type': 'application/json' },
      payload: { selfRegDomains: null },
    })
    expect(cleared.statusCode).toBe(200)
    expect(cleared.json().selfRegDomains).toBeNull()

    // patch with no selfRegDomains key leaves the value untouched
    const untouched = await app.inject({
      method: 'PATCH',
      url: `/api/clients/${initech}`,
      headers: { cookie: staffCookie, 'content-type': 'application/json' },
      payload: { name: 'Initech LLC' },
    })
    expect(untouched.statusCode).toBe(200)
    expect(untouched.json().selfRegDomains).toBeNull()
  })

  it('rejects malformed domain lists on create and patch', async () => {
    for (const body of [{ name: 'Bad', selfRegDomains: [] }, { name: 'Bad', selfRegDomains: ['no dot'] }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/clients',
        headers: { cookie: staffCookie, 'content-type': 'application/json' },
        payload: body,
      })
      expect(res.statusCode).toBe(400)
    }
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/clients/${acme}`,
      headers: { cookie: staffCookie, 'content-type': 'application/json' },
      payload: { selfRegDomains: [] },
    })
    expect(res.statusCode).toBe(400)
  })

  it('self-register answers 400 for malformed bodies (unauthenticated)', async () => {
    for (const payload of [{}, { email: 'nope' }, { email: adaEmail, name: '' }, { email: adaEmail }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/portal/self-register',
        headers: { 'content-type': 'application/json' },
        payload,
      })
      expect(res.statusCode).toBe(400)
    }
  })

  it('is off by default: no client with domains creates nothing', async () => {
    const res = await selfRegister('eve@globex.test', 'Eve')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: true })
    const [user] = await db.select().from(users).where(ilike(users.email, 'eve@globex.test'))
    expect(user).toBeUndefined()
    const [contact] = await db
      .select()
      .from(contacts)
      .where(ilike(contacts.email, 'eve@globex.test'))
    expect(contact).toBeUndefined()
  })

  it('never registers a domain outside the client list (subdomains excluded)', async () => {
    for (const email of ['eve@other.test', 'eve@sub.acme.test', 'eve@xacme.test']) {
      const res = await selfRegister(email, 'Eve')
      expect(res.statusCode).toBe(200)
      expect(res.json()).toEqual({ status: true })
    }
    const [user] = await db
      .select()
      .from(users)
      .where(ilike(users.email, 'eve@sub.acme.test'))
    expect(user).toBeUndefined()
  })

  it('creates contact + primary link + verified portal user for a matching domain', async () => {
    const res = await selfRegister(adaEmail, 'Ada Kline')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: true })

    const [contact] = await db.select().from(contacts).where(ilike(contacts.email, adaEmail))
    expect(contact).toBeDefined()
    expect(contact!.name).toBe('Ada Kline')

    const [link] = await db
      .select()
      .from(contactClients)
      .where(eq(contactClients.contactId, contact!.id))
    expect(link).toBeDefined()
    expect(link!.clientId).toBe(acme)
    expect(link!.isPrimary).toBe(true)

    const [user] = await db.select().from(users).where(eq(users.contactId, contact!.id))
    expect(user).toBeDefined()
    expect(user!.role).toBe('contact')
    expect(user!.name).toBe('Ada Kline')
    expect(user!.emailVerified).toBe(true)

    const [account] = await db.select().from(accounts).where(eq(accounts.userId, user!.id))
    expect(account).toBeDefined()
    expect(account!.issuer).toBe('local:credential')

    const [auditRow] = await db
      .select()
      .from(audit)
      .where(eq(audit.action, 'contact.self_register'))
    expect(auditRow).toBeDefined()
    expect(auditRow!.actorId).toBeNull()
    expect(auditRow!.meta).toMatchObject({ clientId: acme })

    // the endpoint itself sends no mail — only the chained magic link does
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(emailOutbox)
    expect(Number(count)).toBe(0)
  })

  it('is idempotent: a second request creates no duplicates', async () => {
    const res = await selfRegister(adaEmail, 'Ada Kline Again')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: true })
    const contactRows = await db.select().from(contacts).where(ilike(contacts.email, adaEmail))
    expect(contactRows.length).toBe(1)
    const userRows = await db.select().from(users).where(ilike(users.email, adaEmail))
    expect(userRows.length).toBe(1)
  })

  it('provisions a staff-created contact on the matched client without duplicating it', async () => {
    const contactRes = await app.inject({
      method: 'POST',
      url: `/api/clients/${acme}/contacts`,
      headers: { cookie: staffCookie, 'content-type': 'application/json' },
      payload: { name: 'Ben StaffMade', email: benEmail },
    })
    expect(contactRes.statusCode).toBe(201)
    const contactId = contactRes.json().id

    const res = await selfRegister(benEmail, 'Ben SelfReg')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: true })

    const contactRows = await db.select().from(contacts).where(eq(contacts.id, contactId))
    expect(contactRows.length).toBe(1)
    expect(contactRows[0].name).toBe('Ben StaffMade') // name not clobbered
    const userRows = await db.select().from(users).where(eq(users.contactId, contactId))
    expect(userRows.length).toBe(1)
    expect(userRows[0].emailVerified).toBe(true)
  })

  it('never re-homes a staff-created contact linked only to another client', async () => {
    const contactRes = await app.inject({
      method: 'POST',
      url: `/api/clients/${globex}/contacts`,
      headers: { cookie: staffCookie, 'content-type': 'application/json' },
      payload: { name: 'Dora Globex', email: doraEmail },
    })
    expect(contactRes.statusCode).toBe(201)
    const contactId = contactRes.json().id

    const res = await selfRegister(doraEmail, 'Dora SelfReg')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: true })

    const userRows = await db.select().from(users).where(eq(users.contactId, contactId))
    expect(userRows.length).toBe(0)
    const links = await db
      .select()
      .from(contactClients)
      .where(eq(contactClients.contactId, contactId))
    expect(links.map((link) => link.clientId)).toEqual([globex])
  })

  it('never touches an existing staff account', async () => {
    const res = await selfRegister(owner.ownerEmail, 'Max Imposter')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: true })
    const [contact] = await db
      .select()
      .from(contacts)
      .where(ilike(contacts.email, owner.ownerEmail))
    expect(contact).toBeUndefined()
    const staffRows = await db
      .select()
      .from(users)
      .where(ilike(users.email, owner.ownerEmail))
    expect(staffRows.length).toBe(1)
    expect(staffRows[0].role).toBe('superuser')
  })

  it('exposes selfRegister=true only for unmatched accounts on enabled domains', async () => {
    // enabled domain, no account yet
    const fresh = await brandingFor('newhire@acme.test')
    expect(fresh.statusCode).toBe(200)
    expect(fresh.json()).toEqual({ clientName: null, logoUrl: null, selfRegister: true })

    // disabled client (off by default)
    const off = await brandingFor('newhire@globex.test')
    expect(off.json()).toEqual({ clientName: null, logoUrl: null, selfRegister: false })

    // unknown domain
    const unknown = await brandingFor('newhire@nowhere.test')
    expect(unknown.json()).toEqual({ clientName: null, logoUrl: null, selfRegister: false })

    // staff account: never
    const staff = await brandingFor(owner.ownerEmail)
    expect(staff.json().selfRegister).toBe(false)

    // existing contact account: never (ada was created above)
    const ada = await brandingFor(adaEmail)
    expect(ada.json()).toEqual({ clientName: 'Acme Corp', logoUrl: null, selfRegister: false })
  })

  it('matches domains case-insensitively and stays idempotent across case', async () => {
    const res = await selfRegister('CASE@ACME.TEST', 'Casey')
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: true })
    const rows = await db.select().from(users).where(ilike(users.email, 'case@acme.test'))
    expect(rows.length).toBe(1)
    // the lowercase spelling resolves to the same account (no second user)
    const again = await selfRegister('case@acme.test', 'Casey 2')
    expect(again.json()).toEqual({ status: true })
    const rows2 = await db.select().from(users).where(ilike(users.email, 'case@acme.test'))
    expect(rows2.length).toBe(1)
  })
})
