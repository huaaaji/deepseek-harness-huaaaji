import { describe, expect, it } from 'vitest'
import { buildWindow, langFromPath } from '../src/read.ts'

describe('langFromPath', () => {
  it('maps a known extension to its language hint', () => {
    expect(langFromPath('/src/foo.ts')).toBe('ts')
    expect(langFromPath('C:\\code\\app.py')).toBe('py')
    expect(langFromPath('readme.md')).toBe('md')
  })

  it('is case-insensitive on the extension', () => {
    expect(langFromPath('Foo.JSON')).toBe('json')
  })

  it('returns undefined for a dotfile, an unknown extension, and no extension', () => {
    expect(langFromPath('/.gitignore')).toBeUndefined()
    expect(langFromPath('/foo.xyzzy')).toBeUndefined()
    expect(langFromPath('/Makefile')).toBeUndefined()
  })
})

describe('buildWindow', () => {
  it('numbers every line from the whole text', async () => {
    const result = await buildWindow(['a\nb\nc'], { offset: 1, limit: 10, maxLineLength: 100, maxBytes: 1000 }, '/f')
    expect(result).toEqual({
      lines: [
        { number: 1, text: 'a' },
        { number: 2, text: 'b' },
        { number: 3, text: 'c' },
      ],
      totalLines: 3,
      truncatedByBytes: false,
    })
  })

  it('honors a 1-based offset window', async () => {
    const result = await buildWindow(['a\nb\nc\nd'], { offset: 2, limit: 2, maxLineLength: 100, maxBytes: 1000 }, '/f')
    expect(result.lines).toEqual([
      { number: 2, text: 'b' },
      { number: 3, text: 'c' },
    ])
    expect(result.totalLines).toBe(4)
  })

  it('strips carriage returns from CRLF line endings', async () => {
    const result = await buildWindow(['a\r\nb\r\n'], { offset: 1, limit: 10, maxLineLength: 100, maxBytes: 1000 }, '/f')
    expect(result.lines).toEqual([
      { number: 1, text: 'a' },
      { number: 2, text: 'b' },
    ])
  })

  it('keeps a trailing empty line out of a newline-terminated file', async () => {
    const result = await buildWindow(['a\n'], { offset: 1, limit: 10, maxLineLength: 100, maxBytes: 1000 }, '/f')
    expect(result.totalLines).toBe(1)
    expect(result.lines).toEqual([{ number: 1, text: 'a' }])
  })

  it('truncates an oversized single line with a suffix', async () => {
    const result = await buildWindow(['x'.repeat(10)], { offset: 1, limit: 10, maxLineLength: 5, maxBytes: 1000 }, '/f')
    expect(result.lines[0]?.text).toBe('xxxxx... (line truncated to 5 chars)')
  })

  it('marks the byte cap and stops emitting lines past it', async () => {
    const result = await buildWindow(['a\nbb\nccc\n'], { offset: 1, limit: 10, maxLineLength: 100, maxBytes: 4 }, '/f')
    expect(result.truncatedByBytes).toBe(true)
    expect(result.lines.map(line => line.text)).toEqual(['a', 'bb'])
    expect(result.totalLines).toBe(3)
  })

  it('throws an out-of-range offset for a non-empty file', async () => {
    await expect(buildWindow(['a\n'], { offset: 5, limit: 10, maxLineLength: 100, maxBytes: 1000 }, '/f'))
      .rejects.toThrow('offset 5 is out of range')
  })

  it('accepts offset 1 for an empty file', async () => {
    const result = await buildWindow([''], { offset: 1, limit: 10, maxLineLength: 100, maxBytes: 1000 }, '/f')
    expect(result.lines).toEqual([])
    expect(result.totalLines).toBe(0)
  })
})
