import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'

// Regression: request() must not attach a JSON content-type to a body-less
// request — Fastify rejects an empty body under application/json
// (FST_ERR_CTP_EMPTY_JSON_BODY), which broke the timer-stop POST and the
// user-remove DELETE.
function mockFetch(body = '{}') {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => body,
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function headersOf(fetchMock: ReturnType<typeof mockFetch>) {
  const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
  return { url, init, headers: (init.headers ?? {}) as Record<string, string> }
}

describe('request() content-type handling', () => {
  it('omits the JSON content-type on a body-less POST (timer stop)', async () => {
    const fetchMock = mockFetch()
    await api.stopTime()
    const { url, init, headers } = headersOf(fetchMock)
    expect(url).toBe('/api/time/stop')
    expect(init.method).toBe('POST')
    expect(headers['Content-Type']).toBeUndefined()
  })

  it('omits the JSON content-type on a body-less DELETE (remove user)', async () => {
    const fetchMock = mockFetch()
    await api.deleteUser('some-user-id')
    const { url, init, headers } = headersOf(fetchMock)
    expect(url).toBe('/api/users/some-user-id')
    expect(init.method).toBe('DELETE')
    expect(headers['Content-Type']).toBeUndefined()
  })

  it('keeps the JSON content-type when a body is present', async () => {
    const fetchMock = mockFetch()
    await api.startTime({ ticketId: 'ticket-1', billable: true })
    const { url, init, headers } = headersOf(fetchMock)
    expect(url).toBe('/api/time/start')
    expect(headers['Content-Type']).toBe('application/json')
    expect(init.body).toBe(JSON.stringify({ ticketId: 'ticket-1', billable: true }))
  })
})
