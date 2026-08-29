export function parseTicketAlias(toHeader: string): number | null {
  const match = /\+(\d+)@/.exec(toHeader)
  return match ? Number(match[1]) : null
}

export function ticketAliasAddress(
  ticketId: number,
  domain: string,
  local = 'support',
): string {
  return `${local}+${ticketId}@${domain}`
}
