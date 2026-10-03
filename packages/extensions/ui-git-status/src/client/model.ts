/** Pure status-model helpers shared by the widget and its tests. */

import type {
  GitCommitView, GitRepositoryRef, GitStatusSnapshot, SessionId, WorkspaceView,
} from '@deepseek-ai/dsh-api-remotes/client'

/**
 * The repository the widget reports on: the user's pick while the discovered
 * set still holds it, otherwise the first discovered repository. The host lists
 * the enclosing repository first, so the default is the workspace's own
 * repository when it has one, and the first clone inside it otherwise.
 * @param repositories - repositories the host discovered, in host order.
 * @param selected - the user's chosen root, or null when they have not chosen.
 * @returns the repository to query, or null when none was discovered.
 */
export function resolveRepository(
  repositories: readonly GitRepositoryRef[],
  selected: string | null,
): GitRepositoryRef | null {
  if (selected !== null) {
    const picked = repositories.find(repository => repository.root === selected)
    if (picked !== undefined) return picked
  }
  return repositories[0] ?? null
}

/**
 * The workspace directory the widget reports on: the workspace owning the
 * current session, then the first registered one. The registry lists
 * workspaces in the user's own order, so the fallback is stable.
 * @param workspaces - every registered workspace, in registry order.
 * @param currentSession - the session the main view retains, or undefined.
 * @returns the directory to query, or null when no workspace is registered.
 */
export function resolveCwd(
  workspaces: readonly WorkspaceView[],
  currentSession: SessionId | undefined,
): string | null {
  if (currentSession !== undefined) {
    const owner = workspaces.find(item => item.sessionIds.includes(currentSession))
    if (owner !== undefined) return owner.path
  }
  return workspaces[0]?.path ?? null
}

/**
 * Widget summary derived from the latest snapshot.
 * @param snapshot - the newest snapshot, or null before the first read lands.
 * @returns the state the sidebar colors itself by, and the changed-file total.
 */
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

/**
 * The entries belonging to one display group, in repository order. Staged and
 * unstaged are exclusive: a file with both staged and unstaged changes is
 * listed under staged, matching the snapshot's counts.
 * @param snapshot - the snapshot to group.
 * @param group - the group to select.
 * @returns the entries in that group, in the snapshot's order.
 */
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
 * @param commit - one history row.
 * @param query - the raw search box contents; blank matches everything.
 * @returns true when any searched field contains the trimmed query.
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
  | { readonly unit: 'now' }
  | { readonly unit: 'minutes' | 'hours' | 'days'; readonly value: number }
  | { readonly unit: 'date'; readonly value: string }

/**
 * Bucket an ISO author date against a now epoch (ms) for the row's time chip.
 * @param isoDate - the commit's ISO-8601 author date.
 * @param now - current epoch milliseconds.
 * @returns the bucket to render; an unparsable or future date renders as-is.
 */
export function commitAge(isoDate: string, now: number): CommitAge {
  const date = Date.parse(isoDate)
  if (Number.isNaN(date) || date > now) return { unit: 'date', value: isoDate }
  const minutes = Math.floor((now - date) / 60_000)
  if (minutes < 1) return { unit: 'now' }
  if (minutes < 60) return { unit: 'minutes', value: minutes }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return { unit: 'hours', value: hours }
  const days = Math.floor(hours / 24)
  if (days < 30) return { unit: 'days', value: days }
  return { unit: 'date', value: isoDate.slice(0, 10) }
}
