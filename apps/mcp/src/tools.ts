import { ClientCreate, TicketCreate, TicketPriority, TicketStatus, UpdateCreate } from '@kipple/shared'
import { z } from 'zod'
import type { KippleClient } from './client'

// The MCP tool surface (Phase 2, row 1). Every input is a shared Zod schema
// (house style — the same objects the REST API validates) so tool inputs and
// API requests can never drift; the JSON schemas advertised to MCP clients
// are generated from these same objects (zod-to-json-schema).
//
// Tools are the REST API with an API key — the server never reaches
// in-process into the domain layer. What a tool can do is bounded by the
// key's scopes + the key creator's RBAC/client scoping, exactly as over
// plain HTTP (see TOOL_SCOPES in client.ts for the minting hint per tool).

const zString = z.string().min(1)

export const ListTicketsInput = z.object({
  status: TicketStatus.optional(),
  priority: TicketPriority.optional(),
  clientId: zString.optional(),
  assignedTo: zString.optional(),
  q: zString.optional(),
})
export type ListTicketsInput = z.infer<typeof ListTicketsInput>

export const GetTicketInput = z.object({ id: zString })
export type GetTicketInput = z.infer<typeof GetTicketInput>

// Reuse the shared create schema as-is: the REST API rejects what we don't
// accept, and vice versa.
export const CreateTicketInput = TicketCreate
export type CreateTicketInput = z.infer<typeof CreateTicketInput>

export const AddUpdateInput = UpdateCreate.extend({
  ticketId: zString,
})
export type AddUpdateInput = z.infer<typeof AddUpdateInput>

export const ListClientsInput = z.object({})
export type ListClientsInput = z.infer<typeof ListClientsInput>

// The MCP surface for client creation stays minimal: name + optional domain.
// (Branding / self-reg / SLA policy are admin-panel concerns.)
export const CreateClientInput = ClientCreate.pick({ name: true, domain: true })
export type CreateClientInput = z.infer<typeof CreateClientInput>

export const ListContactsInput = z.object({ clientId: zString })
export type ListContactsInput = z.infer<typeof ListContactsInput>

// Uniform registry shape: the server parses with `input` before dispatching,
// so each run receives already-validated arguments (the per-tool casts keep
// the internals fully typed).
export interface McpTool {
  name: string
  description: string
  input: z.ZodTypeAny
  run: (client: KippleClient, args: unknown) => Promise<string>
}

function result(data: unknown): string {
  return JSON.stringify(data, null, 2)
}

async function runListTickets(client: KippleClient, raw: unknown): Promise<string> {
  const args = raw as ListTicketsInput
  const tickets = await client.get<unknown[]>('/api/tickets', {
    status: args.status,
    priority: args.priority,
    clientId: args.clientId,
    assignedTo: args.assignedTo,
    q: args.q,
  })
  return result(tickets)
}

async function runGetTicket(client: KippleClient, raw: unknown): Promise<string> {
  const args = raw as GetTicketInput
  const ticket = await client.get<unknown>(`/api/tickets/${args.id}`)
  return result(ticket)
}

async function runCreateTicket(client: KippleClient, raw: unknown): Promise<string> {
  const args = raw as CreateTicketInput
  const ticket = await client.post<unknown>('/api/tickets', args)
  return result(ticket)
}

async function runAddUpdate(client: KippleClient, raw: unknown): Promise<string> {
  const args = raw as AddUpdateInput
  const { ticketId, ...body } = args
  const update = await client.post<unknown>(`/api/tickets/${ticketId}/updates`, body)
  return result(update)
}

async function runListClients(client: KippleClient): Promise<string> {
  const clients = await client.get<unknown[]>('/api/clients')
  return result(clients)
}

async function runCreateClient(client: KippleClient, raw: unknown): Promise<string> {
  const args = raw as CreateClientInput
  const clientRow = await client.post<unknown>('/api/clients', args)
  return result(clientRow)
}

async function runListContacts(client: KippleClient, raw: unknown): Promise<string> {
  const args = raw as ListContactsInput
  const contacts = await client.get<unknown[]>(`/api/clients/${args.clientId}/contacts`)
  return result(contacts)
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'list_tickets',
    description:
      'List tickets, newest updated first (max 200). Filters: status (open/pending/hold/closed/deleted), priority (low/normal/high/urgent), clientId, assignedTo (user id), q (subject search). Requires tickets:read.',
    input: ListTicketsInput,
    run: runListTickets,
  },
  {
    name: 'get_ticket',
    description:
      'Get one ticket with its update timeline (author, kind, body per update). Internal notes are only included when the API key acts as staff. Requires tickets:read.',
    input: GetTicketInput,
    run: runGetTicket,
  },
  {
    name: 'create_ticket',
    description:
      'Create a ticket on a client. clientId is required (list_clients to find it); a body becomes the first public update. The acting user must be able to see the client. Requires tickets:write (+ clients:read to discover ids).',
    input: CreateTicketInput,
    run: runCreateTicket,
  },
  {
    name: 'add_update',
    description:
      'Add an update to a ticket. kind: "public" (visible to the client, may trigger a reply email) or "internal" (staff note only — staff key required). Requires tickets:write.',
    input: AddUpdateInput,
    run: runAddUpdate,
  },
  {
    name: 'list_clients',
    description:
      'List clients the API key can see (contacts see only their own clients). Requires clients:read.',
    input: ListClientsInput,
    run: runListClients,
  },
  {
    name: 'create_client',
    description:
      'Create a client company (name + optional domain). Requires clients:write — and the key must act as staff (agent or above), as with the REST API.',
    input: CreateClientInput,
    run: runCreateClient,
  },
  {
    name: 'list_contacts',
    description: 'List the contacts of one client. Requires contacts:read.',
    input: ListContactsInput,
    run: runListContacts,
  },
]
