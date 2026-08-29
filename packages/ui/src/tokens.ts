export const fontMono =
  "'JetBrains Mono', 'SF Mono', 'Consolas', 'Fira Code', monospace"

export const fontSans =
  "'Inter', -apple-system, 'Segoe UI', 'Helvetica Neue', Arial, sans-serif"

export const consoleTheme = {
  name: 'console',
  background: '#0a0e14',
  surface: '#11161f',
  border: '#1d2530',
  text: '#c5cdd9',
  textDim: '#5c6773',
  accent: '#4fd6be',
  ok: '#3fb950',
  warn: '#d29922',
  error: '#f85149',
  font: fontMono,
} as const

export type ConsoleTheme = typeof consoleTheme
