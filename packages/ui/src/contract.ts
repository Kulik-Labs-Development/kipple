export const THEME_TOKENS = [
  '--color-ink',
  '--color-panel',
  '--color-line',
  '--color-fg',
  '--color-dim',
  '--color-accent',
  '--color-ok',
  '--color-warn',
  '--color-danger',
  '--font-app',
  '--font-mono',
  '--font-sans',
  '--radius-app',
] as const

export type ThemeToken = (typeof THEME_TOKENS)[number]
