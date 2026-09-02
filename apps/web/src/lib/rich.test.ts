// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { sanitizeHtml, textOfHtml, toRenderable } from './rich'

describe('sanitizeHtml', () => {
  it('keeps the allowed formatting', () => {
    const html =
      '<h2>Plan</h2><p><strong>bold</strong> <em>ital</em> <a href="https://example.com">link</a></p><pre>code</pre><img src="/api/attachments/1" alt="shot"><span class="fs-lg">big</span>'
    const out = sanitizeHtml(html)
    expect(out).toContain('<h2>Plan</h2>')
    expect(out).toContain('<strong>bold</strong>')
    expect(out).toContain('href="https://example.com"')
    expect(out).toContain('class="fs-lg"')
    expect(out).toContain('src="/api/attachments/1"')
    expect(out).toContain('<pre>code</pre>')
  })

  it('strips scripts, handlers, iframes and styles', () => {
    const out = sanitizeHtml(
      '<p>ok</p><script>alert(1)</script><img src="x" onerror="alert(2)"><iframe src="https://evil"></iframe><style>body{display:none}</style>',
    )
    expect(out).not.toContain('<script')
    expect(out).not.toContain('onerror')
    expect(out).not.toContain('<iframe')
    expect(out).not.toContain('<style')
    expect(out).toContain('<p>ok</p>')
  })

  it('strips dangerous uri schemes', () => {
    expect(sanitizeHtml('<a href="javascript:alert(1)">x</a>')).not.toContain('javascript:')
    expect(sanitizeHtml('<img src="data:text/html;base64,AAAA">')).not.toContain('data:')
  })
})

describe('toRenderable', () => {
  it('renders legacy plain text with line breaks', () => {
    expect(toRenderable('line one\nline two')).toBe('line one<br>line two')
  })

  it('escapes plain-text angle brackets and entities', () => {
    expect(toRenderable('a < b > c & d')).toBe('a &lt; b &gt; c &amp; d')
  })

  it('sanitizes html bodies', () => {
    expect(toRenderable('<p>x</p><script>alert(1)</script>')).toBe('<p>x</p>')
  })
})

describe('textOfHtml', () => {
  it('sees through tags', () => {
    expect(textOfHtml('<p>hello <strong>world</strong></p>')).toBe('hello world')
  })

  it('is empty for an empty editor document', () => {
    expect(textOfHtml('<p></p>')).toBe('')
  })
})
