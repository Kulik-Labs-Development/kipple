import { z } from 'zod'

export const TicketStatus = z.enum(['open', 'pending', 'hold', 'closed', 'deleted'])
export type TicketStatus = z.infer<typeof TicketStatus>

export const TicketPriority = z.enum(['low', 'normal', 'high', 'urgent'])
export type TicketPriority = z.infer<typeof TicketPriority>

export const AgentPresence = z.enum(['online', 'away', 'busy', 'offline'])
export type AgentPresence = z.infer<typeof AgentPresence>

export const UserRole = z.enum(['superuser', 'admin', 'agent', 'contact'])
export type UserRole = z.infer<typeof UserRole>

export const SetupRequest = z.object({
  instanceName: z.string().min(2).max(80),
  ownerName: z.string().min(2).max(120),
  ownerEmail: z.string().email().max(200),
  password: z.string().min(8).max(128),
})
export type SetupRequest = z.infer<typeof SetupRequest>
