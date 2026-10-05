import {
  ApiKeyCreate,
  ApiKeyView,
  ClientCreate,
  ClientUpdate,
  ContactCreate,
  ContactUpdate,
  TicketCreate,
  TicketUpdate,
  UpdateCreate,
} from '@kipple/shared'
import type { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { zodToJsonSchema } from 'zod-to-json-schema'

// OpenAPI 3.1 for the public REST API (Phase 2, row 1).
//
// The request/response schemas are the SHARED Zod schemas — the same objects
// the routes validate against — converted with zod-to-json-schema (the
// maintained zod -> JSON Schema bridge, no fork needed). Paths are a curated
// list (key management + the clients/contacts/tickets/updates core) described
// by hand; the wire shapes come from the schemas, so spec and validation
// cannot drift on the fields that matter. Served at GET /api/openapi.json
// with the bearer security scheme.

type SchemaName =
  | 'ApiKeyCreate'
  | 'ApiKeyView'
  | 'ClientCreate'
  | 'ClientUpdate'
  | 'ContactCreate'
  | 'ContactUpdate'
  | 'TicketCreate'
  | 'TicketUpdate'
  | 'UpdateCreate'

// ZodTypeAny (not the concrete objects): the shared schemas include
// transform-bearing members (e.g. .trim() on the key name) that widen to
// ZodEffects, and the generator's overloads don't like that union.
const SCHEMAS: Record<SchemaName, z.ZodTypeAny> = {
  ApiKeyCreate,
  ApiKeyView,
  ClientCreate,
  ClientUpdate,
  ContactCreate,
  ContactUpdate,
  TicketCreate,
  TicketUpdate,
  UpdateCreate,
}

function ref(name: SchemaName): Record<string, unknown> {
  return { $ref: `#/components/schemas/${name}` }
}

const ERROR_SCHEMA = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    message: { type: 'string' },
  },
  required: ['error', 'message'],
} as const

function errorResponses(extra: Record<number, string> = {}) {
  const base: Record<string, unknown> = {
    400: { description: 'Bad request', content: { 'application/json': { schema: ERROR_SCHEMA } } },
    401: { description: 'Not signed in (session) or invalid api key', content: { 'application/json': { schema: ERROR_SCHEMA } } },
    403: { description: 'Insufficient role or api key scope', content: { 'application/json': { schema: ERROR_SCHEMA } } },
    404: { description: 'Not found (or out of client scope — no existence leaks)', content: { 'application/json': { schema: ERROR_SCHEMA } } },
  }
  for (const [status, description] of Object.entries(extra)) {
    base[status] = {
      description,
      content: { 'application/json': { schema: ERROR_SCHEMA } },
    }
  }
  return base
}

function json(content: Record<string, unknown>) {
  return { 'application/json': { schema: content } }
}

// zod-to-json-schema's 'openApi3' target emits 3.0-style `nullable: true`,
// which is invalid in a 3.1 document — normalize to the 3.1 `anyOf` form so
// the served spec is genuinely 3.1-valid.
function toOpenApi31(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(toOpenApi31)
  if (node === null || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    out[key] = toOpenApi31(value)
  }
  if (out.nullable === true) {
    const { nullable: _nullable, ...rest } = out
    return { anyOf: [rest, { type: 'null' }] }
  }
  return out
}

function ticketQueryParams() {
  return [
    { name: 'status', in: 'query', schema: { type: 'string' } },
    { name: 'priority', in: 'query', schema: { type: 'string' } },
    { name: 'clientId', in: 'query', schema: { type: 'string' } },
    { name: 'assignedTo', in: 'query', schema: { type: 'string' } },
    { name: 'q', in: 'query', schema: { type: 'string' } },
  ] as const
}

export function buildOpenApiSpec(): Record<string, unknown> {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Kipple REST API v1',
      version: '1.0.0',
      description: [
        'Ticketing + client-portal API for a single MSP instance.',
        '',
        'Authentication: session cookie (browser) or `Authorization: Bearer kip_...`',
        'API key. A key acts as its creating user — all RBAC and client',
        'scoping rules apply, and a key is gated to the scopes it was minted',
        'with. Request/response bodies are validated by the shared Zod',
        'schemas referenced below.',
      ].join('\n'),
    },
    servers: [{ url: '/', description: 'this instance' }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'Kipple API key (kip_...)',
          description: 'A Kipple API key, or (for browser sessions) the session cookie instead.',
        },
      },
      schemas: Object.fromEntries(
        (Object.keys(SCHEMAS) as SchemaName[]).map((name) => [
          name,
          toOpenApi31(
            zodToJsonSchema(SCHEMAS[name], { target: 'openApi3', $refStrategy: 'none' }),
          ),
        ]),
      ),
    },
    security: [{ bearerAuth: [] }],
    paths: {
      '/api/keys': {
        get: {
          summary: 'List API keys',
          description: 'Superuser. Returns key metadata only — never the hash or the full key.',
          responses: {
            200: {
              description: 'The instance API keys',
              content: json({ type: 'array', items: ref('ApiKeyView') }),
            },
            ...errorResponses(),
          },
        },
        post: {
          summary: 'Create an API key',
          description:
            'Superuser. The full key is returned EXACTLY ONCE in this response; only its sha256 hash and a display prefix are stored.',
          requestBody: { required: true, content: json(ref('ApiKeyCreate')) },
          responses: {
            201: {
              description: 'The created key (full key included, once)',
              content: json({
                allOf: [ref('ApiKeyView'), { type: 'object', properties: { key: { type: 'string' } } }],
              }),
            },
            ...errorResponses({ 409: 'A key with this name already exists for this user' }),
          },
        },
      },
      '/api/keys/{id}': {
        delete: {
          summary: 'Revoke an API key',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            200: { description: 'The revoked key', content: json(ref('ApiKeyView')) },
            ...errorResponses({ 409: 'Already revoked' }),
          },
        },
      },
      '/api/clients': {
        get: {
          summary: 'List clients',
          description: 'Any signed-in user; client-scoped (contacts see only their own clients).',
          responses: {
            200: {
              description: 'Clients',
              content: json({
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    name: { type: 'string' },
                    domain: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                  },
                  required: ['id', 'name'],
                },
              }),
            },
            ...errorResponses(),
          },
        },
        post: {
          summary: 'Create a client',
          description: 'Staff (agent or above).',
          requestBody: { required: true, content: json(ref('ClientCreate')) },
          responses: {
            201: { description: 'The created client', content: json(ref('ClientCreate')) },
            ...errorResponses(),
          },
        },
      },
      '/api/clients/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          summary: 'Get a client',
          responses: { 200: { description: 'The client' }, ...errorResponses() },
        },
        patch: {
          summary: 'Update a client',
          description: 'Staff (agent or above).',
          requestBody: { required: true, content: json(ref('ClientUpdate')) },
          responses: { 200: { description: 'The updated client' }, ...errorResponses() },
        },
        delete: {
          summary: 'Delete a client',
          description: 'Admin or above. 409 while the client has tickets.',
          responses: {
            204: { description: 'Deleted' },
            ...errorResponses({ 409: 'Client still has tickets' }),
          },
        },
      },
      '/api/clients/{clientId}/contacts': {
        parameters: [{ name: 'clientId', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          summary: 'List a client contacts',
          responses: { 200: { description: 'Contacts', content: json({ type: 'array' }) }, ...errorResponses() },
        },
        post: {
          summary: 'Create a contact on a client',
          description: 'Staff (agent or above).',
          requestBody: { required: true, content: json(ref('ContactCreate')) },
          responses: {
            201: { description: 'The created contact', content: json(ref('ContactCreate')) },
            ...errorResponses(),
          },
        },
      },
      '/api/contacts/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          summary: 'Get a contact',
          responses: { 200: { description: 'The contact' }, ...errorResponses() },
        },
        patch: {
          summary: 'Update a contact',
          description: 'Staff (agent or above).',
          requestBody: { required: true, content: json(ref('ContactUpdate')) },
          responses: { 200: { description: 'The updated contact' }, ...errorResponses() },
        },
      },
      '/api/tickets': {
        get: {
          summary: 'List tickets',
          description:
            'Any signed-in user; client-scoped (contacts see only their own clients, no deleted tickets, no internal updates).',
          parameters: [...ticketQueryParams()],
          responses: { 200: { description: 'Tickets (max 200, newest updated first)' }, ...errorResponses() },
        },
        post: {
          summary: 'Create a ticket',
          description:
            'Any signed-in user on a client they can see; staff get SLA/alias/queue behavior, contacts a public ticket.',
          requestBody: { required: true, content: json(ref('TicketCreate')) },
          responses: {
            201: { description: 'The created ticket' },
            ...errorResponses(),
          },
        },
      },
      '/api/tickets/{id}': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        get: {
          summary: 'Get a ticket with its updates',
          responses: {
            200: {
              description: 'The ticket (+updates; SLA fields and internal updates are staff-only)',
            },
            ...errorResponses(),
          },
        },
        patch: {
          summary: 'Update a ticket',
          description: 'Staff (agent or above).',
          requestBody: { required: true, content: json(ref('TicketUpdate')) },
          responses: { 200: { description: 'The updated ticket' }, ...errorResponses() },
        },
        delete: {
          summary: 'Soft-delete a ticket',
          description: 'Staff (agent or above). Sets status=deleted (email history preserved).',
          responses: { 204: { description: 'Deleted' }, ...errorResponses() },
        },
      },
      '/api/tickets/{id}/updates': {
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        post: {
          summary: 'Add a public or internal update',
          description:
            'Any signed-in user on a ticket they can see; contact updates are forced public. JSON body (multipart file mode also exists).',
          requestBody: { required: true, content: json(ref('UpdateCreate')) },
          responses: {
            201: { description: 'The created update' },
            ...errorResponses(),
          },
        },
      },
    },
  }
}

export async function registerOpenApiRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/openapi.json', async () => buildOpenApiSpec())
}
