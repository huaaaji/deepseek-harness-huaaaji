/** Read-only Remote snapshot of the git working tree for the Web GUI. */

import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import {
  branchStateOf, failedOutcome, failureOf, parseHeadTeaser, parsePorcelainV2, runGit,
  type CommandOutcome,
} from './git.ts'
import {
  GIT_DIFF_BYTES_LIMIT, GIT_HISTORY_LIMIT, historyArgs, parseHistoryLog, parseNumstat,
  parseRefs, validBranchName,
} from './history.ts'
import type {
  GitCheckoutRequest, GitCommitDetails, GitCommitDetailsRequest, GitCommitDetailsResult,
  GitCreateBranchRequest, GitFileDiffRequest, GitFileDiffResult, GitHistoryRequest,
  GitHistoryResult, GitMutationResult, GitStatusCounts, GitStatusFailure, GitStatusRequest,
  GitStatusSnapshot,
} from './types.ts'

export type * from './types.ts'

/** Zeroed counts used in every snapshot construction. */
const EMPTY_COUNTS: Readonly<GitStatusCounts> = {
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
} as const

/**
 * Aggregate the wire counts from parsed entries. A staged+unstaged file
 * counts in both buckets; conflicted files count only as conflicted.
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

  constructor(ctx: Context) {
    super(ctx, 'gitStatus')
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
    return snapshotOf(resolve(request.cwd))
  }

  /**
   * Read one page of history (newest first) with the refs the graph renders.
   * @param request - directory, page size, and skip offset.
   * @returns the parsed page or a structured failure.
   */
  @Remote('history')
  async history(request: GitHistoryRequest): Promise<GitHistoryResult> {
    return historyOf(resolve(request.cwd), request)
  }

  /**
   * Read one commit's full metadata and its changed-file statistics.
   * @param request - directory and commit hash.
   * @returns the commit details or a structured failure.
   */
  @Remote('commitDetails')
  async commitDetails(request: GitCommitDetailsRequest): Promise<GitCommitDetailsResult> {
    return commitDetailsOf(resolve(request.cwd), request.hash)
  }

  /**
   * Read one file's content at a commit and at its first parent, for the
   * GUI's diff surface. Renames read the parent side through the old path.
   * @param request - directory, commit hash, and the new/old paths.
   * @returns the two sides or a structured failure.
   */
  @Remote('fileDiff')
  async fileDiff(request: GitFileDiffRequest): Promise<GitFileDiffResult> {
    return fileDiffOf(resolve(request.cwd), request)
  }

  /**
   * Move HEAD: checkout a branch by name, or detach at a commit by hash.
   * @param request - directory and the checkout target.
   * @returns ok, or a structured failure carrying git's message.
   */
  @Remote('checkout')
  async checkout(request: GitCheckoutRequest): Promise<GitMutationResult> {
    const cwd = resolve(request.cwd)
    if (request.kind === 'branch' && !validBranchName(request.target)) {
      return mutationFailure({ code: 'invalid-name', message: `无效的分支名：${request.target}` })
    }
    const outcome = await runGit(['checkout', request.target], cwd)
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
    const outcome = await runGit(['branch', request.name, request.atHash], cwd)
    if (failedOutcome(outcome)) {
      return mutationFailure(failureOf(outcome, `git branch failed in ${cwd}`, 'git-error'))
    }
    return { ok: true, failure: null }
  }
}

/** Produce one snapshot for a resolved directory, never throwing. */
async function snapshotOf(cwd: string): Promise<GitStatusSnapshot> {
  const rootOutcome = await runGit(['rev-parse', '--show-toplevel'], cwd)
  if (rootOutcome.spawnError !== null || rootOutcome.code !== 0 || rootOutcome.signal !== null) {
    return failedSnapshot(failureOf(rootOutcome, `git rev-parse failed in ${cwd}`))
  }
  /* v8 ignore next -- a successful rev-parse always prints the root path; the fallback answers the optional-index type. */
  const root = rootOutcome.stdout.trim().split('\n')[0] ?? cwd

  const statusOutcome = await runGit([
    '-c', 'core.quotepath=false',
    'status', '--porcelain=v2', '--branch',
  ], root)
  if (statusOutcome.spawnError !== null || statusOutcome.code !== 0 || statusOutcome.signal !== null) {
    return failedSnapshot(failureOf(statusOutcome, 'git status failed'))
  }

  const parsed = parsePorcelainV2(statusOutcome.stdout)
  const head = parsed.branch.oid === null
    ? null
    : await headTeaser(root)

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
async function headTeaser(root: string): Promise<GitStatusSnapshot['head']> {
  const outcome = await runGit(['log', '-1', '--format=%h%x1f%s'], root)
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
async function historyOf(cwd: string, request: GitHistoryRequest): Promise<GitHistoryResult> {
  const count = Math.min(Math.max(Math.trunc(request.count) || 0, 1), GIT_HISTORY_LIMIT)
  const skip = Math.max(Math.trunc(request.skip) || 0, 0)
  const outcome = await runGit([...historyArgs(count, skip)], cwd)
  if (failedOutcome(outcome)) {
    return { commits: [], truncated: false, failure: failureOf(outcome, `git log failed in ${cwd}`, 'git-error') }
  }
  const parsed = parseHistoryLog(outcome.stdout, count)
  return { commits: parsed.commits, truncated: parsed.truncated, failure: null }
}

/** Produce one commit's metadata and file statistics, never throwing. */
async function commitDetailsOf(cwd: string, hash: string): Promise<GitCommitDetailsResult> {
  const metaOutcome = await runGit([
    'log', '-1', '--format=%H%x1f%h%x1f%P%x1f%D%x1f%an%x1f%ae%x1f%aI%x1f%cI%x1f%B',
    hash, '--',
  ], cwd)
  if (failedOutcome(metaOutcome)) {
    return { details: null, failure: failureOf(metaOutcome, `git log failed in ${cwd}`, 'git-error') }
  }
  const filesOutcome = await runGit(['show', '--format=', '--numstat', '--find-renames', hash], cwd)
  if (failedOutcome(filesOutcome)) {
    return { details: null, failure: failureOf(filesOutcome, `git show failed in ${cwd}`, 'git-error') }
  }
  const details = parseCommitDetails(metaOutcome.stdout, parseNumstat(filesOutcome.stdout))
  /* v8 ignore next -- a successful git log always prints the fixed field layout; the null arm answers malformed output defensively. */
  if (details === null) {
    return { details: null, failure: { code: 'git-error', message: `无法解析提交 ${hash}` } }
  }
  return { details, failure: null }
}

/** Parse the metadata half of a commit-details read into the wire shape. */
function parseCommitDetails(
  output: string,
  files: GitCommitDetails['files'],
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
  }
}

/** Produce one file's two sides for the diff surface, never throwing. */
async function fileDiffOf(cwd: string, request: GitFileDiffRequest): Promise<GitFileDiffResult> {
  const newOutcome = await runGit(['show', `${request.hash}:${request.path}`], cwd)
  const newSide = sideState(newOutcome, 'new')
  if (newSide === 'failed') {
    return diffFailure(request.path, failureOf(newOutcome, 'git show failed'))
  }
  const oldOutcome = await runGit([
    'show', `${request.hash}^:${request.oldPath ?? request.path}`,
  ], cwd)
  const oldSide = sideState(oldOutcome, 'old')
  if (oldSide === 'failed') {
    return diffFailure(request.path, failureOf(oldOutcome, 'git show failed'))
  }
  const newText = newSide === 'missing' ? null : cappedText(newOutcome.stdout)
  const oldText = oldSide === 'missing' ? null : cappedText(oldOutcome.stdout)
  return {
    path: request.path,
    oldText: oldText?.text ?? null,
    newText: newText?.text ?? null,
    binary: oldText === null && newText === null,
    truncated: (oldText?.truncated ?? false) || (newText?.truncated ?? false),
    failure: null,
  }
}

/** One side's read disposition: clean, absent (new/deleted file), or failed. */
function sideState(outcome: CommandOutcome, side: 'new' | 'old'): 'ok' | 'missing' | 'failed' {
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
function cappedText(output: string): { text: string; truncated: boolean } | null {
  if (output.includes('\x00')) return null
  if (output.length > GIT_DIFF_BYTES_LIMIT) {
    return { text: output.slice(0, GIT_DIFF_BYTES_LIMIT), truncated: true }
  }
  return { text: output, truncated: false }
}

export default GitStatusGateway
