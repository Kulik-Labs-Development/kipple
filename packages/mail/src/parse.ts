import { simpleParser, type ParsedMail } from 'mailparser'

export interface ParsedEmail {
  messageId: string | null
  references: string[]
  inReplyTo: string | null
  from: { name: string; address: string }
  to: string[]
  subject: string
  text: string
  html: string
}

// Message-IDs compare case-insensitively (RFC 5322) and are commonly written
// with angle brackets; normalize both for storage and matching.
export function normalizeMessageId(id: string | null | undefined): string | null {
  if (!id) return null
  const trimmed = id.trim().replace(/^<|>$/g, '').trim()
  return trimmed ? trimmed.toLowerCase() : null
}

export async function parseEmail(raw: Buffer | string): Promise<ParsedEmail> {
  const mail = await simpleParser(raw, { skipHtmlToText: false })
  return parseSimpleMail(mail)
}

// Map a mailparser ParsedMail (as produced by the parser callback in the
// worker's IMAP message event) to our flat shape.
export function parseSimpleMail(mail: ParsedMail): ParsedEmail {
  const fromEntry = (Array.isArray(mail.from) ? mail.from[0]?.value : mail.from?.value)?.[0]
  const toEntry = (Array.isArray(mail.to) ? mail.to[0]?.value : mail.to?.value) ?? []
  // references may be a space-separated header string or an array
  const references = (Array.isArray(mail.references)
    ? mail.references
    : String(mail.references ?? '').split(/\s+/)
  )
    .map(normalizeMessageId)
    .filter((id): id is string => Boolean(id))
  return {
    messageId: normalizeMessageId(mail.messageId),
    references,
    inReplyTo: normalizeMessageId(mail.inReplyTo),
    from: { name: fromEntry?.name ?? '', address: fromEntry?.address ?? '' },
    to: toEntry.map((entry) => entry.address ?? '').filter(Boolean),
    subject: typeof mail.subject === 'string' ? mail.subject.trim() : '',
    text: typeof mail.text === 'string' ? mail.text : '',
    html: typeof mail.html === 'string' ? mail.html : '',
  }
}
