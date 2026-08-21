import { describe, expect, it } from 'vitest'
import { FsError } from '@deepseek-ai/dsh-fs'
import { failureCode, failureOf, resolveLimit, resolveOffset } from '../src/failure.ts'
import { DEFAULT_MAX_LINES } from '../src/read.ts'

describe('failureCode', () => {
  it('maps every named filesystem code to the wire vocabulary', () => {
    expect(failureCode('FS_NOT_FOUND')).toBe('not-found')
    expect(failureCode('FS_NOT_DIRECTORY')).toBe('not-directory')
    expect(failureCode('FS_NOT_TEXT')).toBe('not-text')
    expect(failureCode('FS_NOT_REGULAR_FILE')).toBe('not-regular-file')
    expect(failureCode('FS_TOO_LARGE')).toBe('too-large')
    expect(failureCode('FS_PERMISSION_DENIED')).toBe('permission-denied')
    expect(failureCode('FS_SANDBOX_DENIED')).toBe('sandbox-denied')
    expect(failureCode('FS_ABORTED')).toBe('aborted')
  })

  it('collapses every other code to io-error', () => {
    expect(failureCode('FS_IO_ERROR')).toBe('io-error')
    expect(failureCode('FS_STALE_VERSION')).toBe('io-error')
    expect(failureCode('FS_NOT_OBSERVED')).toBe('io-error')
    expect(failureCode('FS_AMBIGUOUS_EDIT')).toBe('io-error')
    expect(failureCode('FS_EDIT_NOT_FOUND')).toBe('io-error')
  })
})

describe('failureOf', () => {
  it('maps an FsError through its code', () => {
    expect(failureOf(new FsError('gone', 'FS_NOT_FOUND'))).toEqual({ code: 'not-found', message: 'gone' })
  })

  it('maps a plain Error to io-error', () => {
    expect(failureOf(new Error('boom'))).toEqual({ code: 'io-error', message: 'boom' })
  })

  it('stringifies a non-Error value', () => {
    expect(failureOf('oops')).toEqual({ code: 'io-error', message: 'oops' })
  })
})

describe('resolveOffset', () => {
  it('keeps a positive integer', () => {
    expect(resolveOffset(3)).toBe(3)
    expect(resolveOffset(1)).toBe(1)
  })

  it('defaults an invalid offset to 1', () => {
    expect(resolveOffset(0)).toBe(1)
    expect(resolveOffset(-2)).toBe(1)
    expect(resolveOffset(1.5)).toBe(1)
    expect(resolveOffset(Number.NaN)).toBe(1)
  })
})

describe('resolveLimit', () => {
  it('keeps a valid limit within the cap', () => {
    expect(resolveLimit(10, DEFAULT_MAX_LINES)).toBe(10)
  })

  it('clamps an over-cap limit', () => {
    expect(resolveLimit(DEFAULT_MAX_LINES + 1, DEFAULT_MAX_LINES)).toBe(DEFAULT_MAX_LINES)
  })

  it('defaults an invalid limit to the cap', () => {
    expect(resolveLimit(0, DEFAULT_MAX_LINES)).toBe(DEFAULT_MAX_LINES)
    expect(resolveLimit(-1, DEFAULT_MAX_LINES)).toBe(DEFAULT_MAX_LINES)
    expect(resolveLimit(1.5, DEFAULT_MAX_LINES)).toBe(DEFAULT_MAX_LINES)
    expect(resolveLimit(Number.NaN, DEFAULT_MAX_LINES)).toBe(DEFAULT_MAX_LINES)
  })
})
