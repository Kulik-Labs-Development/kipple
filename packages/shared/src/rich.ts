// Rich-text helpers shared between web (rendering) and api (email egress).
// Web stores sanitized HTML in update bodies; the email transport is plain
// text, so egress strips HTML to a readable plain-text version.

const HTML_TAG =
  /<(?:p|div|br|hr|strong|em|u|s|del|code|pre|blockquote|h[1-4]|ul|ol|li|a|span|img)[\s>/]/i

export function isHtmlBody(body: string): boolean {
  return HTML_TAG.test(body)
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
}

function decodeEntities(text: string): string {
  let out = text
  for (const [entity, char] of Object.entries(ENTITIES)) {
    out = out.split(entity).join(char)
  }
  return out.replace(/&#(\d+);/g, (_match, code: string) => {
    const n = Number(code)
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''
  })
}

// Flatten HTML to a readable plain-text version for email egress: block
// boundaries become newlines, inline content stays inline, entities decode.
export function htmlToText(html: string): string {
  if (!isHtmlBody(html)) return html
  let text = html
  // Tight lists: consecutive list items stay on separate lines, not
  // separated by a blank line.
  text = text.replace(/<\/li>\s*<li\b[^>]*>/gi, '\n')
  text = text.replace(/<br\s*\/?\s*>/gi, '\n')
  text = text.replace(/<(?:h[1-6]|p|div|li|blockquote|ul|ol|pre|tr)\b[^>]*>/gi, '\n')
  text = text.replace(/<\/(?:h[1-6]|p|div|li|blockquote|ul|ol|pre|tr)\b[^>]*>/gi, '\n')
  text = text.replace(/<[^>]+>/g, '')
  text = decodeEntities(text)
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
