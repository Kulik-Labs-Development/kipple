import { describe, expect, it } from 'vitest'
import { KippleClient } from './client'
import {
  AddUpdateInput,
  CreateClientInput,
  CreateTicketInput,
  GetTicketInput,
  ListContactsInput,
  ListTicketsInput,
  MCP_TOOLS,
} from './tools'

// Tool schema validation (house style: inputs are Zod) + run() behavior
// against a stubbed fetch — the client is the only network surface.

interface StubCall {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

function makeStub(responses: Array<{ status: number; body: unknown }> = []) {
  const calls: StubCall[] = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k, String(v)])),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    const next = responses.shift() ?? { status: 200, body: [] }
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { calls, fetchImpl }
}

const TOOL_NAMES = MCP_TOOLS.map((tool) => tool.name)

describe('tool registry', () => {
  it('exposes the core surface', () => {
    expect(TOOL_NAMES.sort()).toEqual(
      [
        'add_update',
        'create_client',
        'create_ticket',
        'get_ticket',
        'list_clients',
        'list_contacts',
        'list_tickets',
      ].sort(),
    )
  })
})

describe('input schemas', () => {
  it('list_tickets accepts filters and rejects junk', () => {
    expect(ListTicketsInput.safeParse({}).success).toBe(true)
    expect(
      ListTicketsInput.safeParse({ status: 'open', priority: 'high', q: 'printer', clientId: 'c1' })
        .success,
    ).toBe(true)
    expect(ListTicketsInput.safeParse({ status: 'bogus' }).success).toBe(false)
    expect(ListTicketsInput.safeParse({ priority: 'bogus' }).success).toBe(false)
  })

  it('create_ticket reuses the shared TicketCreate contract', () => {
    expect(CreateTicketInput.safeParse({ clientId: 'c1', subject: 'Printer on fire' }).success).toBe(
      true,
    )
    expect(CreateTicketInput.safeParse({ subject: 'missing client' }).success).toBe(false)
    expect(
      CreateTicketInput.safeParse({ clientId: 'c1', subject: 'x', priority: 'critical' }).success,
    ).toBe(false)
  })

  it('add_update requires a ticket + body, kind is public|internal', () => {
    expect(AddUpdateInput.safeParse({ ticketId: 't1', body: 'hi' }).success).toBe(true)
    expect(AddUpdateInput.safeParse({ ticketId: 't1', body: 'hi', kind: 'internal' }).success).toBe(
      true,
    )
    expect(AddUpdateInput.safeParse({ body: 'no ticket' }).success).toBe(false)
    expect(AddUpdateInput.safeParse({ ticketId: 't1', body: '' }).success).toBe(false)
    expect(AddUpdateInput.safeParse({ ticketId: 't1', body: 'x', kind: 'secret' }).success).toBe(
      false,
    )
  })

  it('get_ticket / list_contacts require their ids; create_client stays minimal', () => {
    expect(GetTicketInput.safeParse({}).success).toBe(false)
    expect(GetTicketInput.safeParse({ id: 't1' }).success).toBe(true)
    expect(ListContactsInput.safeParse({}).success).toBe(false)
    expect(CreateClientInput.safeParse({ name: 'Acme' }).success).toBe(true)
    expect(CreateClientInput.safeParse({ name: '' }).success).toBe(false)
  })
})

describe('run() against a stubbed fetch', () => {
  it('list_tickets sends filters as query params + the bearer key', async () => {
    const { calls, fetchImpl } = makeStub([{ status: 200, body: [{ id: 't1' }] }])
    const client = new KippleClient('http://api.test', 'kip_testkey', fetchImpl)
    const tool = MCP_TOOLS.find((t) => t.name === 'list_tickets')!
    const text = await tool.run(client, { status: 'open', q: 'printer' })
    expect(calls[0].method).toBe('GET')
    expect(calls[0].url).toContain('/api/tickets?')
    const params = new URL(calls[0].url).searchParams
    expect(params.get('status')).toBe('open')
    expect(params.get('q')).toBe('printer')
    expect(calls[0].headers.authorization).toBe('Bearer kip_testkey')
    expect(JSON.parse(text)).toEqual([{ id: 't1' }])
  })

  it('add_update posts the body (without ticketId) to the updates endpoint', async () => {
    const { calls, fetchImpl } = makeStub([{ status: 201, body: { id: 'u1', kind: 'internal' } }])
    const client = new KippleClient('http://api.test', 'kip_testkey', fetchImpl)
    const tool = MCP_TOOLS.find((t) => t.name === 'add_update')!
    const text = await tool.run(client, { ticketId: 't1', kind: 'internal', body: 'note' })
    expect(calls[0].method).toBe('POST')
    expect(calls[0].url).toBe('http://api.test/api/tickets/t1/updates')
    expect(calls[0].body).toEqual({ kind: 'internal', body: 'note' })
    expect(JSON.parse(text)).toEqual({ id: 'u1', kind: 'internal' })
  })

  it('surfaces API errors with status + message', async () => {
    const { fetchImpl } = makeStub([
      { status: 403, body: { error: 'forbidden', message: 'api key is missing the required scope' } },
    ])
    const client = new KippleClient('http://api.test', 'kip_testkey', fetchImpl)
    const tool = MCP_TOOLS.find((t) => t.name === 'get_ticket')!
    await expect(tool.run(client, { id: 't1' })).rejects.toThrow(/403 forbidden/)
  })
})
