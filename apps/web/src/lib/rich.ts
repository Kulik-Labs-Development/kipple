// Rendering-side helpers for rich update bodies (workspace + portal).
// Bodies may be legacy plain text (pre rich-editor) or sanitized HTML from
// the rich editor; toRenderable() turns either into safe HTML.
import DOMPurify, { type Config } from 'dompurify'
import { isHtmlBody } from '@kipple/shared/rich'

const SANITIZE_CONFIG: Config = {
  ALLOWED_TAGS: [
    'p',
    'br',
    'hr',
    'strong',
    'em',
    'u',
    's',
    'del',
    'code',
    'pre',
    'blockquote',
    'h1',
    'h2',
    'h3',
    'h4',
    'ul',
    'ol',
    'li',
    'a',
    'span',
    'img',
  ],
  ALLOWED_ATTR: ['class', 'href', 'src', 'alt', 'target', 'rel', 'title'],
  FORBID_TAGS: ['style', 'iframe', 'form', 'input', 'button', 'object', 'embed', 'link', 'meta'],
  // http(s) + mailto + absolute app paths (/api/attachments/...) + anchors.
  // data: and javascript: die here.
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|\/|#)/i,
}

// DOMPurify lets data: URIs through for img-like tags even with
// ALLOWED_URI_REGEXP set — strip them (and javascript:) at the attribute
// level so no dangerous scheme survives, whatever the tag.
DOMPurify.addHook('afterSanitizeAttributes', (node: Node) => {
  if (!(node instanceof HTMLElement)) return
  for (const attr of ['src', 'href']) {
    const value = node.getAttribute(attr)
    if (value && /^\s*(?:data|javascript):/i.test(value)) node.removeAttribute(attr)
  }
})

export function sanitizeHtml(html: string): string {
  // DOMPurify's browser typing says TrustedHTML; we render into our own
  // document via dangerouslySetInnerHTML, which accepts the string bytes.
  return DOMPurify.sanitize(html, SANITIZE_CONFIG) as string
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

export function toRenderable(body: string): string {
  if (isHtmlBody(body)) return sanitizeHtml(body)
  return escapeHtml(body).replaceAll('\n', '<br>')
}

// Plain-text view of an html body, for emptiness checks on composer state.
export function textOfHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
