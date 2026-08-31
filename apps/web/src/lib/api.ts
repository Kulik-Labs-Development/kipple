import type { ColorMode } from '@kipple/shared'

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface MeUser {
  id: string
  name: string
  email: string
  emailVerified: boolean
  role: string
  presence: string
  authSource: string
}

export interface MeResponse {
  user: MeUser
  sessionId: string
  instanceTheme: string
  contactId: string | null
  primaryClient: { id: string; name: string; domain: string | null } | null
  preferences: {
    theme: string | null
    colorMode: ColorMode
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  const text = await res.text()
  const data = (text ? JSON.parse(text) : {}) as T & { error?: string; message?: string }
  if (!res.ok) {
    throw new ApiError(res.status, data.error ?? 'error', data.message ?? res.statusText)
  }
  return data
}

export interface ClientSummary {
  id: string
  name: string
  domain: string | null
}

export interface ContactSummary {
  id: string
  name: string
  email: string
  phone: string | null
}

export interface StaffUser {
  id: string
  name: string
  email: string
  role: string
  presence: string
}

export interface TicketRow {
  id: string
  number: number
  clientId: string
  alias: string | null
  subject: string
  status: string
  priority: string
  assignedTo: string | null
  tags: string[]
  createdAt: string
  updatedAt: string
}

export interface TicketUpdateRow {
  id: string
  ticketId: string
  authorId: string | null
  authorName: string | null
  kind: string
  body: string
  createdAt: string
}

export interface TicketDetail extends TicketRow {
  clientName: string | null
  assignedName: string | null
  updates: TicketUpdateRow[]
}

export interface TicketFilters {
  status?: string
  priority?: string
  clientId?: string
  assignedTo?: string
  q?: string
}

export interface TimeEntryRow {
  id: string
  ticketId: string
  agentId: string
  agentName: string | null
  clientId: string
  startedAt: string
  durationS: number | null
  billable: boolean
  note: string
}

export interface TimeFilters {
  ticketId?: string
  clientId?: string
  agentId?: string
  billable?: boolean
  running?: boolean
  completed?: boolean
}

function timeQuery(filters: TimeFilters): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined) params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

function ticketQuery(filters: TicketFilters): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, value)
  }
  const qs = params.toString()
  return qs ? `?${qs}` : ''
}

export const api = {
  me: () => request<MeResponse>('/api/me'),
  listClients: () => request<ClientSummary[]>('/api/clients'),
  createClient: (body: { name: string; domain?: string }) =>
    request<ClientSummary>('/api/clients', { method: 'POST', body: JSON.stringify(body) }),
  listContacts: (clientId: string) =>
    request<ContactSummary[]>(`/api/clients/${clientId}/contacts`),
  listStaff: () => request<StaffUser[]>('/api/users'),
  listTickets: (filters: TicketFilters = {}) =>
    request<TicketRow[]>(`/api/tickets${ticketQuery(filters)}`),
  getTicket: (id: string) => request<TicketDetail>(`/api/tickets/${id}`),
  createTicket: (body: {
    clientId: string
    subject: string
    body?: string
    priority?: string
    tags?: string[]
  }) => request<TicketRow>('/api/tickets', { method: 'POST', body: JSON.stringify(body) }),
  patchTicket: (
    id: string,
    body: {
      clientId?: string
      subject?: string
      status?: string
      priority?: string
      assignedTo?: string | null
      tags?: string[]
    },
  ) => request<TicketRow>(`/api/tickets/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  addTicketUpdate: (id: string, body: { kind?: 'public' | 'internal'; body: string }) =>
    request<TicketUpdateRow>(`/api/tickets/${id}/updates`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  deleteTicket: (id: string) =>
    request<void>(`/api/tickets/${id}`, { method: 'DELETE' }),
  setupStatus: () => request<{ setupRequired: boolean }>('/api/setup/status'),
  setup: (body: {
    instanceName: string
    ownerName: string
    ownerEmail: string
    password: string
  }) => request('/api/setup', { method: 'POST', body: JSON.stringify(body) }),
  signIn: (email: string, password: string) =>
    request('/api/auth/sign-in/email', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  requestMagicLink: (email: string) =>
    request<{ status: boolean }>('/api/auth/sign-in/magic-link', {
      method: 'POST',
      body: JSON.stringify({ email, callbackURL: '/portal' }),
    }),
  signOut: () => request('/api/auth/sign-out', { method: 'POST' }),
  patchPreferences: (body: { theme?: string | null; colorMode?: ColorMode }) =>
    request('/api/preferences', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  listTime: (filters: TimeFilters = {}) =>
    request<TimeEntryRow[]>(`/api/time${timeQuery(filters)}`),
  activeTime: () => request<{ entry: TimeEntryRow | null }>('/api/time/active'),
  startTime: (body: { ticketId: string; billable?: boolean; note?: string }) =>
    request<TimeEntryRow>('/api/time/start', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  stopTime: () => request<TimeEntryRow>('/api/time/stop', { method: 'POST' }),
  addTimeEntry: (body: {
    ticketId: string
    startedAt: string
    durationS: number
    billable?: boolean
    note?: string
  }) =>
    request<TimeEntryRow>('/api/time/entries', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  patchTime: (
    id: string,
    body: { startedAt?: string; durationS?: number; billable?: boolean; note?: string },
  ) => request<TimeEntryRow>(`/api/time/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteTime: (id: string) => request<void>(`/api/time/${id}`, { method: 'DELETE' }),
}
