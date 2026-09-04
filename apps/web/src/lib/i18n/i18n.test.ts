import { describe, expect, it, vi } from 'vitest'
import { en } from './en'
import { translate } from './index'

describe('i18n core (#141)', () => {
  it('resolves a plain key from the catalog', () => {
    expect(translate('en', 'login.tab.client')).toBe(en['login.tab.client'])
  })

  it('resolves the static before/after halves (no tokens — the styled span sits between them)', () => {
    expect(translate('en', 'login.linkSent.before')).toBe(en['login.linkSent.before'])
    expect(translate('en', 'login.linkSent.after')).toBe(en['login.linkSent.after'])
  })

  it('interpolates {param} tokens', () => {
    expect(translate('en', 'queue.sla.label', { state: 'breached' })).toBe('sla breached')
  })

  it('leaves a token intact when its param is absent', () => {
    expect(translate('en', 'queue.sla.label')).toBe('sla {state}')
  })

  it('interpolates only the params it is given', () => {
    expect(translate('en', 'queue.sla.label', { other: 'x' })).toBe('sla {state}')
  })

  it('interpolates a token inside a longer template', () => {
    expect(translate('en', 'portal.title.withClient', { client: 'Contoso Ltd.' })).toBe(
      'Contoso Ltd. · Client Portal',
    )
  })

  it('warns and returns the key itself on a runtime miss (visible, not fatal)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(translate('en', 'nope.missing' as never)).toBe('nope.missing')
      expect(warn).toHaveBeenCalledOnce()
    } finally {
      warn.mockRestore()
    }
  })
})
