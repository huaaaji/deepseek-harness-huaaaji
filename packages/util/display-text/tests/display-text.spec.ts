import { describe, expect, it } from 'vitest'
import {
  normalizeDisplayText,
  sanitizeDisplayText,
  truncateDisplayTextUtf8,
} from '@deepseek-ai/dsh-display-text'

describe('sanitizeDisplayText', () => {
  it('removes OSC sequences however they terminate', () => {
    expect(sanitizeDisplayText('\u001B]0;stolen\u0007visible')).toBe('visible')
    expect(sanitizeDisplayText('\u001B]8;;http://x\u001B\\link')).toBe('link')
    expect(sanitizeDisplayText('tail\u001B]0;unterminated')).toBe('tail')
    expect(sanitizeDisplayText('c1\u009Dtitle\u0007after')).toBe('c1after')
  })

  it('removes CSI sequences from both introducers', () => {
    expect(sanitizeDisplayText('\u001B[31mred\u001B[0m')).toBe('red')
    expect(sanitizeDisplayText('a\u009B1mb')).toBe('ab')
  })

  it('removes short ESC sequences and BEL', () => {
    expect(sanitizeDisplayText('a\u001BMb')).toBe('ab')
    expect(sanitizeDisplayText('ring\u0007bell')).toBe('ringbell')
  })

  it('removes C0 and C1 controls', () => {
    expect(sanitizeDisplayText('a\u0000b\u0008c\u000Bd\u000Ce\u001Ff\u007Fg\u0085h\u009Fi')).toBe('abcdefghi')
  })

  it('removes invisible and directional controls', () => {
    expect(sanitizeDisplayText('safe\u200B\u200E\u200F\u202A\u202E\u2060\u2064\u2066\u206F\uFEFFtext'))
      .toBe('safetext')
  })

  it('collapses whitespace to one trimmed line', () => {
    expect(sanitizeDisplayText('  one\ttwo\nthree   four  ')).toBe('one two three four')
  })
})

describe('truncateDisplayTextUtf8', () => {
  it('returns input unchanged when it already fits the budget', () => {
    expect(truncateDisplayTextUtf8('abc', 3)).toBe('abc')
  })

  it('bounds ASCII without exceeding the byte budget', () => {
    expect(truncateDisplayTextUtf8('abcdef', 4)).toBe('abcd')
  })

  it('bounds CJK text without splitting a code point', () => {
    expect(truncateDisplayTextUtf8('你好世界', 7)).toBe('你好')
    expect(truncateDisplayTextUtf8('你好世界', 9)).toBe('你好世')
  })

  it('bounds astral emoji without splitting a code point', () => {
    const truncated = truncateDisplayTextUtf8('😀😀', 5)
    expect(truncated).toBe('😀')
    expect(Buffer.byteLength(truncated, 'utf8')).toBe(4)
  })

  it('rejects non-positive and fractional budgets', () => {
    expect(() => truncateDisplayTextUtf8('text', 0)).toThrow(/maxBytes must be a positive integer/)
    expect(() => truncateDisplayTextUtf8('text', -1)).toThrow(/maxBytes must be a positive integer/)
    expect(() => truncateDisplayTextUtf8('text', 1.5)).toThrow(/maxBytes must be a positive integer/)
    expect(() => truncateDisplayTextUtf8('text', Number.NaN)).toThrow(/maxBytes must be a positive integer/)
  })
})

describe('normalizeDisplayText', () => {
  it('sanitizes then bounds one display line', () => {
    expect(normalizeDisplayText('\u001B]0;stolen\u0007  Completed\t the\nmigration  ', 200))
      .toBe('Completed the migration')
    expect(normalizeDisplayText('  completed the migration  ', 10)).toBe('completed')
  })

  it('returns an empty string when nothing visible remains', () => {
    expect(normalizeDisplayText('\u001B[31m\u0007\u200B  ', 40)).toBe('')
    expect(sanitizeDisplayText('\u0000\u0001')).toBe('')
  })

  it('rejects an invalid budget before sanitizing', () => {
    expect(() => normalizeDisplayText('text', 0)).toThrow(/maxBytes must be a positive integer/)
  })
})
