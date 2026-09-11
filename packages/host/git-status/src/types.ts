/** Wire types for the git-status Remote: a point-in-time working-tree snapshot. */

/** One changed file produced by porcelain-v2 parsing. */
export interface GitStatusEntry {
  /** Repository-relative path of the file. */
  readonly path: string
  /** Original path for renames; null otherwise. */
  readonly oldPath: string | null
  /** Human-facing change kind. */
  readonly state: GitStatusFileState
  /** True when the change is staged in the index. */
  readonly staged: boolean
}

/** Change kinds the GUI groups file rows by. */
export type GitStatusFileState =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted'

/** Current branch facts from the porcelain-v2 `# branch.*` headers. */
export interface GitBranchState {
  /** Current branch name, or null when HEAD is detached. */
  readonly name: string | null
  /** Upstream tracking branch (e.g. `origin/main`), or null. */
  readonly upstream: string | null
  /** Commits ahead of the upstream. */
  readonly ahead: number
  /** Commits behind the upstream. */
  readonly behind: number
}

/** HEAD commit teaser. */
export interface GitHeadState {
  readonly shortHash: string
  readonly subject: string
}

/** Aggregate counts over the snapshot's entries. */
export interface GitStatusCounts {
  readonly staged: number
  readonly unstaged: number
  readonly untracked: number
  readonly conflicted: number
}

/** Why git could not produce a snapshot or perform a mutation. */
export type GitStatusFailureCode =
  | 'git-unavailable'
  | 'not-a-repo'
  | 'timeout'
  | 'git-error'
  | 'invalid-name'

/** Structured failure carried inside an otherwise complete snapshot. */
export interface GitStatusFailure {
  readonly code: GitStatusFailureCode
  readonly message: string
}

/** Remote request: the directory to query. */
export interface GitStatusRequest {
  /** Absolute directory to run git in; git walks up to the repository root. */
  readonly cwd: string
}

/** Point-in-time working-tree snapshot. `failure` is non-null exactly when git
 * could not answer; the remaining fields stay in their empty defaults. */
export interface GitStatusSnapshot {
  /** Absolute repository root that answered, or null on failure. */
  readonly root: string | null
  readonly branch: GitBranchState | null
  readonly head: GitHeadState | null
  readonly counts: GitStatusCounts
  readonly entries: readonly GitStatusEntry[]
  readonly failure: GitStatusFailure | null
}

/** One ref label attached to a history commit. */
export interface GitRefLabel {
  /** Display name (branch or tag name without the refs/ prefix). */
  readonly name: string
  readonly kind: 'head' | 'branch' | 'remote' | 'tag'
}

/** One history row: the graph node and its row metadata. */
export interface GitCommitView {
  readonly hash: string
  readonly shortHash: string
  /** Parent hashes in git's parent order (first parent first); empty for a root commit. */
  readonly parents: readonly string[]
  readonly refs: readonly GitRefLabel[]
  readonly author: string
  readonly authorEmail: string
  readonly authorDate: string
  readonly subject: string
}

/** Remote request: one page of history, newest first. */
export interface GitHistoryRequest {
  readonly cwd: string
  /** Commits to return (1..500); the caller reads one extra to detect truncation. */
  readonly count: number
  /** Commits to skip for paging. */
  readonly skip: number
}

/** Paged history result. */
export interface GitHistoryResult {
  readonly commits: readonly GitCommitView[]
  /** True when more commits exist beyond this page. */
  readonly truncated: boolean
  readonly failure: GitStatusFailure | null
}

/** One changed file of a commit, from numstat. */
export interface GitCommitFileStat {
  readonly path: string
  /** Original path for renames; null otherwise. */
  readonly oldPath: string | null
  /** Added lines, or null for a binary file. */
  readonly added: number | null
  /** Removed lines, or null for a binary file. */
  readonly removed: number | null
}

/** Full metadata of one commit plus its changed-file list. */
export interface GitCommitDetails {
  readonly hash: string
  readonly shortHash: string
  readonly parents: readonly string[]
  readonly refs: readonly GitRefLabel[]
  readonly author: string
  readonly authorEmail: string
  readonly authorDate: string
  readonly committerDate: string
  /** Full commit message body, including the subject line. */
  readonly message: string
  readonly files: readonly GitCommitFileStat[]
  /** Local branches whose history contains this commit. */
  readonly localBranches: readonly string[]
  /** Remote branches whose history contains this commit. */
  readonly remoteBranches: readonly string[]
}

/** Remote request: one commit's details and file statistics. */
export interface GitCommitDetailsRequest {
  readonly cwd: string
  readonly hash: string
}

/** Commit details result. */
export interface GitCommitDetailsResult {
  readonly details: GitCommitDetails | null
  readonly failure: GitStatusFailure | null
}

/** Remote request: the content of one file at a commit and its first parent. */
export interface GitFileDiffRequest {
  readonly cwd: string
  readonly hash: string
  /** Repository-relative path at the commit (the new side). */
  readonly path: string
  /** Pre-rename path for the parent side; null when unchanged. */
  readonly oldPath: string | null
}

/** One file's two sides, ready for the GUI's diff surface. */
export interface GitFileDiffResult {
  readonly path: string
  /** Content at the first parent, or null for a new file or binary file. */
  readonly oldText: string | null
  /** Content at the commit, or null for a deleted or binary file. */
  readonly newText: string | null
  /** True when git reported the file as binary (no text sides). */
  readonly binary: boolean
  /** True when either side hit the size cap and was truncated. */
  readonly truncated: boolean
  readonly failure: GitStatusFailure | null
}

/** What a checkout targets: a branch by name, or a commit by hash (detached HEAD). */
export type GitCheckoutKind = 'branch' | 'commit'

/** Remote request: move HEAD. */
export interface GitCheckoutRequest {
  readonly cwd: string
  readonly kind: GitCheckoutKind
  /** Branch name, or commit hash when kind is commit. */
  readonly target: string
}

/** Remote request: create a branch at a commit without checking it out. */
export interface GitCreateBranchRequest {
  readonly cwd: string
  readonly name: string
  /** Hash the new branch points at. */
  readonly atHash: string
}

/** Result of a HEAD/branch mutation. */
export interface GitMutationResult {
  /** True when the mutation committed; false with a failure otherwise. */
  readonly ok: boolean
  readonly failure: GitStatusFailure | null
}
