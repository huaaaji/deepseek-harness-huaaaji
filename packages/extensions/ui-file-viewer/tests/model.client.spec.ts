import { describe, expect, it } from 'vitest'
import type { SessionId, WorkspaceId, WorkspaceView } from '@deepseek-ai/dsh-api-remotes/client'
import { formatSize, isMarkdown, joinPath, parentOf, resolveCwd } from '../src/client/model.ts'

function ws(workspaceId: string, path: string, sessionIds: readonly string[]): WorkspaceView {
  return { workspaceId: workspaceId as WorkspaceId, path, sessionIds: sessionIds as SessionId[] } as WorkspaceView
}

describe('resolveCwd', () => {
  it('prefers the current session workspace', () => {
    const workspaces = [ws('w1', '/a', ['s1']), ws('w2', '/b', ['s2'])]
    expect(resolveCwd(workspaces, 'w1' as WorkspaceId, 's2' as SessionId)).toBe('/b')
  })

  it('falls back to the recent workspace without a current session', () => {
    const workspaces = [ws('w1', '/a', ['s1']), ws('w2', '/b', ['s2'])]
    expect(resolveCwd(workspaces, 'w2' as WorkspaceId, undefined)).toBe('/b')
  })

  it('falls back to the first workspace, then null', () => {
    const workspaces = [ws('w1', '/a', ['s1'])]
    expect(resolveCwd(workspaces, undefined, undefined)).toBe('/a')
    expect(resolveCwd([], undefined, undefined)).toBeNull()
  })
})

describe('isMarkdown', () => {
  it('recognizes markdown extensions case-insensitively', () => {
    expect(isMarkdown('/a/README.md')).toBe(true)
    expect(isMarkdown('/a/notes.MARKDOWN')).toBe(true)
    expect(isMarkdown('/a/page.mdx')).toBe(true)
    expect(isMarkdown('/a/code.ts')).toBe(false)
    expect(isMarkdown('/a/notes.txt')).toBe(false)
  })
})

describe('parentOf', () => {
  it('returns the parent directory or null at the root', () => {
    expect(parentOf('/a/b')).toBe('/a')
    expect(parentOf('/a')).toBeNull()
    expect(parentOf('/')).toBeNull()
    expect(parentOf('/a/b/')).toBe('/a')
  })

  it('handles Windows separators', () => {
    expect(parentOf('C:\\a\\b')).toBe('C:\\a')
    expect(parentOf('C:\\')).toBeNull()
  })
})

describe('joinPath', () => {
  it('joins with the directory separator', () => {
    expect(joinPath('/a', 'b')).toBe('/a/b')
    expect(joinPath('/a/', 'b')).toBe('/a/b')
    expect(joinPath('C:\\a', 'b')).toBe('C:\\a\\b')
    expect(joinPath('C:\\a\\', 'b')).toBe('C:\\a\\b')
  })
})

describe('formatSize', () => {
  it('formats bytes, kilobytes, and megabytes', () => {
    expect(formatSize(3)).toBe('3 B')
    expect(formatSize(1024)).toBe('1.0 KB')
    expect(formatSize(1536)).toBe('1.5 KB')
    expect(formatSize(1024 * 1024)).toBe('1.0 MB')
  })
})
