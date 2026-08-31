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
  // SLA fields (staff only — the API strips them from contact responses)
  slaPolicyId: string | null
  slaResponseDueAt: string | null
  slaResolveDueAt: string | null
  slaResponseAt: string | null
  slaResolvedAt: string | null
  slaResponseState: string
  slaResolveState: string
}

export interface SlaPolicy {
  id: string
  name: string
  isDefault: boolean
  targets: {
    responseMinutes: Record<'low' | 'normal' | 'high' | 'urgent', number>
    resolveMinutes: Record<'low' | 'normal' | 'high' | 'urgent', number>
  }
}

export interface SlaPolicyInput {
  name: string
  isDefault?: boolean
  targets: {
    responseMinutes: Record<'low' | 'normal' | 'high' | 'urgent', number>
    resolveMinutes: Record<'low' | 'normal' | 'high' | 'urgent', number>
  }
}

export interface SlaConfig {
  enabled: boolean
  businessHours: {
    timezone: string
    windows: { day: number; start: string; end: string }[]
  }
  policies: SlaPolicy[]
}

export interface EmailTemplate {
  id: string
  key: string
  name: string
  subject: string
  body: string
  enabled: boolean
}

export interface EmailTemplateInput {
  key: string
  name: string
  subject?: string
  body?: string
  enabled?: boolean
}

export const RULE_EVENTS = [
  'ticket.created',
  'ticket.status_changed',
  'ticket.reply',
  'ticket.updated',
] as const
export type RuleEventName = (typeof RULE_EVENTS)[number]

export type RuleAction =
  | { type: 'send_template'; templateKey: string }
  | { type: 'assign'; userId: string }
  | { type: 'add_tag'; tags: string[] }
  | { type: 'set_status'; status: string }
  | { type: 'webhook'; url: string; secret?: string }

export interface RuleMatch {
  event: RuleEventName
  status?: string
  fromStatus?: string
  priority?: string
  clientId?: string
  tags?: string[]
  staffOnly?: boolean
}

export interface RuleRow {
  id: string
  name: string
  enabled: boolean
  match: RuleMatch
  action: RuleAction
  createdAt: string
  updatedAt: string
}

export interface RuleInput {
  name: string
  enabled?: boolean
  match: RuleMatch
  action: RuleAction
}

export interface RuleRunRow {
  id: string
  ruleId: string
  event: string
  ticketId: string | null
  result: 'ok' | 'noop' | 'error'
  error: string | null
  meta: Record<string, unknown> | null
  createdAt: string
}

export interface RuleTestMatch {
  ruleId: string
  name: string
  enabled: boolean
  matches: boolean
  match: RuleMatch
  action: RuleAction
}

export interface NotificationRow {
  id: string
  userId: string
  event: string
  ticketId: string | null
  message: string
  read: boolean
  createdAt: string
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
      slaPolicyId?: string | null
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
  slaConfig: () => request<SlaConfig>('/api/sla/config'),
  slaSetEnabled: (enabled: boolean) =>
    request<{ enabled: boolean }>('/api/sla/settings', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),
  slaSetBusinessHours: (businessHours: SlaConfig['businessHours']) =>
    request<SlaConfig['businessHours']>('/api/sla/business-hours', {
      method: 'POST',
      body: JSON.stringify(businessHours),
    }),
  slaCreatePolicy: (body: SlaPolicyInput) =>
    request<SlaPolicy>('/api/sla/policies', { method: 'POST', body: JSON.stringify(body) }),
  slaPatchPolicy: (id: string, body: Partial<SlaPolicyInput>) =>
    request<SlaPolicy>(`/api/sla/policies/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  slaDeletePolicy: (id: string) => request<void>(`/api/sla/policies/${id}`, { method: 'DELETE' }),
  listTemplates: () => request<EmailTemplate[]>('/api/email/templates'),
  createTemplate: (body: EmailTemplateInput) =>
    request<EmailTemplate>('/api/email/templates', { method: 'POST', body: JSON.stringify(body) }),
  patchTemplate: (key: string, body: Partial<EmailTemplateInput>) =>
    request<EmailTemplate>(`/api/email/templates/${key}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteTemplate: (key: string) =>
    request<void>(`/api/email/templates/${key}`, { method: 'DELETE' }),
  previewTemplate: (key: string, ticketId?: string | null) =>
    request<{ subject: string; body: string }>('/api/email/templates/preview', {
      method: 'POST',
      body: JSON.stringify({ key, ticketId: ticketId ?? undefined }),
    }),
  listRules: () => request<RuleRow[]>('/api/rules'),
  createRule: (body: RuleInput) =>
    request<RuleRow>('/api/rules', { method: 'POST', body: JSON.stringify(body) }),
  patchRule: (id: string, body: Partial<RuleInput>) =>
    request<RuleRow>(`/api/rules/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteRule: (id: string) => request<void>(`/api/rules/${id}`, { method: 'DELETE' }),
  testRules: (body: {
    ticketId: string
    event: string
    fromStatus?: string
    actorRole?: string
  }) =>
    request<{ ticketId: string; event: string; matches: RuleTestMatch[] }>('/api/rules/test', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  listRuleRuns: (ruleId?: string) =>
    request<RuleRunRow[]>(`/api/rules/runs${ruleId ? `?ruleId=${ruleId}` : ''}`),
  listNotifications: (opts: { limit?: number; unread?: boolean } = {}) => {
    const params = new URLSearchParams()
    if (opts.limit) params.set('limit', String(opts.limit))
    if (opts.unread) params.set('unread', '1')
    const qs = params.toString()
    return request<NotificationRow[]>(`/api/notifications${qs ? `?${qs}` : ''}`)
  },
  notificationCount: () => request<{ unread: number }>('/api/notifications/count'),
  markNotificationsRead: (body: { ids?: string[]; all?: boolean }) =>
    request<{ updated: number; unread: number }>('/api/notifications/read', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  setPresence: (presence: string) =>
    request<{ presence: string }>('/api/me/presence', {
      method: 'PATCH',
      body: JSON.stringify({ presence }),
    }),
}
