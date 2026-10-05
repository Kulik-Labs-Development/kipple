import type { ApiKeyScope } from '@kipple/shared'

// Thin REST client for the Kipple API. The MCP server has no in-process view
// of the domain layer — it dogfoods the public REST API over HTTP with an
// API key (env: KIPPLE_API_URL + KIPPLE_API_KEY).
//
// `fetchImpl` is injectable so unit tests run against a stub instead of the
// network (and so the client never reaches past its scope table).

export class KippleClient {
  private fetchImpl: typeof fetch

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.fetchImpl = fetchImpl
  }

  async get<T>(path: string, params: Record<string, unknown> = {}): Promise<T> {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) query.set(key, String(value))
    }
    const qs = query.toString()
    return this.request<T>('GET', qs ? `${path}?${qs}` : path)
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body)
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = await res.text()
    const data = text ? JSON.parse(text) : {}
    if (!res.ok) {
      const error = (data as { error?: string; message?: string }).error ?? 'error'
      const message = (data as { message?: string }).message ?? res.statusText
      throw new Error(`${method} ${path} -> ${res.status} ${error}: ${message}`)
    }
    return data as T
  }
}

/** The scopes a key needs for a given set of tools (docs + minting hints). */
export const TOOL_SCOPES: Record<string, ApiKeyScope[]> = {
  list_tickets: ['tickets:read'],
  get_ticket: ['tickets:read'],
  create_ticket: ['tickets:write', 'clients:read'],
  add_update: ['tickets:write'],
  list_clients: ['clients:read'],
  create_client: ['clients:write'],
  list_contacts: ['contacts:read', 'clients:read'],
}
