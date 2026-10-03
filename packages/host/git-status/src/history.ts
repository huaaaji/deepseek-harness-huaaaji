/** History/log parsing and mutation validation for the git-status Remote. */

import type {
  GitCommitFileStat, GitCommitView, GitRefLabel,
} from './types.ts'

/** Default page cap keeping one history read bounded; the `historyLimit` config overrides it. */
export const GIT_HISTORY_LIMIT = 500

/** Default per-side cap for file diff content; the `diffBytesLimit` config overrides it. */
export const GIT_DIFF_BYTES_LIMIT = 65_536

/** Field separator inside one log record. */
const FIELD_SEP = '\x1f'
/** Record separator between log entries. */
const RECORD_SEP = '\x1e'

/** The porcelain-ish log format one record is parsed from. */
const LOG_FORMAT = [
  '%H', '%h', '%P', '%D', '%an', '%ae', '%aI', '%s',
].join(FIELD_SEP) + RECORD_SEP

/** One parsed page of the custom log format. */
export interface ParsedHistory {
  readonly commits: readonly GitCommitView[]
  /** True when the window contained more records than requested. */
  readonly truncated: boolean
}

/**
 * Parse the custom-separator `git log` output. Every record carries exactly
 * eight fields; the trailing record separator leaves one empty tail entry.
 * @param output - raw stdout of the custom-format log.
 * @param limit - page size used to detect truncation (limit+1 records = more).
 * @returns the parsed page.
 */
export function parseHistoryLog(output: string, limit: number): ParsedHistory {
  const records = output.split(RECORD_SEP)
  const commits: GitCommitView[] = []
  for (const record of records) {
    // git terminates every record with a newline after the separator, so the
    // next chunk opens with it; strip it before field parsing.
    const commit = parseCommitRecord(record.startsWith('\n') ? record.slice(1) : record)
    if (commit !== null) commits.push(commit)
    if (commits.length > limit) break
  }
  const truncated = commits.length > limit
  if (truncated) commits.pop()
  return { commits, truncated }
}

/** Parse one custom-format record into a commit view, or null when malformed. */
function parseCommitRecord(record: string): GitCommitView | null {
  const fields = record.split(FIELD_SEP)
  if (fields.length !== 8) return null
  const [hash = '', shortHash = '', parentsRaw = '', decorate = '', author = '', authorEmail = '', authorDate = '', subject = ''] = fields
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
    subject,
  }
}

/**
 * Parse the `%D` decorate field: `HEAD -> main, origin/main, tag: v1.0`.
 *
 * A ` -> ` decoration is a symbolic ref. Only `HEAD -> <branch>` is drawn;
 * every other alias (`origin/HEAD -> origin/main`, and the same shape under a
 * differently named remote) names a ref the graph does not carry.
 * @param decorate - the raw `%D` field, or an empty string.
 * @returns one label per drawable decoration, in decoration order.
 */
export function parseRefs(decorate: string): readonly GitRefLabel[] {
  if (decorate.trim() === '') return []
  const refs: GitRefLabel[] = []
  for (const part of decorate.split(', ')) {
    if (part === '') continue
    const symref = /^(.*) -> (.*)$/.exec(part)
    if (symref !== null) {
      const [target = '', name = ''] = symref.slice(1)
      if (target === 'HEAD') refs.push({ kind: 'head', name })
      continue
    }
    if (part === 'HEAD') {
      refs.push({ kind: 'head', name: '' })
      continue
    }
    if (part.startsWith('tag: ')) {
      refs.push({ kind: 'tag', name: part.slice('tag: '.length) })
      continue
    }
    if (part.includes('/')) refs.push({ kind: 'remote', name: part })
    else refs.push({ kind: 'branch', name: part })
  }
  return refs
}

/**
 * The args of one bounded history read. `--topo-order` alone decides the order:
 * it keeps parents after their children and holds each branch on its own line,
 * which is the layout the graph draws. Adding `--date-order` would select
 * commit-date order instead, because git lets the later sort flag win.
 * @param count - commits to return, one extra record is requested for truncation.
 * @param skip - commits to skip for paging.
 * @returns the `git log` argument list.
 */
export function historyArgs(count: number, skip: number): readonly string[] {
  return [
    'log', '--all', '--topo-order',
    `--max-count=${count + 1}`, `--skip=${skip}`,
    `--format=${LOG_FORMAT}`,
  ]
}

/**
 * Parse `git show --format= --numstat -z` output into per-file statistics.
 *
 * Every record is NUL-terminated and paths are never quoted. A rename record
 * carries an empty path field, then the old path and the new path as its own
 * NUL-terminated fields; git spells that pair the same way whether or not the
 * two paths share a prefix, so no brace-compressed form reaches this parser.
 * @param output - raw stdout of the `-z` numstat read.
 * @returns one statistic per changed file, in git's order.
 */
export function parseNumstat(output: string): readonly GitCommitFileStat[] {
  const records = output.split('\0')
  const files: GitCommitFileStat[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record === undefined || record === '') continue
    const [added = '', removed = '', ...pathFields] = record.split('\t')
    const inlinePath = pathFields.join('\t')
    if (inlinePath !== '') {
      files.push(numstatOf(inlinePath, null, added, removed))
      continue
    }
    const oldPath = records[index + 1]
    const path = records[index + 2]
    index += 2
    if (oldPath === undefined || path === undefined || oldPath === '' || path === '') continue
    files.push(numstatOf(path, oldPath, added, removed))
  }
  return files
}

/** One numstat row, with `-` counts reading as binary. */
function numstatOf(
  path: string,
  oldPath: string | null,
  added: string,
  removed: string,
): GitCommitFileStat {
  const binary = added === '-' && removed === '-'
  return {
    path,
    oldPath,
    added: binary ? null : Number(added),
    removed: binary ? null : Number(removed),
  }
}

/**
 * Parse `git branch [--remotes] --contains` output into plain branch names.
 * The `* ` marker of the current branch is stripped; detached-HEAD markers
 * and `origin/HEAD -> …` aliases are dropped.
 * @param output - raw stdout of the branch listing.
 * @returns the branch names in git's listing order.
 */
export function parseBranchList(output: string): readonly string[] {
  const names: string[] = []
  for (const rawLine of output.split('\n')) {
    let name = rawLine.trim()
    if (name === '') continue
    if (name.startsWith('* ')) name = name.slice(2)
    if (name.startsWith('(')) continue
    if (name.includes('->')) continue
    names.push(name)
  }
  return names
}

/**
 * The practical subset of `git check-ref-format` rules the GUI enforces
 * before asking git: no control/space/shell-significant characters, no `..`,
 * no leading dash, no trailing dot, no bare `@`, no leading/trailing slash.
 * @param name - the branch name from the wire.
 * @returns true when the name is safe to pass as a git argument.
 */
export function validBranchName(name: string): boolean {
  if (name.length === 0 || name.length > 250) return false
  if (name.startsWith('-') || name.endsWith('.')) return false
  if (name.startsWith('/') || name.endsWith('/')) return false
  if (name.includes('..') || name.includes('@{') || name.includes('\\')) return false
  if (name === '@') return false
  if (/[\x00-\x20~^:?*[]/.test(name)) return false
  return true
}

/**
 * Whether a wire string is a hexadecimal object name. git accepts an
 * abbreviated object name, so 7 to 40 hex digits pass; anything else (notably
 * a leading `-`, which git would read as an option) is refused before the
 * value reaches an argument list.
 * @param value - the revision string from the wire.
 * @returns true when the value is a bare hexadecimal object name.
 */
export function validObjectId(value: string): boolean {
  return /^[0-9a-fA-F]{7,40}$/.test(value)
}

/**
 * Whether a wire string is a repository-relative path safe to place after a
 * `<revision>:` object name.
 * @param value - the path string from the wire.
 * @returns true when the path is non-empty, relative, and holds no NUL.
 */
export function validRepoPath(value: string): boolean {
  if (value.length === 0) return false
  if (value.startsWith('/')) return false
  return !value.includes('\0')
}
