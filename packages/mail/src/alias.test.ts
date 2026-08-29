import { describe, expect, it } from 'vitest'
import { parseTicketAlias, ticketAliasAddress } from './alias'

describe('parseTicketAlias', () => {
  it('extracts the ticket id from a plus-addressed To header', () => {
    expect(parseTicketAlias('Support <support+1042@msp.com>')).toBe(1042)
  })

  it('finds the tag among multiple recipients', () => {
    expect(parseTicketAlias('a@x.com, support+7@x.com')).toBe(7)
  })

  it('returns null for plain addresses', () => {
    expect(parseTicketAlias('Support <support@msp.com>')).toBeNull()
  })
})

describe('ticketAliasAddress', () => {
  it('builds a plus-addressed alias', () => {
    expect(ticketAliasAddress(1042, 'msp.com')).toBe('support+1042@msp.com')
  })

  it('respects a custom local part', () => {
    expect(ticketAliasAddress(9, 'msp.com', 'help')).toBe('help+9@msp.com')
  })
})
