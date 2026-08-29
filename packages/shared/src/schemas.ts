import { z } from 'zod'

export const TicketStatus = z.enum(['open', 'pending', 'hold', 'closed', 'deleted'])
export type TicketStatus = z.infer<typeof TicketStatus>

export const TicketPriority = z.enum(['low', 'normal', 'high', 'urgent'])
export type TicketPriority = z.infer<typeof TicketPriority>

export const AgentPresence = z.enum(['online', 'away', 'busy', 'offline'])
export type AgentPresence = z.infer<typeof AgentPresence>
