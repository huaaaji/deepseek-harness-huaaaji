import { describe, expect, it } from 'vitest'
import {
  failureOf, parseHeadTeaser, parsePorcelainV2,
} from '../src/git.ts'

describe('failureOf', () => {
  it('reports git-unavailable for an ENOENT spawn error', () => {
    const outcome = {
      code: null, signal: null, stdout: '', stderr: '',
      spawnError: Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }) as NodeJS.ErrnoException,
    }
    expect(failureOf(outcome, 'fallback')).toEqual({
      code: 'git-unavailable',
      message: 'spawn git ENOENT',
    })
  })

  it('reports timeout when the child was killed by a signal', () => {
    const outcome = {
      code: null, signal: 'SIGKILL' as NodeJS.Signals, stdout: '', stderr: '', spawnError: null,
    }
    expect(failureOf(outcome, 'fallback').code).toBe('timeout')
  })

  it('reports not-a-repo for a non-zero exit', () => {
    const outcome = {
      code: 128, signal: null, stdout: '', stderr: 'fatal: not a git repository', spawnError: null,
    }
    expect(failureOf(outcome, 'fallback')).toEqual({
      code: 'not-a-repo',
      message: 'fatal: not a git repository',
    })
  })

  it('falls back to the git-error code for a zero exit', () => {
    const outcome = {
      code: 0, signal: null, stdout: '', stderr: '', spawnError: null,
    }
    expect(failureOf(outcome, 'fallback')).toEqual({
      code: 'git-error',
      message: 'fallback',
    })
  })
})

describe('parsePorcelainV2', () => {
  it('parses branch headers including ahead/behind and detached heads', () => {
    const parsed = parsePorcelainV2([
      '# branch.oid abc123def4567890',
      '# branch.head feature/panel',
      '# branch.upstream origin/feature/panel',
      '# branch.ab +3 -1',
    ].join('\n'))
    expect(parsed.branch).toEqual({
      oid: 'abc123def4567890',
      name: 'feature/panel',
      upstream: 'origin/feature/panel',
      ahead: 3,
      behind: 1,
    })
  })

  it('treats an unborn branch and a detached head as nulls', () => {
    const parsed = parsePorcelainV2([
      '# branch.oid (initial)',
      '# branch.head (detached)',
    ].join('\n'))
    expect(parsed.branch.oid).toBeNull()
    expect(parsed.branch.name).toBeNull()
  })

  it('parses staged, unstaged, and combined regular entries', () => {
    const parsed = parsePorcelainV2([
      '1 M. N... 100644 100644 100644 0000000 1111111 src/a.ts',
      '1 .M N... 100644 100644 100644 1111111 2222222 src/b.ts',
      '1 MM N... 100644 100644 100644 1111111 3333333 src/c.ts',
      '1 A. N... 000000 100644 100644 0000000 4444444 src/new.ts',
      '1 .D N... 100644 100644 100644 5555555 0000000 src/gone.ts',
    ].join('\n'))
    expect(parsed.entries).toEqual([
      { path: 'src/a.ts', oldPath: null, state: 'modified', staged: true },
      { path: 'src/b.ts', oldPath: null, state: 'modified', staged: false },
      { path: 'src/c.ts', oldPath: null, state: 'modified', staged: true },
      { path: 'src/new.ts', oldPath: null, state: 'added', staged: true },
      { path: 'src/gone.ts', oldPath: null, state: 'deleted', staged: false },
    ])
  })

  it('parses rename records with new and original paths', () => {
    const parsed = parsePorcelainV2([
      '2 R. N... 100644 100644 100644 1111111 2222222 R100 new/name.ts\told/name.ts',
    ].join('\n'))
    expect(parsed.entries).toEqual([
      { path: 'new/name.ts', oldPath: 'old/name.ts', state: 'renamed', staged: true },
    ])
  })

  it('falls back to the arrow separator for tab-less rename lines', () => {
    const parsed = parsePorcelainV2([
      '2 R. N... 100644 100644 100644 1111111 2222222 R100 new/name.ts -> old/name.ts',
    ].join('\n'))
    expect(parsed.entries[0]?.path).toBe('new/name.ts')
    expect(parsed.entries[0]?.oldPath).toBe('old/name.ts')
  })

  it('parses unmerged and untracked records', () => {
    const parsed = parsePorcelainV2([
      'u UU N... 100644 100644 100644 100644 1111111 2222222 3333333 conflict.ts',
      '? untracked-dir/',
      '? also untracked file.ts',
    ].join('\n'))
    expect(parsed.entries).toEqual([
      { path: 'conflict.ts', oldPath: null, state: 'conflicted', staged: false },
      { path: 'untracked-dir/', oldPath: null, state: 'untracked', staged: false },
      { path: 'also untracked file.ts', oldPath: null, state: 'untracked', staged: false },
    ])
  })

  it('keeps paths with spaces verbatim', () => {
    const parsed = parsePorcelainV2('1 M. N... 100644 100644 100644 0000000 1111111 docs/my file.md')
    expect(parsed.entries[0]?.path).toBe('docs/my file.md')
  })

  it('ignores unrelated header lines', () => {
    const parsed = parsePorcelainV2('# unexpected header\n1 M. N... 100644 100644 100644 0000000 1111111 a.ts')
    expect(parsed.branch.ahead).toBe(0)
    expect(parsed.entries).toHaveLength(1)
  })

  it('ignores malformed header lines', () => {
    const parsed = parsePorcelainV2([
      '# no-value-header',
      '# branch.ab +x -y',
      '# branch.unknown whatever',
    ].join('\n'))
    expect(parsed.branch).toEqual({ oid: null, name: null, upstream: null, ahead: 0, behind: 0 })
  })

  it('drops malformed record lines instead of guessing', () => {
    const parsed = parsePorcelainV2([
      '1 M',
      '1 .',
      '1 M. N...',
      '2 R',
      '2 R. N... 100644 100644',
      '2 R. N... 100644 100644 100644 1111111 2222222 R100 lonely-path',
      'u UU N... 100644',
    ].join('\n'))
    expect(parsed.entries).toEqual([])
  })

  it('classifies copy, type-change, and U-letter statuses', () => {
    const parsed = parsePorcelainV2([
      '1 C. N... 100644 100644 100644 1111111 2222222 copied.ts',
      '1 .T N... 100644 100644 100644 1111111 2222222 type.ts',
      '1 U. N... 100644 100644 100644 1111111 2222222 staged-conflict.ts',
    ].join('\n'))
    expect(parsed.entries).toEqual([
      { path: 'copied.ts', oldPath: null, state: 'added', staged: true },
      { path: 'type.ts', oldPath: null, state: 'modified', staged: false },
      { path: 'staged-conflict.ts', oldPath: null, state: 'conflicted', staged: false },
    ])
  })
})

describe('parseHeadTeaser', () => {
  it('splits hash and subject on the unit separator', () => {
    expect(parseHeadTeaser('abc1234\x1ffix the thing')).toEqual({
      shortHash: 'abc1234',
      subject: 'fix the thing',
    })
  })

  it('rejects malformed lines', () => {
    expect(parseHeadTeaser('no separator')).toBeNull()
    expect(parseHeadTeaser('')).toBeNull()
    expect(parseHeadTeaser('\x1fsubject-only')).toBeNull()
    expect(parseHeadTeaser('hash-only\x1f')).toBeNull()
  })
})
