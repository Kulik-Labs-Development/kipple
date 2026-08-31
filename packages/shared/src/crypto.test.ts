import { describe, expect, it } from 'vitest'
import { decryptAtRest, encryptAtRest, isEncryptedValue } from './crypto'

const SECRET = 'test-secret-0123456789abcdef0123456789abcdef'

describe('at-rest encryption', () => {
  it('round-trips a value', () => {
    const stored = encryptAtRest('hunter2', SECRET)
    expect(isEncryptedValue(stored)).toBe(true)
    expect(stored).not.toContain('hunter2')
    expect(decryptAtRest(stored, SECRET)).toBe('hunter2')
  })

  it('round-trips unicode and empty strings', () => {
    for (const value of ['über-secret-密码', '']) {
      expect(decryptAtRest(encryptAtRest(value, SECRET), SECRET)).toBe(value)
    }
  })

  it('produces a unique ciphertext per call (random iv)', () => {
    expect(encryptAtRest('same', SECRET)).not.toBe(encryptAtRest('same', SECRET))
  })

  it('passes through values that were not stored encrypted', () => {
    expect(decryptAtRest('plain-text', SECRET)).toBe('plain-text')
  })

  it('rejects a wrong key', () => {
    const stored = encryptAtRest('hunter2', SECRET)
    expect(() => decryptAtRest(stored, 'other-secret-0123456789abcdef0123456789')).toThrow()
  })

  it('rejects malformed values', () => {
    expect(() => decryptAtRest('enc1:garbage', SECRET)).toThrow()
  })
})
