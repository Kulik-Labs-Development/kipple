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

export const ClientCreate = z.object({
  name: z.string().min(1).max(200),
  domain: z.string().max(253).optional().or(z.literal('')),
})
export type ClientCreate = z.infer<typeof ClientCreate>

export const ClientUpdate = ClientCreate.partial()

export const ContactCreate = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(254),
  phone: z.string().max(40).optional().or(z.literal('')),
})
export type ContactCreate = z.infer<typeof ContactCreate>

export const ContactUpdate = ContactCreate.partial()

export const ContactClientLink = z.object({
  clientId: z.string().min(1),
  isPrimary: z.boolean().optional(),
})
export type ContactClientLink = z.infer<typeof ContactClientLink>

export const TicketCreate = z.object({
  clientId: z.string().min(1),
  subject: z.string().min(1).max(300),
  body: z.string().max(50000).optional().default(''),
  priority: TicketPriority.optional().default('normal'),
  assignedTo: z.string().min(1).nullable().optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional().default([]),
})
export type TicketCreate = z.infer<typeof TicketCreate>

export const TicketUpdate = z.object({
  clientId: z.string().min(1).optional(),
  subject: z.string().min(1).max(300).optional(),
  status: TicketStatus.optional(),
  priority: TicketPriority.optional(),
  assignedTo: z.string().min(1).nullable().optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
})
export type TicketUpdate = z.infer<typeof TicketUpdate>

export const UpdateCreate = z.object({
  kind: z.enum(['public', 'internal']).optional().default('public'),
  body: z.string().min(1).max(100000),
})
export type UpdateCreate = z.infer<typeof UpdateCreate>
