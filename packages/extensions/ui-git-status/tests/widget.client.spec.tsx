// @vitest-environment jsdom
/** Git widget behavior: read ordering, error placement, search, and keyboard selection. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {
  GitCommitDetails, GitCommitDetailsResult, GitCommitView, GitFileDiffResult,
  GitHistoryResult, GitMutationResult, GitStatusSnapshot, WorkspaceId, WorkspaceView,
} from '@deepseek-ai/dsh-api-remotes/client'
import { GitGraphView, type GitGraphInjected } from '../src/client/GitGraphView.tsx'
import { GitStatusAction, type GitStatusActionProps } from '../src/client/GitStatusAction.tsx'
import { laneX } from '../src/client/graph.ts'
import { en } from '../src/client/locales.ts'

const t = makeTranslate(en)

afterEach(cleanup)

/** One history row for the fixtures. */
function commitView(
  hash: string,
  subject: string,
  parents: readonly string[] = [],
  refs: GitCommitView['refs'] = [],
): GitCommitView {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    parents,
    refs,
    author: 'Tester',
    authorEmail: 't@t',
    authorDate: '2026-01-01T00:00:00+08:00',
    subject,
  }
}

/** Commit details whose message identifies the commit in the panel. */
function detailsOf(message: string): GitCommitDetails {
  return {
    hash: 'a'.repeat(40),
    shortHash: 'aaaaaaa',
    parents: [],
    refs: [],
    author: 'Tester',
    authorEmail: 't@t',
    authorDate: '2026-01-01T00:00:00+08:00',
    committerDate: '2026-01-01T00:00:00+08:00',
    message,
    files: [],
    localBranches: [],
    remoteBranches: [],
  }
}

/** A promise whose settlement the test controls. */
function deferred<T>() {
  let resolve: (value: T) => void = () => {}
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

/** Every stub the history tab needs except the reads a test overrides. */
function graphFace(overrides: Partial<GitGraphInjected> = {}): GitGraphInjected {
  return {
    history: async (): Promise<GitHistoryResult> => ({ commits: [], truncated: false, failure: null }),
    commitDetails: async (): Promise<GitCommitDetailsResult> => ({ details: null, failure: null }),
    fileDiff: async (): Promise<GitFileDiffResult> => ({
      path: 'a', oldText: null, newText: null, binary: false, truncated: false, failure: null,
    }),
    checkout: async (): Promise<GitMutationResult> => ({ ok: true, failure: null }),
    createBranch: async (): Promise<GitMutationResult> => ({ ok: true, failure: null }),
    ...overrides,
  }
}

/** Mount the history tab over one fixed directory. */
function mountGraph(face: GitGraphInjected) {
  return render(
    <GitGraphView cwd="/repo" onMutated={() => {}} {...face} t={t} />,
  )
}

const workspace: WorkspaceView = {
  workspaceId: 'w1' as WorkspaceId,
  path: '/repo',
  title: 'repo',
  sessionIds: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

const snapshotOf = (branch: string, root = '/repo'): GitStatusSnapshot => ({
  root,
  branch: { name: branch, upstream: null, ahead: 0, behind: 0 },
  head: { shortHash: 'abc1234', subject: 'work' },
  counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
  entries: [],
  failure: null,
})

// The shell supplies these standing seats to every slot action; the widget
// reads only the workspace and session lists, so the rest stay inert.
const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined })) as GlobalStandardProps['useResource']
const usePanelInfo: GitStatusActionProps['usePanelInfo'] = selector => selector({ activePanelId: null })
const useSessionRetainInfo: GitStatusActionProps['useSessionRetainInfo'] = () => undefined
type AttentionSnapshot = Parameters<Parameters<GitStatusActionProps['useSessionStatus']>[0]>[0]
const noAttention: AttentionSnapshot = new Map()
const useSessionStatus: GitStatusActionProps['useSessionStatus'] = selector => selector(noAttention)

/** Mount the sidebar widget over one workspace and no current session. */
function mountWidget(
  status: GitStatusActionProps['status'],
  repositories: GitStatusActionProps['repositories'] = async () => ({ repositories: [], scanDepth: 1 }),
) {
  const props: GitStatusActionProps = {
    wide: true,
    status,
    repositories,
    useResource,
    usePanelInfo,
    useSessionStatus,
    useSessionRetainInfo,
    useSessions: bindSnapshotSelector(createSnapshotStore<SessionListState>({
      ids: [], byId: {}, phase: 'ready', projectionsBySession: {},
    })),
    useWorkspaces: bindSnapshotSelector(createSnapshotStore<WorkspaceSnapshot>({
      items: [workspace], archivedSessionIds: [], pinnedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    })),
    t,
    ...graphFace(),
  }
  return render(<GitStatusAction {...props} />)
}

describe('GitGraphView reads', () => {
  it('ignores a details reply that lands after a newer selection', async () => {
    const rows = [commitView('a'.repeat(40), 'first subject'), commitView('b'.repeat(40), 'second subject')]
    const pending = new Map<string, (result: GitCommitDetailsResult) => void>()
    const commitDetails = vi.fn((_cwd: string, hash: string) => new Promise<GitCommitDetailsResult>((resolve) => {
      pending.set(hash, resolve)
    }))
    mountGraph(graphFace({
      history: async () => ({ commits: rows, truncated: false, failure: null }),
      commitDetails,
    }))

    fireEvent.click(await screen.findByText('first subject'))
    fireEvent.click(screen.getByText('second subject'))
    await waitFor(() => { expect(pending.size).toBe(2) })

    // The older reply arrives last; it must not replace the newer selection.
    await act(async () => { pending.get('a'.repeat(40))?.({ details: detailsOf('stale body'), failure: null }) })
    await act(async () => { pending.get('b'.repeat(40))?.({ details: detailsOf('fresh body'), failure: null }) })

    expect(screen.getByText('fresh body')).toBeTruthy()
    expect(screen.queryByText('stale body')).toBeNull()
  })

  it('shows a load-more failure in the list rather than the details panel', async () => {
    const history = vi.fn()
      .mockResolvedValueOnce({ commits: [commitView('a'.repeat(40), 'only subject')], truncated: true, failure: null })
      .mockResolvedValueOnce({ commits: [], truncated: false, failure: { code: 'git-error', message: 'log exploded' } })
    mountGraph(graphFace({ history }))

    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    // Nothing is selected, so the details panel does not exist: the failure has
    // to reach the list's own error line to be visible at all.
    const failure = await screen.findByText(/log exploded/)
    expect(failure.closest('[role="alert"]')).not.toBeNull()
  })

  it('surfaces a rejected mutation as an operation failure', async () => {
    const rows = [commitView('a'.repeat(40), 'only subject')]
    mountGraph(graphFace({
      history: async () => ({ commits: rows, truncated: false, failure: null }),
      commitDetails: async () => ({ details: detailsOf('body'), failure: null }),
      checkout: async () => { throw new Error('transport down') },
    }))

    fireEvent.click(await screen.findByText('only subject'))
    fireEvent.click(await screen.findByRole('button', { name: 'Checkout commit' }))
    const failure = await screen.findByText(/transport down/)
    expect(failure.textContent).toContain('Operation failed')
  })

  it('selects a commit from the keyboard', async () => {
    const rows = [commitView('a'.repeat(40), 'only subject')]
    const commitDetails = vi.fn(async () => ({ details: detailsOf('keyboard body'), failure: null }))
    mountGraph(graphFace({
      history: async () => ({ commits: rows, truncated: false, failure: null }),
      commitDetails,
    }))

    const subject = await screen.findByText('only subject')
    fireEvent.keyDown(subject, { key: 'Enter' })
    expect(await screen.findByText('keyboard body')).toBeTruthy()
    expect(commitDetails).toHaveBeenCalledWith('/repo', 'a'.repeat(40))
  })
})

describe('GitGraphView search', () => {
  it('hides rows without re-laying out the lanes of the visible ones', async () => {
    const rows = [
      commitView('m'.repeat(40), 'merge', ['n'.repeat(40), 'f'.repeat(40)], [{ kind: 'branch', name: 'main' }]),
      commitView('f'.repeat(40), 'feature tip', ['b'.repeat(40)], [{ kind: 'branch', name: 'feature' }]),
      commitView('n'.repeat(40), 'main work', ['b'.repeat(40)]),
      commitView('b'.repeat(40), 'base'),
    ]
    mountGraph(graphFace({ history: async () => ({ commits: rows, truncated: false, failure: null }) }))

    await screen.findByText('merge')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'feature tip' } })

    // The surviving row keeps the lane the full window gave it; rebuilding the
    // graph from the match alone would move it back to lane 0. `r=4` selects the
    // graph dots and skips the icon artwork.
    const dots = document.querySelectorAll('circle[r="4"]')
    expect(dots).toHaveLength(1)
    expect(dots[0]?.getAttribute('cx')).toBe(String(laneX(1)))
  })
})

describe('GitStatusAction', () => {
  it('shows the loading copy, not a detached head, before the first snapshot', async () => {
    const first = deferred<GitStatusSnapshot>()
    mountWidget(() => first.promise)

    expect(screen.getByText('Loading…')).toBeTruthy()
    expect(screen.queryByText('(detached HEAD)')).toBeNull()

    await act(async () => { first.resolve(snapshotOf('main')) })
    expect(await screen.findByText('main')).toBeTruthy()
  })

  it('reports the repository cloned into a non-repository workspace', async () => {
    const status = vi.fn(async (cwd: string) => snapshotOf('main', cwd))
    mountWidget(status, async () => ({
      repositories: [{ root: '/repo/sp_vision_25', name: 'sp_vision_25' }],
      scanDepth: 1,
    }))

    // The workspace itself is not a repository; the read has to go to the clone
    // the host discovered inside it.
    expect(await screen.findByText('main')).toBeTruthy()
    expect(status).toHaveBeenCalledWith('/repo/sp_vision_25')
  })

  it('switches repositories from the picker', async () => {
    const status = vi.fn(async (cwd: string) => snapshotOf(cwd === '/repo/a' ? 'main' : 'dev', cwd))
    mountWidget(status, async () => ({
      repositories: [
        { root: '/repo/a', name: 'a' },
        { root: '/repo/b', name: 'b' },
      ],
      scanDepth: 1,
    }))
    await screen.findByText('main')

    fireEvent.click(screen.getByRole('button', { name: 'Git status' }))
    const active = screen.getByRole('button', { name: 'a' })
    expect(active.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(screen.getByRole('button', { name: 'b' }))

    const foot = screen.getByRole('button', { name: 'Git status' })
    await waitFor(() => { expect(status).toHaveBeenCalledWith('/repo/b') })
    await waitFor(() => { expect(foot.textContent).toContain('dev') })
  })

  it('keeps the workspace path as the target when no repository is discovered', async () => {
    const status = vi.fn(async (cwd: string) => snapshotOf('main', cwd))
    mountWidget(status)

    // An empty discovery reports nothing to switch to, so the status read names
    // the workspace problem itself (not-a-repo).
    await waitFor(() => { expect(status).toHaveBeenCalledWith('/repo') })
    expect(screen.queryByRole('group', { name: 'Repositories' })).toBeNull()
  })

  it('says which directory and depth it searched when nothing was found', async () => {
    const status = vi.fn(async (cwd: string) => snapshotOf('main', cwd))
    mountWidget(status, async () => ({ repositories: [], scanDepth: 2 }))

    await waitFor(() => { expect(status).toHaveBeenCalledWith('/repo') })
    fireEvent.click(screen.getByRole('button', { name: 'Git status' }))
    expect(await screen.findByText(/No Git repository in \/repo or within 2 level/)).toBeTruthy()
  })

  it('surfaces a discovery failure instead of reading as an empty workspace', async () => {
    const status = vi.fn(async (cwd: string) => snapshotOf('main', cwd))
    mountWidget(status, async () => { throw new Error('gitStatus.repositories failed') })

    // The status read still names the workspace problem, and the failed
    // discovery is reported beside it rather than silently becoming "no repos".
    await waitFor(() => { expect(status).toHaveBeenCalledWith('/repo') })
    fireEvent.click(screen.getByRole('button', { name: 'Git status' }))
    expect(await screen.findByText('Failed to list repositories')).toBeTruthy()
    expect(screen.getByText(/gitStatus\.repositories failed/)).toBeTruthy()
  })

  it('keeps the last snapshot on screen while a refresh is in flight', async () => {
    const first = deferred<GitStatusSnapshot>()
    const second = deferred<GitStatusSnapshot>()
    const status = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    mountWidget(status)

    await act(async () => { first.resolve(snapshotOf('main')) })
    const foot = await screen.findByRole('button', { name: 'Git status' })
    fireEvent.click(foot)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await waitFor(() => { expect(status).toHaveBeenCalledTimes(2) })

    // A refresh must not blank the summary back to its no-data copy.
    expect(foot.textContent).toContain('main')
    expect(screen.queryByText('(detached HEAD)')).toBeNull()

    await act(async () => { second.resolve(snapshotOf('dev')) })
    await waitFor(() => { expect(foot.textContent).toContain('dev') })
  })
})
