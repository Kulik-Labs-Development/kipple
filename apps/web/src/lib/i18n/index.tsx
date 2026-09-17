import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { en, type I18nKey } from './en'

// Shared status word map — the filter chips and status displays use the same
// keys (a status is one word, wherever it appears).
export const STATUS_KEY: Record<
  'all' | 'open' | 'pending' | 'hold' | 'closed',
  I18nKey
> = {
  all: 'status.all',
  open: 'status.open',
  pending: 'status.pending',
  hold: 'status.hold',
  closed: 'status.closed',
}

export type Locale = 'en'
export type I18nParams = Record<string, string | number>

const CATALOGS: Record<Locale, Record<I18nKey, string>> = { en }

/**
 * Pure translation core (locale-bound, no React) — the unit-tested half.
 *
 * - `{param}` tokens are interpolated from `params`; a token with no matching
 *   param is left intact (visible, not fatal — same posture as a missing
 *   image, not a crash).
 * - A key missing at runtime (unrepresentable against `I18nKey` — e.g. a
 *   stale bundle) warns and returns the key itself.
 * - v1 is intentionally small: no plural engine, no locale negotiation.
 *   Real locales will add those here, not at the call sites.
 */
export function translate(
  locale: Locale,
  key: I18nKey,
  params?: I18nParams,
): string {
  const template = CATALOGS[locale][key]
  if (template === undefined) {
    console.warn(`[i18n] missing key in ${locale}: ${String(key)}`)
    return String(key)
  }
  if (!params) return template
  return template.replace(/\{(\w+)\}/g, (token, name: string) =>
    name in params ? String(params[name]) : token,
  )
}

interface I18nValue {
  locale: Locale
  t: (key: I18nKey, params?: I18nParams) => string
}

const I18nContext = createContext<I18nValue | null>(null)

/**
 * The locale seam (#141). En-only today; the provider is where the locale
 * choice lands when it exists (user preference / instance setting) —
 * components consume `useI18n()`, never the catalog, so that day touches
 * this file and nothing else.
 */
export function I18nProvider({
  locale = 'en',
  children,
}: {
  locale?: Locale
  children: ReactNode
}) {
  const value = useMemo<I18nValue>(
    () => ({ locale, t: (key, params) => translate(locale, key, params) }),
    [locale],
  )
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used inside <I18nProvider>')
  return ctx
}

export type { I18nKey }
