import { describe, expect, it } from 'vitest'
import { BadRequestError, KippleError, NotFoundError, toErrorBody } from './errors'

describe('error mapping', () => {
  it('maps domain errors to status bodies', () => {
    expect(toErrorBody(new NotFoundError('no such ticket'))).toEqual({
      error: 'not_found',
      message: 'no such ticket',
    })
  })

  it('hides internals for unknown errors', () => {
    expect(toErrorBody(new Error('secret stack detail'))).toEqual({
      error: 'internal',
      message: 'internal server error',
    })
  })

  it('keeps subclasses in the KippleError chain', () => {
    const err = new BadRequestError()
    expect(err instanceof KippleError).toBe(true)
    expect(err.status).toBe(400)
  })
})
