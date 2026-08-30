import { z } from 'zod'

export const ColorMode = z.enum(['light', 'dark', 'system'])
export type ColorMode = z.infer<typeof ColorMode>

export const ThemeId = z.enum(['console', 'graphite', 'slate', 'blush'])
export type ThemeId = z.infer<typeof ThemeId>

export type ThemeSurface = 'agent' | 'portal'

export interface ThemeMeta {
  id: ThemeId
  label: string
  description: string
  surfaces: ThemeSurface[]
  defaultMode: 'light' | 'dark'
}

export const THEMES: ThemeMeta[] = [
  {
    id: 'console',
    label: 'Console',
    description: 'Dark, monospace, terminal-style. The agent workspace default.',
    surfaces: ['agent'],
    defaultMode: 'dark',
  },
  {
    id: 'graphite',
    label: 'Graphite',
    description: 'Neutral dark, monospace. A quieter console.',
    surfaces: ['agent'],
    defaultMode: 'dark',
  },
  {
    id: 'slate',
    label: 'Slate',
    description: 'Clean sans-serif theme for the client portal, light and dark.',
    surfaces: ['portal'],
    defaultMode: 'light',
  },
  {
    id: 'blush',
    label: 'Blush',
    description: 'Warm pink palette in light and dark, for agents and the portal.',
    surfaces: ['agent', 'portal'],
    defaultMode: 'light',
  },
]

export const PreferencesPatch = z
  .object({
    theme: ThemeId.nullable().optional(),
    colorMode: ColorMode.optional(),
  })
  .refine((p) => p.theme !== undefined || p.colorMode !== undefined, {
    message: 'provide theme or colorMode',
  })
export type PreferencesPatch = z.infer<typeof PreferencesPatch>
