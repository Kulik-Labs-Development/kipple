import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { cleanEmailSubject, extractThreadSignals } from './thread'
import { normalizeMessageId, parseEmail } from './parse'

const here = path.dirname(fileURLToPath(import.meta.url))

function fixture(name: string): Buffer {
  return readFileSync(path.resolve(here, '../fixtures', name))
}

describe('parseEmail', () => {
  it('parses a plain reply with alias, references, and message-id', async () => {
    const email = await parseEmail(fixture('alias-reply.eml'))
    expect(email.from).toEqual({ name: 'Ada Client', address: 'ada@acme.test' })
    expect(email.to).toEqual(['support+12@kuliklabs.dev'])
    expect(email.subject).toBe('Re: [KIP-12] Printer is on fire')
    expect(email.messageId).toBe('in-1001@acme.test')
    expect(email.inReplyTo).toBe('out-0001@kuliklabs.dev')
    expect(email.references).toEqual(['out-0001@kuliklabs.dev'])
    expect(email.text).toContain('it was a paper jam')
  })

  it('parses unicode subjects and quoted-printable bodies', async () => {
    const email = await parseEmail(fixture('new-contact-unicode.eml'))
    expect(email.from.name).toBe('Ada Client')
    expect(email.subject).toBe('Übermorgen: Neues Ticket')
    expect(email.text).toContain("can't connect at all")
  })

  it('parses the unknown-sender fixture', async () => {
    const email = await parseEmail(fixture('unknown-sender.eml'))
    expect(email.from.address).toBe('stranger@evil.test')
    expect(email.messageId).toBe('in-1005@evil.test')
  })
})

describe('normalizeMessageId', () => {
  it('strips angle brackets and lowercases', () => {
    expect(normalizeMessageId('<ABC@x.test>')).toBe('abc@x.test')
    expect(normalizeMessageId('  abc@x.test ')).toBe('abc@x.test')
    expect(normalizeMessageId('')).toBeNull()
    expect(normalizeMessageId(null)).toBeNull()
    expect(normalizeMessageId('<>')).toBeNull()
  })
})

describe('extractThreadSignals', () => {
  it('finds the alias number in the To header', async () => {
    const email = await parseEmail(fixture('alias-reply.eml'))
    const signals = extractThreadSignals(email)
    expect(signals.aliasNumber).toBe(12)
    expect(signals.subjectNumber).toBe(12)
    expect(signals.messageIds).toContain('out-0001@kuliklabs.dev')
  })

  it('finds the subject tag when the To has no alias', async () => {
    const email = await parseEmail(fixture('subject-tag.eml'))
    const signals = extractThreadSignals(email)
    expect(signals.aliasNumber).toBeNull()
    expect(signals.subjectNumber).toBe(42)
  })

  it('collects references and in-reply-to (case-insensitive, deduped)', async () => {
    const email = await parseEmail(fixture('references-only.eml'))
    const signals = extractThreadSignals(email)
    expect(signals.aliasNumber).toBeNull()
    expect(signals.subjectNumber).toBeNull()
    expect(signals.messageIds).toEqual(['out-0008@kuliklabs.dev', 'out-0009@kuliklabs.dev'])
  })

  it('finds no signals for a fresh conversation', async () => {
    const email = await parseEmail(fixture('new-contact-unicode.eml'))
    const signals = extractThreadSignals(email)
    expect(signals).toEqual({ aliasNumber: null, subjectNumber: null, messageIds: [] })
  })
})

describe('cleanEmailSubject', () => {
  it('strips Re/Fwd prefixes repeatedly and case-insensitively', () => {
    expect(cleanEmailSubject('Re: [KIP-3] VPN down')).toBe('[KIP-3] VPN down')
    expect(cleanEmailSubject('FW: re: FW: vpn down')).toBe('vpn down')
    expect(cleanEmailSubject('  plain subject  ')).toBe('plain subject')
  })
})
