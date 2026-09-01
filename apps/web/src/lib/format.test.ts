import { describe, expect, it } from 'vitest'
import { formatFileSize } from './format'

describe('formatFileSize', () => {
  it('renders bytes below 1 KB as B', () => {
    expect(formatFileSize(0)).toBe('0 B')
    expect(formatFileSize(1)).toBe('1 B')
    expect(formatFileSize(512)).toBe('512 B')
    expect(formatFileSize(1023)).toBe('1023 B')
  })

  it('renders KB with one decimal below 1 MB', () => {
    expect(formatFileSize(1024)).toBe('1 KB')
    expect(formatFileSize(1536)).toBe('1.5 KB')
    expect(formatFileSize(102380)).toBe('100 KB')
  })

  it('renders MB below 1 GB', () => {
    expect(formatFileSize(1024 ** 2)).toBe('1 MB')
    expect(formatFileSize(5 * 1024 ** 2)).toBe('5 MB')
    expect(formatFileSize(2.5 * 1024 ** 2)).toBe('2.5 MB')
  })

  it('renders GB at 1 GB and above', () => {
    expect(formatFileSize(1024 ** 3)).toBe('1 GB')
    expect(formatFileSize(2.25 * 1024 ** 3)).toBe('2.3 GB')
  })
})
