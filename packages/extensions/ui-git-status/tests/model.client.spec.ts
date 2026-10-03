import { describe, expect, it } from 'vitest'
import type {
  GitStatusSnapshot, SessionId, WorkspaceId, WorkspaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import { entriesOf, resolveCwd, summarize } from '../src/client/model.ts'

const workspace = (id: string, path: string, sessionIds: readonly string[] = []): WorkspaceView => ({
  workspaceId: id as WorkspaceId,
  path,
  title: id,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  sessionIds: sessionIds as WorkspaceView['sessionIds'],
})

const snapshot = (entries: readonly GitStatusSnapshot['entries'][number][]): GitStatusSnapshot => ({
  root: '/repo',
  branch: { name: 'main', upstream: 'origin/main', ahead: 1, behind: 0 },
  head: { shortHash: 'abc1234', subject: 'work' },
  counts: {
    staged: entries.filter(entry => entry.staged && entry.state !== 'untracked' && entry.state !== 'conflicted').length,
    unstaged: entries.filter(entry => !entry.staged && entry.state !== 'untracked' && entry.state !== 'conflicted').length,
    untracked: entries.filter(entry => entry.state === 'untracked').length,
    conflicted: entries.filter(entry => entry.state === 'conflicted').length,
  },
  entries,
  failure: null,
})

const ENTRY = {
  added: { path: 'a.ts', oldPath: null, state: 'added', staged: true },
  modified: { path: 'b.ts', oldPath: null, state: 'modified', staged: false },
  stagedModified: { path: 'c.ts', oldPath: null, state: 'modified', staged: true },
  untracked: { path: 'new/', oldPath: null, state: 'untracked', staged: false },
  conflicted: { path: 'conf.ts', oldPath: null, state: 'conflicted', staged: false },
} as const

describe('summarize', () => {
  it('reports clean when there is nothing to show', () => {
    expect(summarize(snapshot([]))).toEqual({ state: 'clean', total: 0 })
  })

  it('reports dirty with the change total', () => {
    expect(summarize(snapshot([ENTRY.modified, ENTRY.untracked]))).toEqual({ state: 'dirty', total: 2 })
  })

  it('lets conflicts dominate the state color', () => {
    expect(summarize(snapshot([ENTRY.modified, ENTRY.conflicted]))).toEqual({ state: 'conflicted', total: 2 })
  })

  it('reports error on failure and ignores counts', () => {
    const failed: GitStatusSnapshot = {
      root: null, branch: null, head: null,
      counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
      entries: [],
      failure: { code: 'not-a-repo', message: 'fatal: not a git repository' },
    }
    expect(summarize(failed)).toEqual({ state: 'error', total: 0 })
  })

  it('reports none before any snapshot arrives', () => {
    expect(summarize(null)).toEqual({ state: 'none', total: 0 })
  })
})

describe('resolveCwd', () => {
  const a = workspace('a', '/repo-a', ['s1'])
  const b = workspace('b', '/repo-b', ['s2'])
  const workspaces = [a, b]

  it('prefers the workspace owning the current session', () => {
    expect(resolveCwd(workspaces, 's2' as SessionId)).toBe('/repo-b')
  })

  it('falls back to the first registered workspace without a session', () => {
    expect(resolveCwd(workspaces, undefined)).toBe('/repo-a')
  })

  it('ignores a session no workspace accounts for', () => {
    expect(resolveCwd(workspaces, 's9' as SessionId)).toBe('/repo-a')
  })

  it('returns null with no registered workspace', () => {
    expect(resolveCwd([], undefined)).toBeNull()
  })
})

describe('entriesOf', () => {
  const full = snapshot([
    ENTRY.added, ENTRY.stagedModified, ENTRY.modified, ENTRY.untracked, ENTRY.conflicted,
  ])

  it('groups conflicted and untracked entries', () => {
    expect(entriesOf(full, 'conflicted').map(entry => entry.path)).toEqual(['conf.ts'])
    expect(entriesOf(full, 'untracked').map(entry => entry.path)).toEqual(['new/'])
  })

  it('splits staged and unstaged by the staging flag', () => {
    expect(entriesOf(full, 'staged').map(entry => entry.path)).toEqual(['a.ts', 'c.ts'])
    expect(entriesOf(full, 'unstaged').map(entry => entry.path)).toEqual(['b.ts'])
  })
})
