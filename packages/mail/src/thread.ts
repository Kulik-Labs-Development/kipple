import { parseTicketAlias } from './alias'
import type { ParsedEmail } from './parse'

// The thread-matching layers (PLAN §5.1):
//   a) Message-ID / References in an existing thread
//   b) ticket alias (support+{n}@) in the To header
//   c) ticket number in the subject ([KIP-{n}])
//   d) known contact -> new ticket
// Signal extraction is pure so it is unit-tested with fixture .eml files;
// the DB-backed resolution lives in the api.

export interface ThreadSignals {
  aliasNumber: number | null
  subjectNumber: number | null
  messageIds: string[]
}

const SUBJECT_TAG = /\[KIP[-_ ]?(\d+)\]/i

export function extractThreadSignals(email: ParsedEmail): ThreadSignals {
  let aliasNumber: number | null = null
  for (const to of email.to) {
    aliasNumber = parseTicketAlias(to)
    if (aliasNumber !== null) break
  }
  const subjectMatch = SUBJECT_TAG.exec(email.subject)
  const messageIds: string[] = []
  for (const id of [...email.references, ...(email.inReplyTo ? [email.inReplyTo] : [])]) {
    if (!messageIds.includes(id)) messageIds.push(id)
  }
  return {
    aliasNumber,
    subjectNumber: subjectMatch ? Number(subjectMatch[1]) : null,
    messageIds: [...messageIds],
  }
}

// Subject for a ticket created from an inbound email: strip leading
// Re:/Fwd:/Fw: decorations (possibly repeated, mixed case).
export function cleanEmailSubject(subject: string): string {
  let current = subject.trim()
  let previous = ''
  while (current !== previous) {
    previous = current
    current = current.replace(/^(re|fwd|fw)\s*:\s*/i, '').trim()
  }
  return current
}
