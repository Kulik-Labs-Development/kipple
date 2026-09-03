import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { db } from './db'
import { notifications, tickets } from './db/schema'
import type { RuleEvent } from './rules'

// In-app notification center (PLAN §8d). v1 is polling-based (30s, like the
// rest of the workspace); SSE is a documented follow-up. Events are pushed to
// the ticket's assignee, never to the actor themselves.

export async function notify(
  userId: string,
  event: string,
  ticketId: string | null,
  message: string,
): Promise<void> {
  await db.insert(notifications).values({
    id: randomUUID(),
    userId,
    event,
    ticketId,
    message,
  })
}

export async function listNotifications(
  userId: string,
  opts: { limit?: number; unread?: boolean } = {},
) {
  const limit = Math.min(opts.limit ?? 50, 200)
  return db
    .select()
    .from(notifications)
    .where(
      opts.unread
        ? and(eq(notifications.userId, userId), eq(notifications.read, false))
        : eq(notifications.userId, userId),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(limit)
}

export async function unreadCount(userId: string): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)` })
    .from(notifications)
    .where(and(eq(notifications.userId, userId), eq(notifications.read, false)))
  return Number(count)
}

export async function markRead(userId: string, ids: string[] | null): Promise<number> {
  const rows = await db
    .update(notifications)
    .set({ read: true })
    .where(
      ids && ids.length > 0
        ? and(eq(notifications.userId, userId), inArray(notifications.id, ids))
        : eq(notifications.userId, userId),
    )
    .returning({ id: notifications.id })
  return rows.length
}

export interface NotifyableEvent extends RuleEvent {
  // the assignee before a ticket.updated, when the event is an update
  fromAssignedTo?: string | null
  // ticket.hold_warning: calendar days left until the auto-close
  daysUntilAutoClose?: number
}

// One notification fan-out per ticket event.
export async function notifyTicketEvent(event: NotifyableEvent): Promise<void> {
  const ticket = event.ticket
  const assignee = ticket.assignedTo
  const notSelf = (id: string | null) => id !== null && id !== event.actor.id
  switch (event.type) {
    case 'ticket.created':
      if (assignee && notSelf(assignee)) {
        await notify(
          assignee,
          'ticket.assigned',
          ticket.id,
          `Ticket #${ticket.number} “${ticket.subject}” was assigned to you`,
        )
      }
      break
    case 'ticket.reply':
      if (assignee && notSelf(assignee)) {
        await notify(
          assignee,
          'ticket.reply',
          ticket.id,
          `${event.actor.name ?? 'An agent'} replied on ticket #${ticket.number} “${ticket.subject}”`,
        )
      }
      break
    case 'ticket.status_changed':
      if (assignee && notSelf(assignee)) {
        await notify(
          assignee,
          'ticket.status_changed',
          ticket.id,
          `Ticket #${ticket.number} “${ticket.subject}” is now ${ticket.status}`,
        )
      }
      break
    case 'ticket.updated':
      // reassignment is the only case worth notifying on a generic update
      if (
        event.fromAssignedTo !== undefined &&
        event.fromAssignedTo !== ticket.assignedTo &&
        assignee &&
        notSelf(assignee)
      ) {
        await notify(
          assignee,
          'ticket.assigned',
          ticket.id,
          `Ticket #${ticket.number} “${ticket.subject}” was assigned to you`,
        )
      }
      break
    case 'ticket.hold_warning':
      if (assignee && notSelf(assignee)) {
        const days =
          event.daysUntilAutoClose !== undefined
            ? ` in ${event.daysUntilAutoClose} day${event.daysUntilAutoClose === 1 ? '' : 's'}`
            : ''
        await notify(
          assignee,
          'ticket.hold_warning',
          ticket.id,
          `Ticket #${ticket.number} “${ticket.subject}” will auto-close${days} (on hold)`,
        )
      }
      break
  }
}

// SLA breach fan-out (called from the SLA tick + settle paths).
export async function notifySlaBreach(ticketId: string, number: number, kind: string): Promise<void> {
  const [ticket] = await db
    .select({ assignedTo: tickets.assignedTo })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
  if (ticket?.assignedTo) {
    await notify(
      ticket.assignedTo,
      'sla.breached',
      ticketId,
      `SLA ${kind} breached on ticket #${number}`,
    )
  }
}
