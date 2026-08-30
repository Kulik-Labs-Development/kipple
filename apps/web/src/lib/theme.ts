import type { ColorMode } from '@kipple/shared'

const STORAGE_KEY = 'kipple.theme'

export interface ThemeChoice {
  theme: string
  colorMode: ColorMode
}

export function resolveMode(colorMode: ColorMode): 'light' | 'dark' {
  if (colorMode !== 'system') return colorMode
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyTheme(choice: ThemeChoice): void {
  document.documentElement.dataset.theme = choice.theme
  document.documentElement.dataset.mode = resolveMode(choice.colorMode)
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(choice))
  } catch {
    /* noop */
  }
}

export function applyStoredTheme(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return
    const saved = JSON.parse(raw) as Partial<ThemeChoice>
    if (typeof saved.theme === 'string') {
      applyTheme({
        theme: saved.theme,
        colorMode: (saved.colorMode as ColorMode) ?? 'system',
      })
    }
  } catch {
    /* noop */
  }
}

export function resolveThemeChoice(
  preferences: { theme: string | null; colorMode: ColorMode },
  instanceTheme: string,
  role: string,
): ThemeChoice {
  const fallback = role === 'contact' ? instanceTheme : 'console'
  return { theme: preferences.theme ?? fallback, colorMode: preferences.colorMode }
}

export function watchSystemScheme(onChange: (dark: boolean) => void): void {
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', (event) => onChange(event.matches))
}
