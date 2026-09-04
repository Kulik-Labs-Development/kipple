import { describe, expect, it } from 'vitest'
import {
  DEFAULT_UPLOAD_SETTINGS,
  UploadMimePattern,
  UploadSettings,
  UploadSettingsPatch,
  mimeAllowed,
} from './schemas'

describe('upload settings (shared)', () => {
  it('accepts exact MIME patterns and type wildcards', () => {
    expect(UploadMimePattern.parse('application/pdf')).toBe('application/pdf')
    expect(UploadMimePattern.parse('Image/*')).toBe('image/*')
    expect(UploadMimePattern.parse('text/plain')).toBe('text/plain')
  })

  it('rejects garbage patterns', () => {
    for (const bad of ['pdf', 'image/', '*', 'im age/*', 'a'.repeat(129) + '/*']) {
      expect(UploadMimePattern.safeParse(bad).success).toBe(false)
    }
  })

  it('settings + patch bounds', () => {
    expect(UploadSettings.parse({ maxMb: 1, allowedMimes: [] })).toEqual({
      maxMb: 1,
      allowedMimes: [],
    })
    expect(UploadSettings.safeParse({ maxMb: 0, allowedMimes: [] }).success).toBe(false)
    expect(UploadSettings.safeParse({ maxMb: 4097, allowedMimes: [] }).success).toBe(false)
    expect(UploadSettingsPatch.parse({ maxMb: 100 })).toEqual({ maxMb: 100 })
    expect(UploadSettingsPatch.parse({ allowedMimes: ['image/*'] })).toEqual({
      allowedMimes: ['image/*'],
    })
    expect(UploadSettingsPatch.parse({})).toEqual({})
  })

  it('defaults = env v1 defaults + open allowlist', () => {
    expect(DEFAULT_UPLOAD_SETTINGS).toEqual({ maxMb: 25, allowedMimes: [] })
  })

  describe('mimeAllowed', () => {
    it('empty pattern list allows everything', () => {
      expect(mimeAllowed('application/pdf', [])).toBe(true)
      expect(mimeAllowed('image/png', [])).toBe(true)
    })

    it('exact match is case-insensitive', () => {
      expect(mimeAllowed('Application/PDF', ['application/pdf'])).toBe(true)
      expect(mimeAllowed('application/pdf', ['APPLICATION/PDF'])).toBe(true)
      expect(mimeAllowed('application/json', ['application/pdf'])).toBe(false)
    })

    it('type wildcards match any subtype, not lookalikes', () => {
      expect(mimeAllowed('image/png', ['image/*'])).toBe(true)
      expect(mimeAllowed('image/svg+xml', ['image/*'])).toBe(true)
      expect(mimeAllowed('text/html', ['image/*'])).toBe(false)
      // 'text/*' must not swallow 'textile/plain' (the prefix is 'text/',
      // not 'text')
      expect(mimeAllowed('textile/plain', ['text/*'])).toBe(false)
    })

    it('multiple patterns + empty mime', () => {
      expect(mimeAllowed('audio/ogg', ['image/*', 'audio/ogg'])).toBe(true)
      expect(mimeAllowed('', ['image/*'])).toBe(false)
    })
  })
})
