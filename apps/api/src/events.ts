import { randomUUID } from 'node:crypto'
import type { FastifyReply } from 'fastify'

// Lightweight SSE event channel (issue #96). One in-memory client registry
// per API process: connected clients subscribe, and the presence write sites
// (sign-in hook, PATCH /api/me/presence) fan out a frame to every client.
//
// v1 shape decisions (flagged in the PR):
// - presence is the only event type for now; the frame format
//   (`event: <name>\ndata: <json>`) already carries a generic event name, so
//   later event types (notification arrival, ticket changes) ride the same
//   connection without a protocol change.
// - fan-out is per-process: a horizontal scale-out of the API container
//   would need a shared bus (e.g. Redis pub/sub) — the standard self-hosted
//   deploy is a single API container, same constraint class as the 30s
//   polling the channel replaces.

type SendFrame = (frame: string) => void

const clients = new Map<string, SendFrame>()

export function registerClient(send: SendFrame): () => void {
  const clientId = randomUUID()
  clients.set(clientId, send)
  return () => {
    clients.delete(clientId)
  }
}

function frame(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
}

// Fan out one event to every connected client. Fire-and-forget from the
// write sites; a dead socket drops its frame (the client reconnects and
// re-syncs from its next fetch).
export function broadcastEvent(event: string, payload: unknown): void {
  if (clients.size === 0) return
  const text = frame(event, payload)
  for (const send of clients.values()) send(text)
}

export function sendPresenceEvent(userId: string, presence: string): void {
  broadcastEvent('presence', { userId, presence })
}

// GET /api/events — SSE stream for the signed-in user. reply.hijack() takes
// over the raw socket; the heartbeat keeps idle connections alive and is the
// dead-peer detector (a wedged write surfaces there or on close).
export async function sseReply(reply: FastifyReply): Promise<void> {
  reply.hijack()
  const raw = reply.raw
  raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  })
  let closed = false
  const send: SendFrame = (text) => {
    if (closed) return
    try {
      raw.write(text)
    } catch {
      closed = true
    }
  }
  send(frame('hello', { ok: true }))
  const unregister = registerClient(send)
  const heartbeat = setInterval(() => send(': ping\n\n'), 25_000)
  raw.on('close', () => {
    closed = true
    clearInterval(heartbeat)
    unregister()
  })
}
