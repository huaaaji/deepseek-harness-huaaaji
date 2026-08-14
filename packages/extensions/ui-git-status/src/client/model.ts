/** Pure status-model helpers shared by the widget and its tests. */

import type {
  GitCommitView, GitStatusSnapshot, SessionId, WorkspaceId, WorkspaceView,
} from '@deepseek-ai/dsh-api-remotes/client'

/** The workspace directory the widget should report on: the current session's
 * workspace, then the recent workspace, then the first registered one. */
export function resolveCwd(
  workspaces: readonly WorkspaceView[],
  recentWorkspaceId: WorkspaceId | undefined,
  currentSession: SessionId | undefined,
): string | null {
  if (currentSession !== undefined) {
    const owner = workspaces.find(item => item.sessionIds.includes(currentSession))
    if (owner !== undefined) return owner.path
  }
  const recent = workspaces.find(item => item.workspaceId === recentWorkspaceId)
  if (recent !== undefined) return recent.path
  return workspaces[0]?.path ?? null
}

/** Widget summary derived from the latest snapshot. */
export function summarize(snapshot: GitStatusSnapshot | null): {
  readonly state: 'clean' | 'conflicted' | 'dirty' | 'error' | 'none'
  readonly total: number
} {
  if (snapshot === null) return { state: 'none', total: 0 }
  if (snapshot.failure !== null) return { state: 'error', total: 0 }
  const { conflicted, staged, unstaged, untracked } = snapshot.counts
  const total = conflicted + staged + unstaged + untracked
  if (total === 0) return { state: 'clean', total: 0 }
  return { state: conflicted > 0 ? 'conflicted' : 'dirty', total }
}

/** Display groups the modal lists files under. */
export type StatusGroup = 'conflicted' | 'staged' | 'unstaged' | 'untracked'

/** The entries belonging to one display group, in repository order. */
export function entriesOf(
  snapshot: GitStatusSnapshot,
  group: StatusGroup,
): readonly GitStatusSnapshot['entries'][number][] {
  return snapshot.entries.filter((entry) => {
    if (group === 'conflicted') return entry.state === 'conflicted'
    if (group === 'untracked') return entry.state === 'untracked'
    if (group === 'staged') return entry.staged && entry.state !== 'conflicted' && entry.state !== 'untracked'
    return !entry.staged && entry.state !== 'conflicted' && entry.state !== 'untracked'
  })
}

/**
 * Case-insensitive history filter over message, hashes, author identity, and
 * ref names — the search box's predicate.
 */
export function matchesQuery(commit: GitCommitView, query: string): boolean {
  if (query.trim() === '') return true
  const needle = query.trim().toLocaleLowerCase()
  return [
    commit.subject, commit.hash, commit.shortHash, commit.author, commit.authorEmail,
    ...commit.refs.map(ref => ref.name),
  ].some(value => value.toLocaleLowerCase().includes(needle))
}

/** The coarse age bucket a commit date falls into, for localized display. */
export type CommitAge =
  | { readonly unit: 'minutes' | 'hours' | 'days'; readonly value: number }
  | { readonly unit: 'date'; readonly value: string }

/** Bucket an ISO author date against a now epoch (ms) for the row's time chip. */
export function commitAge(isoDate: string, now: number): CommitAge {
  const date = Date.parse(isoDate)
  if (Number.isNaN(date) || date > now) return { unit: 'date', value: isoDate }
  const minutes = Math.floor((now - date) / 60_000)
  if (minutes < 1) return { unit: 'minutes', value: 0 }
  if (minutes < 60) return { unit: 'minutes', value: minutes }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { unit: 'hours', value: hours }
  const days = Math.floor(hours / 24)
  if (days < 30) return { unit: 'days', value: days }
  return { unit: 'date', value: isoDate.slice(0, 10) }
}
