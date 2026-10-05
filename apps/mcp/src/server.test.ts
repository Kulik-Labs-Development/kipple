import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import { KippleClient } from './client'
import { buildServer } from './server'

// One transport smoke over the REAL MCP protocol: the SDK client and the
// server (with a stubbed REST fetch) meet over an in-memory transport pair —
// initialize, tools/list, tools/call round trips, no network.

function restStub(status: number, body: unknown) {
  return (async (_url: string | URL, _init?: RequestInit) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch
}

describe('mcp transport smoke (in-memory)', () => {
  it('list tools + call a tool end to end', async () => {
    const rest = new KippleClient('http://api.test', 'kip_testkey', restStub(200, [{ id: 'c1', name: 'Acme' }]))
    const server = buildServer(rest)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await server.connect(serverTransport)

    const client = new Client({ name: 'smoke-client', version: '0.0.0' })
    await client.connect(clientTransport)

    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name).sort()).toEqual(
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
    // advertised input schema is real JSON Schema (generated from the Zod inputs)
    const listTickets = tools.find((tool) => tool.name === 'list_tickets')!
    expect(listTickets.inputSchema.type).toBe('object')
    expect(listTickets.inputSchema.properties).toHaveProperty('status')

    const result = await client.callTool({ name: 'list_clients', arguments: {} })
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify([{ id: 'c1', name: 'Acme' }], null, 2) },
    ])

    // invalid arguments are rejected by the server-side Zod check
    await expect(client.callTool({ name: 'get_ticket', arguments: {} })).rejects.toThrow(
      /invalid arguments/,
    )
    // unknown tool is rejected
    await expect(client.callTool({ name: 'nope', arguments: {} })).rejects.toThrow(/unknown tool/)

    await client.close()
    await server.close()
  })
})
