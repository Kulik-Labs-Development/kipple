import { describe, expect, it } from 'vitest'
import { htmlToText, isHtmlBody } from './rich'

describe('isHtmlBody', () => {
  it('detects html bodies', () => {
    expect(isHtmlBody('<p>hello</p>')).toBe(true)
    expect(isHtmlBody('see <code>x</code> now')).toBe(true)
    expect(isHtmlBody('a<br>b')).toBe(true)
  })

  it('does not flag plain text with angle characters', () => {
    expect(isHtmlBody('hello world')).toBe(false)
    expect(isHtmlBody('a < b and c > d')).toBe(false)
    expect(isHtmlBody('3 <5 is wrong')).toBe(false)
    expect(isHtmlBody('the <tag> word')).toBe(false)
  })
})

describe('htmlToText', () => {
  it('passes plain text through unchanged', () => {
    expect(htmlToText('plain body\nwith a newline')).toBe('plain body\nwith a newline')
  })

  it('flattens blocks to newlines and strips tags', () => {
    const html =
      '<h2>Title</h2><p>Line <strong>bold</strong> &amp; more</p><ul><li>one</li><li>two</li></ul>'
    const text = htmlToText(html)
    expect(text).toBe('Title\n\nLine bold & more\n\none\ntwo')
    expect(text).not.toContain('<')
  })

  it('keeps pre contents on separate lines', () => {
    expect(htmlToText('<pre>line1\nline2</pre>')).toBe('line1\nline2')
  })

  it('decodes named and numeric entities', () => {
    expect(htmlToText('<p>a &#65; &amp; b</p>')).toBe('a A & b')
  })
})
