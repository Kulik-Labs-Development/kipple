import type { ColorMode } from '@kipple/shared'

const STORAGE_KEY = 'kipple.theme'

export interface ThemeChoice {
  theme: string
  colorMode: ColorMode
  accent?: string | null
}

export function resolveMode(colorMode: ColorMode): 'light' | 'dark' {
  if (colorMode !== 'system') return colorMode
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function applyTheme(choice: ThemeChoice): void {
  document.documentElement.dataset.theme = choice.theme
  document.documentElement.dataset.mode = resolveMode(choice.colorMode)
  if (choice.accent) {
    document.documentElement.style.setProperty('--color-accent', choice.accent)
  } else {
    document.documentElement.style.removeProperty('--color-accent')
  }
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

export interface ClientBrandingChoice {
  themeId?: string | null
  accent?: string | null
}

// Theme precedence: user preference > fallback, where the fallback is
// branding > instance (portal default) for contacts and the agent default
// (company setting, built-in console) for staff.
// Accent comes from client branding only and applies to the portal (contacts).
export function resolveThemeChoice(
  preferences: { theme: string | null; colorMode: ColorMode },
  instanceTheme: string,
  role: string,
  branding: ClientBrandingChoice | null = null,
  agentDefault: string = 'console',
): ThemeChoice {
  const fallback = role === 'contact' ? branding?.themeId ?? instanceTheme : agentDefault
  return {
    theme: preferences.theme ?? fallback,
    colorMode: preferences.colorMode,
    accent: role === 'contact' ? branding?.accent ?? null : null,
  }
}

export function watchSystemScheme(onChange: (dark: boolean) => void): void {
  window
    .matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', (event) => onChange(event.matches))
}
