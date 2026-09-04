import { describe, expect, it } from 'vitest'
import { ClientCreate, ClientUpdate, SelfRegDomains, emailDomainMatches } from './schemas'

describe('emailDomainMatches (issue #33 — client self-registration gate)', () => {
  it('matches the exact domain, case-insensitively', () => {
    expect(emailDomainMatches('ada@corp.com', ['corp.com'])).toBe(true)
    expect(emailDomainMatches('ADA@CORP.COM', ['corp.com'])).toBe(true)
    expect(emailDomainMatches('ada@corp.com', ['CORP.COM'])).toBe(true)
  })

  it('does not match subdomains or parent/other domains', () => {
    expect(emailDomainMatches('ada@sub.corp.com', ['corp.com'])).toBe(false)
    expect(emailDomainMatches('ada@corp.com', ['sub.corp.com'])).toBe(false)
    expect(emailDomainMatches('ada@xcorp.com', ['corp.com'])).toBe(false)
  })

  it('is off by default: null, undefined, and empty lists never match', () => {
    expect(emailDomainMatches('ada@corp.com', null)).toBe(false)
    expect(emailDomainMatches('ada@corp.com', undefined)).toBe(false)
    expect(emailDomainMatches('ada@corp.com', [])).toBe(false)
  })

  it('matches any entry in the list and ignores malformed emails', () => {
    expect(emailDomainMatches('ada@corp.com', ['other.com', 'corp.com'])).toBe(true)
    expect(emailDomainMatches('no-at-sign', ['corp.com'])).toBe(false)
    expect(emailDomainMatches('@corp.com', ['corp.com'])).toBe(false)
  })
})

describe('SelfRegDomains schema', () => {
  it('normalizes whitespace and case', () => {
    expect(SelfRegDomains.parse(['  Corp.Com ', 'other.org'])).toEqual(['corp.com', 'other.org'])
  })

  it('rejects empty lists, more than 10 entries, and malformed domains', () => {
    expect(SelfRegDomains.safeParse([]).success).toBe(false)
    expect(SelfRegDomains.safeParse(new Array(11).fill('a.com')).success).toBe(false)
    expect(SelfRegDomains.safeParse(['not a domain']).success).toBe(false)
    expect(SelfRegDomains.safeParse(['-bad.com']).success).toBe(false)
    expect(SelfRegDomains.safeParse(['bad..com']).success).toBe(false)
    expect(SelfRegDomains.safeParse([''].map(() => 'a.com')).success).toBe(true)
  })

  it('ClientCreate/Update carry the field; Update can clear it with null', () => {
    expect(
      ClientCreate.safeParse({ name: 'Acme', selfRegDomains: ['a.com'] }).success,
    ).toBe(true)
    expect(ClientCreate.safeParse({ name: 'Acme' }).success).toBe(true)
    expect(ClientUpdate.parse({ selfRegDomains: null }).selfRegDomains).toBeNull()
    expect(ClientUpdate.parse({ selfRegDomains: ['a.com'] }).selfRegDomains).toEqual(['a.com'])
  })
})
