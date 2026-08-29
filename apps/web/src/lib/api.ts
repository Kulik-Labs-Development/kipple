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

export const api = {
  me: () =>
    request<{ user: MeUser; sessionId: string }>('/api/me'),
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
  signOut: () => request('/api/auth/sign-out', { method: 'POST' }),
}
