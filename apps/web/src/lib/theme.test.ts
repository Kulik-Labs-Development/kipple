import { describe, expect, it } from 'vitest'
import { resolveThemeChoice } from './theme'

const prefs = { theme: null, colorMode: 'system' as const }
const prefsWithTheme = { theme: 'blush', colorMode: 'dark' as const }

describe('resolveThemeChoice', () => {
  it('falls back to the instance theme for contacts without branding', () => {
    expect(resolveThemeChoice(prefs, 'slate', 'contact')).toEqual({
      theme: 'slate',
      colorMode: 'system',
      accent: null,
    })
  })

  it('lets client branding override the instance theme for contacts', () => {
    const choice = resolveThemeChoice(prefs, 'slate', 'contact', {
      themeId: 'blush',
      accent: '#0b5fff',
    })
    expect(choice.theme).toBe('blush')
    expect(choice.accent).toBe('#0b5fff')
  })

  it('keeps the user preference above client branding', () => {
    const choice = resolveThemeChoice(prefsWithTheme, 'slate', 'contact', {
      themeId: 'blush',
      accent: '#0b5fff',
    })
    expect(choice.theme).toBe('blush')
    expect(choice.colorMode).toBe('dark')
  })

  it('passes the branding accent through only for contacts', () => {
    const contact = resolveThemeChoice(prefs, 'slate', 'contact', { accent: '#123456' })
    expect(contact.accent).toBe('#123456')

    const staff = resolveThemeChoice(prefs, 'slate', 'superuser', { accent: '#123456' })
    expect(staff.accent).toBeNull()
    expect(staff.theme).toBe('console')
  })

  it('ignores branding for staff roles entirely', () => {
    const agent = resolveThemeChoice(prefs, 'slate', 'agent', {
      themeId: 'blush',
      accent: '#0b5fff',
    })
    expect(agent.theme).toBe('console')
    expect(agent.accent).toBeNull()
  })
})
