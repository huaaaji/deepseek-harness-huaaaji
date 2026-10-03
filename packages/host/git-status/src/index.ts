/** Read-only Remote snapshot of the git working tree for the Web GUI. */

import { basename, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import s from '@deepseek-ai/schemastery'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import {
  branchStateOf, failedOutcome, failureOf, parseHeadTeaser, parsePorcelainV2, runGit,
  GIT_TIMEOUT_MS,
  type CommandOutcome,
} from './git.ts'
import {
  GIT_DIFF_BYTES_LIMIT, GIT_HISTORY_LIMIT, historyArgs, parseBranchList, parseHistoryLog,
  parseNumstat, parseRefs, validBranchName, validObjectId, validRepoPath,
} from './history.ts'
import { scanSubdirectories } from './discover.ts'
import type {
  GitCheckoutRequest, GitCommitDetails, GitCommitDetailsRequest, GitCommitDetailsResult,
  GitCreateBranchRequest, GitFileDiffRequest, GitFileDiffResult, GitHistoryRequest,
  GitHistoryResult, GitMutationResult, GitRepositoryRef, GitRepositoryScanRequest,
  GitRepositoryScanResult, GitStatusCounts, GitStatusFailure, GitStatusRequest,
  GitStatusSnapshot,
} from './types.ts'

export type * from './types.ts'

/**
 * Deployment limits for the working-tree reads. Each bound is enforced while
 * git is read, never after the whole output has been buffered.
 */
export interface Config {
  /** Kill-after deadline for one git invocation, in milliseconds. */
  readonly timeoutMs: number
  /** Largest history page the Remote accepts; a larger request is clamped. */
  readonly historyLimit: number
  /** Per-side character budget for one file diff read. */
  readonly diffBytesLimit: number
  /**
   * Directory levels below the requested directory that repository discovery
   * searches, mirroring `git.repositoryScanMaxDepth`: `1` inspects the
   * immediate subdirectories, `0` skips discovery entirely, and `-1` walks the
   * whole subtree.
   */
  readonly scanDepth: number
  /**
   * Child directory names discovery never enters, matched exactly by directory
   * name (not by glob). The default keeps dependency trees out of the walk.
   */
  readonly scanIgnoredFolders: string[]
}

/** Zeroed counts used in every snapshot construction. */
const EMPTY_COUNTS: Readonly<GitStatusCounts> = {
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
} as const

/**
 * Aggregate the wire counts from parsed entries. Every entry counts once — a
 * file with both staged and unstaged changes lands in `staged` alone — so the
 * four counts sum to the number of changed files the snapshot lists.
 */
function countsOf(entries: readonly GitStatusSnapshot['entries'][number][]): GitStatusCounts {
  let staged = 0
  let unstaged = 0
  let untracked = 0
  let conflicted = 0
  for (const entry of entries) {
    if (entry.state === 'conflicted') conflicted += 1
    else if (entry.state === 'untracked') untracked += 1
    else if (entry.staged) staged += 1
    else unstaged += 1
  }
  return { staged, unstaged, untracked, conflicted }
}

/** Remote-only service answering working-tree queries through the git CLI. */
export class GitStatusGateway extends TypertRemoteService {
  static inject = []

  static Config: s<Config> = s.object({
    timeoutMs: s.number().min(1).default(GIT_TIMEOUT_MS),
    historyLimit: s.number().min(1).default(GIT_HISTORY_LIMIT),
    diffBytesLimit: s.number().min(1).default(GIT_DIFF_BYTES_LIMIT),
    scanDepth: s.number().step(1).min(-1).default(1),
    scanIgnoredFolders: s.array(s.string()).default(['node_modules']),
  })

  private readonly config: Config

  /**
   * @param ctx - Host context owning the service registration.
   * @param config - validated deployment limits for every git read.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'gitStatus')
    this.config = config
  }

  /**
   * Snapshot the working tree at the requested directory. The directory does
   * not need to be the repository root; git walks up to it. Failures (missing
   * git, not a repository, timeout) are reported inside the snapshot rather
   * than as RPC errors so the GUI can render a stable widget.
   * @param request - the directory to query.
   * @returns the working-tree snapshot.
   */
  @Remote('status')
  async status(request: GitStatusRequest): Promise<GitStatusSnapshot> {
    return snapshotOf(resolve(request.cwd), this.config)
  }

  /**
   * Discover the repositories at or below the requested directory: the
   * enclosing repository first, then the subdirectory repositories down to the
   * configured `scanDepth`. A workspace that is not itself a repository still
   * reports the repositories cloned into it. A discovery that finds nothing —
   * including an unreadable or missing directory — reports an empty list, so
   * the caller's next read names the actual failure.
   * @param request - the directory to scan.
   * @returns the discovered repositories, deduplicated by root.
   */
  @Remote('repositories')
  async repositories(request: GitRepositoryScanRequest): Promise<GitRepositoryScanResult> {
    return repositoriesOf(resolve(request.cwd), this.config)
  }

  /**
   * Read one page of history (newest first) with the refs the graph renders.
   * @param request - directory, page size, and skip offset.
   * @returns the parsed page or a structured failure.
   */
  @Remote('history')
  async history(request: GitHistoryRequest): Promise<GitHistoryResult> {
    return historyOf(resolve(request.cwd), request, this.config)
  }

  /**
   * Read one commit's full metadata and its changed-file statistics.
   * @param request - directory and commit hash.
   * @returns the commit details or a structured failure.
   */
  @Remote('commitDetails')
  async commitDetails(request: GitCommitDetailsRequest): Promise<GitCommitDetailsResult> {
    const cwd = resolve(request.cwd)
    if (!validObjectId(request.hash)) {
      return { details: null, failure: invalidRevision(request.hash) }
    }
    return commitDetailsOf(cwd, request.hash, this.config)
  }

  /**
   * Read one file's content at a commit and at its first parent, for the
   * GUI's diff surface. Renames read the parent side through the old path.
   * @param request - directory, commit hash, and the new/old paths.
   * @returns the two sides or a structured failure.
   */
  @Remote('fileDiff')
  async fileDiff(request: GitFileDiffRequest): Promise<GitFileDiffResult> {
    const cwd = resolve(request.cwd)
    if (!validObjectId(request.hash)) {
      return diffFailure(request.path, invalidRevision(request.hash))
    }
    if (!validRepoPath(request.path) || (request.oldPath !== null && !validRepoPath(request.oldPath))) {
      return diffFailure(request.path, {
        code: 'invalid-path',
        message: `无效的路径：${request.path}`,
      })
    }
    return fileDiffOf(cwd, request, this.config)
  }

  /**
   * Move HEAD: checkout a branch by name, or detach at a commit by hash.
   * @param request - directory and the checkout target.
   * @returns ok, or a structured failure carrying git's message.
   */
  @Remote('checkout')
  async checkout(request: GitCheckoutRequest): Promise<GitMutationResult> {
    const cwd = resolve(request.cwd)
    if (request.kind === 'branch') {
      if (!validBranchName(request.target)) {
        return mutationFailure({ code: 'invalid-name', message: `无效的分支名：${request.target}` })
      }
    } else if (!validObjectId(request.target)) {
      return mutationFailure(invalidRevision(request.target))
    }
    const outcome = await runGit(['checkout', request.target], cwd, { timeoutMs: this.config.timeoutMs })
    if (failedOutcome(outcome)) {
      return mutationFailure(failureOf(outcome, `git checkout failed in ${cwd}`, 'git-error'))
    }
    return { ok: true, failure: null }
  }

  /**
   * Create a branch at a commit without checking it out.
   * @param request - directory, branch name, and the target hash.
   * @returns ok, or a structured failure (invalid name or git's message).
   */
  @Remote('createBranch')
  async createBranch(request: GitCreateBranchRequest): Promise<GitMutationResult> {
    const cwd = resolve(request.cwd)
    if (!validBranchName(request.name)) {
      return mutationFailure({ code: 'invalid-name', message: `无效的分支名：${request.name}` })
    }
    if (!validObjectId(request.atHash)) {
      return mutationFailure(invalidRevision(request.atHash))
    }
    const outcome = await runGit(['branch', request.name, request.atHash], cwd, { timeoutMs: this.config.timeoutMs })
    if (failedOutcome(outcome)) {
      return mutationFailure(failureOf(outcome, `git branch failed in ${cwd}`, 'git-error'))
    }
    return { ok: true, failure: null }
  }
}

/** The failure reported for a revision the wire validation refused. */
function invalidRevision(hash: string): GitStatusFailure {
  return { code: 'invalid-revision', message: `无效的提交：${hash}` }
}

/**
 * Discover the repositories at or below one directory. The subdirectory walk
 * yields candidates that carry a `.git` entry; git then resolves and confirms
 * each one, so a directory holding an unrelated `.git` name is skipped and a
 * linked worktree resolves to its own root.
 */
async function repositoriesOf(cwd: string, config: Config): Promise<GitRepositoryScanResult> {
  const options = { timeoutMs: config.timeoutMs }
  const roots = new Map<string, GitRepositoryRef>()
  const enclosing = await repositoryRootAt(cwd, options)
  if (enclosing !== null) roots.set(enclosing, { root: enclosing, name: basename(enclosing) })
  for (const candidate of await scanSubdirectories(cwd, config.scanDepth, config.scanIgnoredFolders)) {
    const root = await repositoryRootAt(candidate, options)
    // `Map.set` keeps the first insertion order, so the enclosing repository
    // stays first and a repeated root is a no-op.
    if (root !== null) roots.set(root, { root, name: basename(root) })
  }
  return { repositories: [...roots.values()], scanDepth: config.scanDepth }
}

/** The working-tree root that answers one directory, or null when none does. */
async function repositoryRootAt(
  directory: string,
  options: { timeoutMs: number },
): Promise<string | null> {
  const outcome = await runGit(['rev-parse', '--show-toplevel'], directory, options)
  if (failedOutcome(outcome)) return null
  /* v8 ignore next -- a successful rev-parse always prints the root path; the fallback answers the optional-index type. */
  return outcome.stdout.trim().split('\n')[0] ?? ''
}

/** Produce one snapshot for a resolved directory, never throwing. */
async function snapshotOf(cwd: string, config: Config): Promise<GitStatusSnapshot> {
  const rootOutcome = await runGit(['rev-parse', '--show-toplevel'], cwd, { timeoutMs: config.timeoutMs })
  if (failedOutcome(rootOutcome)) {
    return failedSnapshot(failureOf(rootOutcome, `git rev-parse failed in ${cwd}`))
  }
  /* v8 ignore next -- a successful rev-parse always prints the root path; the fallback answers the optional-index type. */
  const root = rootOutcome.stdout.trim().split('\n')[0] ?? cwd

  const statusOutcome = await runGit([
    '-c', 'core.quotepath=false',
    'status', '--porcelain=v2', '--branch',
  ], root, { timeoutMs: config.timeoutMs })
  if (failedOutcome(statusOutcome)) {
    return failedSnapshot(failureOf(statusOutcome, 'git status failed'))
  }

  const parsed = parsePorcelainV2(statusOutcome.stdout)
  const head = parsed.branch.oid === null
    ? null
    : await headTeaser(root, config)

  return {
    root,
    branch: branchStateOf(parsed.branch),
    head,
    counts: countsOf(parsed.entries),
    entries: parsed.entries,
    failure: null,
  }
}

/** Read the HEAD teaser when the repository has commits; null on any failure. */
async function headTeaser(root: string, config: Config): Promise<GitStatusSnapshot['head']> {
  const outcome = await runGit(['log', '-1', '--format=%h%x1f%s'], root, { timeoutMs: config.timeoutMs })
  /* v8 ignore next -- a log failure right after a successful status read requires object
     corruption the gateway already reports through the status arm; this null return is defensive. */
  if (outcome.code !== 0 || outcome.spawnError !== null) return null
  return parseHeadTeaser(outcome.stdout.trimEnd())
}

/** A snapshot whose `failure` is set and every other field is empty. */
function failedSnapshot(failure: GitStatusSnapshot['failure']): GitStatusSnapshot {
  /* v8 ignore next -- callers construct the failure from a non-null outcome by construction; the guard is type-level defense. */
  if (failure === null) throw new Error('failedSnapshot requires a failure')
  return {
    root: null,
    branch: null,
    head: null,
    counts: { ...EMPTY_COUNTS },
    entries: [],
    failure,
  }
}

/** A failed mutation result carrying the wire failure. */
function mutationFailure(failure: GitStatusFailure): GitMutationResult {
  return { ok: false, failure }
}

/** Produce one history page for a resolved directory, never throwing. */
async function historyOf(cwd: string, request: GitHistoryRequest, config: Config): Promise<GitHistoryResult> {
  const count = Math.min(Math.max(Math.trunc(request.count) || 0, 1), config.historyLimit)
  const skip = Math.max(Math.trunc(request.skip) || 0, 0)
  const outcome = await runGit([...historyArgs(count, skip)], cwd, { timeoutMs: config.timeoutMs })
  if (failedOutcome(outcome)) {
    return { commits: [], truncated: false, failure: failureOf(outcome, `git log failed in ${cwd}`, 'git-error') }
  }
  const parsed = parseHistoryLog(outcome.stdout, count)
  return { commits: parsed.commits, truncated: parsed.truncated, failure: null }
}

/**
 * Produce one commit's metadata and file statistics, never throwing. The four
 * reads are independent once the hash is validated, so they run together.
 */
async function commitDetailsOf(cwd: string, hash: string, config: Config): Promise<GitCommitDetailsResult> {
  const options = { timeoutMs: config.timeoutMs }
  const [metaOutcome, filesOutcome, localOutcome, remoteOutcome] = await Promise.all([
    runGit([
      'log', '-1', '--format=%H%x1f%h%x1f%P%x1f%D%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%B',
      hash, '--',
    ], cwd, options),
    runGit(['show', '--format=', '--numstat', '--find-renames', '-z', hash], cwd, options),
    runGit(['branch', '--contains', hash], cwd, options),
    runGit(['branch', '--remotes', '--contains', hash], cwd, options),
  ])
  if (failedOutcome(metaOutcome)) {
    return { details: null, failure: failureOf(metaOutcome, `git log failed in ${cwd}`, 'git-error') }
  }
  if (failedOutcome(filesOutcome)) {
    return { details: null, failure: failureOf(filesOutcome, `git show failed in ${cwd}`, 'git-error') }
  }
  const details = parseCommitDetails(
    metaOutcome.stdout,
    parseNumstat(filesOutcome.stdout),
    parseContainingBranches(localOutcome),
    parseContainingBranches(remoteOutcome),
  )
  /* v8 ignore next -- a successful git log always prints the fixed field layout; the null arm answers malformed output defensively. */
  if (details === null) {
    return { details: null, failure: { code: 'git-error', message: `无法解析提交 ${hash}` } }
  }
  return { details, failure: null }
}

/** Containing-branch lists are best-effort: the hash was already validated by
 * the metadata read, so a failed listing degrades to an empty list. */
function parseContainingBranches(outcome: CommandOutcome): readonly string[] {
  /* v8 ignore next -- the metadata read already proved the repository and hash valid; this arm is defensive. */
  if (failedOutcome(outcome)) return []
  return parseBranchList(outcome.stdout)
}

/** Parse the metadata half of a commit-details read into the wire shape. */
function parseCommitDetails(
  output: string,
  files: GitCommitDetails['files'],
  localBranches: readonly string[],
  remoteBranches: readonly string[],
): GitCommitDetails | null {
  const fields = output.split('\x1f', 9)
  /* v8 ignore next -- the format string always emits nine fields; the guard answers malformed output defensively. */
  if (fields.length !== 9) return null
  const [hash = '', shortHash = '', parentsRaw = '', decorate = '', author = '', authorEmail = '', authorDate = '', committerDate = '', message = ''] = fields
  /* v8 ignore next -- a successful git log always prints a full 40-char hash; the guard answers malformed output defensively. */
  if (hash.length !== 40) return null
  const parents = parentsRaw === '' ? [] : parentsRaw.split(' ')
  return {
    hash,
    shortHash,
    parents,
    refs: parseRefs(decorate),
    author,
    authorEmail,
    authorDate,
    committerDate,
    message: message.trimEnd(),
    files,
    localBranches,
    remoteBranches,
  }
}

/**
 * Produce one file's two sides for the diff surface, never throwing. Both
 * sides are independent reads, and each stops at the configured character
 * budget so one oversized blob cannot be buffered whole.
 */
async function fileDiffOf(cwd: string, request: GitFileDiffRequest, config: Config): Promise<GitFileDiffResult> {
  const options = { timeoutMs: config.timeoutMs, maxStdoutChars: config.diffBytesLimit }
  const [newOutcome, oldOutcome] = await Promise.all([
    runGit(['show', `${request.hash}:${request.path}`], cwd, options),
    runGit(['show', `${request.hash}^:${request.oldPath ?? request.path}`], cwd, options),
  ])
  const newSide = sideState(newOutcome, 'new')
  if (newSide === 'failed') return diffFailure(request.path, failureOf(newOutcome, 'git show failed', 'git-error'))
  const oldSide = sideState(oldOutcome, 'old')
  if (oldSide === 'failed') return diffFailure(request.path, failureOf(oldOutcome, 'git show failed', 'git-error'))
  const newText = newSide === 'missing' ? null : cappedText(newOutcome)
  const oldText = oldSide === 'missing' ? null : cappedText(oldOutcome)
  return {
    path: request.path,
    oldText: oldText?.text ?? null,
    newText: newText?.text ?? null,
    binary: oldText === null && newText === null,
    truncated: (oldText?.truncated ?? false) || (newText?.truncated ?? false),
    failure: null,
  }
}

/**
 * One side's read disposition: clean, absent (new/deleted file, or a root
 * commit's missing parent), or failed. git reports an absent path and an
 * unreadable object through the same exit code, so the diagnostic text decides
 * — which is why every invocation runs in the C locale.
 * @param outcome - the terminated `git show` run.
 * @param side - which revision the read addressed; a root commit has no parent.
 * @returns whether the side was read, is absent, or failed.
 */
function sideState(outcome: CommandOutcome, side: 'new' | 'old'): 'ok' | 'missing' | 'failed' {
  if (outcome.truncated) return 'ok'
  if (outcome.spawnError === null && outcome.code === 0 && outcome.signal === null) return 'ok'
  if (outcome.code === 128) {
    if (/fatal: path .* (?:exists on disk, but not in|does not exist in) '[^']*'/.test(outcome.stderr)) {
      return 'missing'
    }
    // The parent revision of a root commit does not exist at all.
    if (side === 'old' && outcome.stderr.includes('invalid object name')) return 'missing'
  }
  return 'failed'
}

/** A diff read that could not be performed at all. */
function diffFailure(path: string, failure: GitStatusFailure): GitFileDiffResult {
  return {
    path,
    oldText: null,
    newText: null,
    binary: false,
    truncated: false,
    failure,
  }
}

/** Cap one side's content; binary output (a NUL byte) reads as null. */
function cappedText(outcome: CommandOutcome): { text: string; truncated: boolean } | null {
  if (outcome.stdout.includes('\x00')) return null
  return { text: outcome.stdout, truncated: outcome.truncated }
}

export default GitStatusGateway
