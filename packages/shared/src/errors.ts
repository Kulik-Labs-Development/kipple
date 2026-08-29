export type ErrorCode =
  | 'bad_request'
  | 'not_found'
  | 'forbidden'
  | 'conflict'
  | 'internal'

export class KippleError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = new.target.name
  }
}

export class BadRequestError extends KippleError {
  constructor(message = 'bad request') {
    super('bad_request', 400, message)
  }
}

export class NotFoundError extends KippleError {
  constructor(message = 'not found') {
    super('not_found', 404, message)
  }
}

export class ForbiddenError extends KippleError {
  constructor(message = 'forbidden') {
    super('forbidden', 403, message)
  }
}

export class ConflictError extends KippleError {
  constructor(message = 'conflict') {
    super('conflict', 409, message)
  }
}

export function toErrorBody(error: unknown): { error: string; message: string } {
  if (error instanceof KippleError) {
    return { error: error.code, message: error.message }
  }
  return { error: 'internal', message: 'internal server error' }
}
