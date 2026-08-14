/** History/log parsing and mutation validation for the git-status Remote. */

import type {
  GitCommitFileStat, GitCommitView, GitRefLabel,
} from './types.ts'

/** Hard cap keeping one history page bounded. */
export const GIT_HISTORY_LIMIT = 500

/** Per-side byte cap for file diff content. */
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

/** Parse the `%D` decorate field: `HEAD -> main, origin/main, tag: v1.0`. */
export function parseRefs(decorate: string): readonly GitRefLabel[] {
  if (decorate.trim() === '') return []
  const refs: GitRefLabel[] = []
  for (const part of decorate.split(', ')) {
    if (part === '') continue
    if (part.startsWith('HEAD -> ')) {
      refs.push({ kind: 'head', name: part.slice('HEAD -> '.length) })
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
    if (part.startsWith('origin/HEAD')) continue
    if (part.includes('/')) refs.push({ kind: 'remote', name: part })
    else refs.push({ kind: 'branch', name: part })
  }
  return refs
}

/** The args of one bounded history read. */
export function historyArgs(count: number, skip: number): readonly string[] {
  return [
    'log', '--all', '--topo-order', '--date-order',
    `--max-count=${count + 1}`, `--skip=${skip}`,
    `--format=${LOG_FORMAT}`,
  ]
}

/** Parse `git show --format= --numstat` output into per-file statistics. */
export function parseNumstat(output: string): readonly GitCommitFileStat[] {
  const files: GitCommitFileStat[] = []
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trimEnd()
    if (line === '') continue
    const [addedRaw, removedRaw, ...pathParts] = line.split('\t')
    if (addedRaw === undefined || removedRaw === undefined) continue
    const pathField = pathParts.join('\t')
    if (pathField === '') continue
    if (addedRaw === '-' && removedRaw === '-') {
      files.push({ path: pathField, oldPath: null, added: null, removed: null })
      continue
    }
    const rename = pathField.split(' => ')
    if (rename.length === 2) {
      const [oldPath = pathField, path = pathField] = rename
      files.push({
        path,
        oldPath,
        added: Number(addedRaw),
        removed: Number(removedRaw),
      })
    } else {
      files.push({
        path: pathField,
        oldPath: null,
        added: Number(addedRaw),
        removed: Number(removedRaw),
      })
    }
  }
  return files
}

/**
 * The practical subset of `git check-ref-format` rules the GUI enforces
 * before asking git: no control/space/shell-significant characters, no `..`,
 * no leading dash, no trailing dot, no bare `@`, no leading/trailing slash.
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
