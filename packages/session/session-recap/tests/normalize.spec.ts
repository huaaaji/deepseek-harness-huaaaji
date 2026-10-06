import { describe, expect, it } from 'vitest'
import {
  normalizeRecapEntry,
  normalizeSessionRecap,
  truncateRecapUtf8,
} from '@deepseek-ai/dsh-session-recap'

describe('recap text normalization', () => {
  it('removes terminal escapes and invisible controls, then collapses to one line', () => {
    const input = '\u001B]0;stolen\u0007\u001B[31mStatus\u001B[0m\u0007 ok\nnext\u202E line\u200B'
    expect(normalizeSessionRecap(input, 200)).toBe('Status ok next line')
    expect(normalizeRecapEntry('\u001B]8;;http://x\u001B\\link\u001B]8;;\u001B\\ done', 200)).toBe('link done')
    expect(normalizeRecapEntry('a\u001Bb\u009Bc\u0000d', 200)).toBe('abd')
  })

  it('bounds text to a UTF-8 byte budget without splitting a code point', () => {
    expect(truncateRecapUtf8('abc', 3)).toBe('abc')
    expect(truncateRecapUtf8('abcd', 3)).toBe('abc')
    expect(truncateRecapUtf8('你好世界', 7)).toBe('你好')
    expect(Buffer.byteLength(truncateRecapUtf8('😀😀', 5), 'utf8')).toBe(4)
    expect(normalizeSessionRecap('  completed the migration  ', 10)).toBe('completed')
  })

  it('returns an empty string when nothing visible remains', () => {
    expect(normalizeSessionRecap('\u001B[31m\u0007\u200B  ', 40)).toBe('')
    expect(normalizeRecapEntry('\u0000\u0001', 40)).toBe('')
  })

  it('rejects non-positive and fractional public limits', () => {
    expect(() => truncateRecapUtf8('recap', 0)).toThrow(/maxBytes must be a positive integer/)
    expect(() => truncateRecapUtf8('recap', 1.5)).toThrow(/maxBytes must be a positive integer/)
    expect(() => normalizeSessionRecap('recap', -1)).toThrow(/maxBytes must be a positive integer/)
    expect(() => normalizeRecapEntry('recap', Number.NaN)).toThrow(/maxBytes must be a positive integer/)
  })
})
