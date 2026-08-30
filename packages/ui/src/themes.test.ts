import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { THEMES } from '@kipple/shared'
import { THEME_TOKENS } from './contract'

const themesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../themes')

function modeBlocks(css: string): Record<string, string> {
  const out: Record<string, string> = {}
  const re = /:root\[data-theme='([a-z]+)'\]\[data-mode='(light|dark)'\]\s*\{([\s\S]*?)\}/g
  let match: RegExpExecArray | null
  while ((match = re.exec(css)) !== null) {
    out[`${match[1]}:${match[2]}`] = match[3]
  }
  return out
}

describe('theme registry', () => {
  const files = readdirSync(themesDir).filter(
    (f) => f.endsWith('.css') && f !== 'themes.css',
  )
  const ids = files.map((f) => f.replace(/\.css$/, ''))

  it('every registered theme has a CSS file, and every CSS file is registered', () => {
    expect([...ids].sort()).toEqual(THEMES.map((t) => t.id).sort())
  })

  it('theme ids are unique', () => {
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length)
  })

  it('every theme defines all contract tokens in both light and dark modes', () => {
    for (const id of ids) {
      const css = readFileSync(path.join(themesDir, `${id}.css`), 'utf8')
      for (const mode of ['light', 'dark'] as const) {
        const block = modeBlocks(css)[`${id}:${mode}`]
        expect(block, `${id} missing ${mode} block`).toBeDefined()
        for (const token of THEME_TOKENS) {
          expect(block, `${id} ${mode} missing ${token}`).toContain(token)
        }
      }
    }
  })
})
