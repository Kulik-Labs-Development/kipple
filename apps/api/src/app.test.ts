import { describe, expect, it } from 'vitest'
import { buildApp } from './app'

describe('api', () => {
  it('answers /healthz', async () => {
    const app = await buildApp()
    const res = await app.inject({ method: 'GET', url: '/healthz' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, service: 'api' })
    await app.close()
  })

  it('maps unknown errors to a safe body', async () => {
    const app = await buildApp()
    app.get('/boom', async () => {
      throw new Error('kaboom')
    })
    const res = await app.inject({ method: 'GET', url: '/boom' })
    expect(res.statusCode).toBe(500)
    expect(res.json()).toEqual({ error: 'internal', message: 'internal server error' })
    await app.close()
  })
})
