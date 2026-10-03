/** Minimal git runner and porcelain-v2 parser for the status Remote. */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import type {
  GitBranchState, GitHeadState, GitStatusEntry, GitStatusFileState, GitStatusFailure,
} from './types.ts'

/** Default kill-after deadline for one git read; the `timeoutMs` config overrides it. */
export const GIT_TIMEOUT_MS = 15_000

/** One terminated child-process run. */
export interface CommandOutcome {
  /** Exit code, or null when the process failed to spawn. */
  readonly code: number | null
  /** Terminating signal, or null. */
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  /** Spawn failure (ENOENT for a missing git), or null. */
  readonly spawnError: NodeJS.ErrnoException | null
  /**
   * True when stdout reached the requested character budget and the child was
   * killed, so `stdout` holds a prefix of the full output. Only a run that
   * passed `maxStdoutChars` can set it.
   */
  readonly truncated: boolean
  /** True when the child never started because `cwd` is not an existing directory. */
  readonly directoryMissing: boolean
}

/** One git invocation's budget. */
export interface GitRunOptions {
  /** Kill-after deadline; defaults to {@link GIT_TIMEOUT_MS}. */
  readonly timeoutMs?: number
  /**
   * Character budget for stdout. A read past it stops and kills the child, so
   * one oversized blob cannot grow the host's heap to the file size; the
   * outcome then reports `truncated`.
   */
  readonly maxStdoutChars?: number
}

/**
 * Run one git command with a hard timeout and an optional stdout budget.
 *
 * Every invocation runs in the C locale: this package reads git's diagnostics
 * (to tell an absent path from an unreadable object) and shows git's first
 * stderr line as a failure message, so a translated message would make the
 * same repository read differently per host environment. Repository content is
 * unaffected — paths, author names, and ISO dates do not follow the locale.
 * @param args - arguments after `git`.
 * @param cwd - directory the child runs in; a missing directory reports
 * `directoryMissing` instead of a spawn error, because git reports both as
 * ENOENT and only the caller can name the reason.
 * @param options - kill-after deadline and stdout character budget.
 * @returns the terminated outcome; never throws.
 */
export function runGit(
  args: readonly string[],
  cwd: string,
  options: GitRunOptions = {},
): Promise<CommandOutcome> {
  const { timeoutMs = GIT_TIMEOUT_MS, maxStdoutChars } = options
  return new Promise((resolve) => {
    let settled = false
    let truncated = false
    let child: ReturnType<typeof spawn> | null = null
    try {
      child = spawn('git', [...args], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, LC_ALL: 'C' },
      })
      /* v8 ignore start -- spawn throws synchronously only for malformed arguments; every real failure arrives through the error event. */
    } catch (error) {
      resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        spawnError: asErrno(error),
        truncated: false,
        directoryMissing: false,
      })
      return
      /* v8 ignore stop */
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, timeoutMs)
    const finish = (outcome: CommandOutcome): void => {
      /* v8 ignore next 2 -- a settled run can only finish once; the guard answers error+exit double-delivery. */
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    let stdout = ''
    let stderr = ''
    child.on('error', (error) => {
      const errno = asErrno(error)
      // git reports a missing binary and a missing working directory through
      // the same ENOENT; only this side knows which one the caller asked for.
      const missingDirectory = errno.code === 'ENOENT' && !existsSync(cwd)
      finish({
        code: null,
        signal: null,
        stdout,
        stderr,
        spawnError: missingDirectory ? null : errno,
        truncated,
        directoryMissing: missingDirectory,
      })
    })
    // `exit` (not `close`): an `!alias` git command runs through a shell whose
    // children inherit the stdio pipes, so `close` would wait for those
    // grandchildren to finish even after the git process itself is gone.
    child.on('exit', (code, signal) => {
      finish({ code, signal, stdout, stderr, spawnError: null, truncated, directoryMissing: false })
    })
    const stdoutStream = child.stdout
    const stderrStream = child.stderr
    /* v8 ignore start -- the pipe stdio configuration always yields both streams; the guard is type-level defense. */
    if (stdoutStream === null || stderrStream === null) {
      finish({ code: null, signal: null, stdout: '', stderr: '', spawnError: asErrno(new Error('stdio streams unavailable')), truncated: false, directoryMissing: false })
      return
    }
    /* v8 ignore stop */
    // Decoding at the stream keeps a multi-byte character split across two
    // pipe chunks from becoming replacement characters.
    stdoutStream.setEncoding('utf8')
    stderrStream.setEncoding('utf8')
    stdoutStream.on('data', (chunk: string) => {
      if (maxStdoutChars === undefined) {
        stdout += chunk
        return
      }
      const room = maxStdoutChars - stdout.length
      if (chunk.length <= room) {
        stdout += chunk
        return
      }
      // Past the budget the remaining room is spent once; a chunk that arrives
      // after the kill leaves the capped prefix unchanged.
      stdout += room > 0 ? chunk.slice(0, room) : ''
      // A cut through a surrogate pair would leave one lone code unit.
      const last = stdout.charCodeAt(stdout.length - 1)
      if (last >= 0xd800 && last <= 0xdbff) stdout = stdout.slice(0, -1)
      truncated = true
      child.kill('SIGKILL')
    })
    stderrStream.on('data', (chunk: string) => { stderr += chunk })
  })
}

/** Normalize an unknown spawn error into the ErrnoException shape. */
function asErrno(error: unknown): NodeJS.ErrnoException {
  /* v8 ignore start -- child_process error events and sync spawn throws always deliver Error instances; this arm is type-level defense. */
  if (error instanceof Error) return error
  return new Error(String(error))
  /* v8 ignore stop */
}

/**
 * Map a failed git run onto the wire failure type. `directoryMissing` and a
 * spawn-time ENOENT are reported separately, because git uses the same errno
 * for a missing binary and a missing working directory.
 * @param outcome - the terminated run.
 * @param fallback - message used when git printed no diagnostic line.
 * @param nonZeroCode - code for a plain non-zero exit; the caller names the
 * read that failed, since the same exit status means different things per call.
 * @returns the wire failure.
 */
export function failureOf(
  outcome: CommandOutcome,
  fallback: string,
  nonZeroCode: GitStatusFailure['code'] = 'not-a-repo',
): GitStatusFailure {
  if (outcome.directoryMissing) return { code: 'not-a-repo', message: 'working directory does not exist' }
  const message = outcome.spawnError?.message
    ?? (outcome.stderr.trim().split('\n')[0] || fallback)
  if (outcome.spawnError !== null && outcome.spawnError.code === 'ENOENT') {
    return { code: 'git-unavailable', message }
  }
  if (outcome.signal !== null) return { code: 'timeout', message }
  if (outcome.code !== null && outcome.code !== 0) return { code: nonZeroCode, message }
  return { code: 'git-error', message }
}

/**
 * Whether one child-process run finished cleanly. A capped run that stopped at
 * its budget reports failure here, because the exit status no longer reflects
 * the command; a caller that asked for a cap reads `truncated` instead.
 * @param outcome - the terminated run.
 * @returns true when git did not deliver a complete, successful read.
 */
export function failedOutcome(outcome: CommandOutcome): boolean {
  return outcome.directoryMissing
    || outcome.spawnError !== null
    || outcome.code !== 0
    || outcome.signal !== null
}

/** Parsed porcelain-v2 `# branch.*` headers (mutable parse accumulator). */
export interface ParsedBranchHeader {
  oid: string | null
  name: string | null
  upstream: string | null
  ahead: number
  behind: number
}

/** Whole-window parse of `git status --porcelain=v2 --branch` output. */
export interface ParsedStatus {
  readonly branch: ParsedBranchHeader
  readonly entries: readonly GitStatusEntry[]
}

const EMPTY_BRANCH: ParsedBranchHeader = { oid: null, name: null, upstream: null, ahead: 0, behind: 0 }

/**
 * Parse porcelain-v2 output into branch facts and per-file entries.
 * Paths are taken verbatim (the caller disables core.quotepath), so parsing
 * relies on the field layout, never on splitting the path itself. A path that
 * git still C-quotes (one holding a quote, backslash, or control character)
 * keeps its quoting; only a carriage return is stripped from the line, because
 * a path may legitimately end in a space.
 * @param output - raw stdout of `git status --porcelain=v2 --branch`.
 * @returns the parsed branch header and file entries.
 */
export function parsePorcelainV2(output: string): ParsedStatus {
  const branch: ParsedBranchHeader = { ...EMPTY_BRANCH }
  const entries: GitStatusEntry[] = []
  for (const rawLine of output.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith('# ')) {
      parseBranchHeader(branch, line.slice(2))
      continue
    }
    if (line.startsWith('1 ')) {
      const entry = parseRegular(line.slice(2))
      if (entry !== null) entries.push(entry)
      continue
    }
    if (line.startsWith('2 ')) {
      const entry = parseRename(line.slice(2))
      if (entry !== null) entries.push(entry)
      continue
    }
    if (line.startsWith('u ')) {
      const entry = parseUnmerged(line.slice(2))
      if (entry !== null) entries.push(entry)
      continue
    }
    if (line.startsWith('? ')) {
      entries.push({
        path: line.slice(2),
        oldPath: null,
        state: 'untracked',
        staged: false,
      })
    }
  }
  return { branch, entries }
}

/** Apply one `# branch.<key> <value>` header line onto the accumulating state. */
function parseBranchHeader(branch: ParsedBranchHeader, header: string): void {
  const space = header.indexOf(' ')
  if (space === -1) return
  const key = header.slice(0, space)
  const value = header.slice(space + 1)
  switch (key) {
    case 'branch.oid':
      branch.oid = value === '(initial)' ? null : value
      break
    case 'branch.head':
      branch.name = value === '(detached)' ? null : value
      break
    case 'branch.upstream':
      branch.upstream = value
      break
    case 'branch.ab': {
      const match = /^\+(\d+) -(\d+)$/.exec(value)
      if (match !== null) {
        branch.ahead = Number(match[1])
        branch.behind = Number(match[2])
      }
      break
    }
  }
}

/** One `1 <XY> ... <path>` record: the path is the tail after the fixed fields. */
function parseRegular(payload: string): GitStatusEntry | null {
  const xy = firstToken(payload)
  if (xy.length !== 2) return null
  const path = afterTokens(payload, 7)
  if (path === null) return null
  return entryOf(xy, payload.slice(path), null)
}

/** One `2 <XY> ... <X><score> <path><sep><origPath>` record. The new path
 * comes first; git separates the two with a tab, falling back to ` -> ` when
 * the paths contain tabs themselves. */
function parseRename(payload: string): GitStatusEntry | null {
  const xy = firstToken(payload)
  if (xy.length !== 2) return null
  const pathStart = afterTokens(payload, 8)
  if (pathStart === null) return null
  const rest = payload.slice(pathStart)
  const tab = rest.indexOf('\t')
  if (tab !== -1) {
    return entryOf(xy, rest.slice(0, tab), rest.slice(tab + 1))
  }
  const arrow = rest.indexOf(' -> ')
  if (arrow === -1) return null
  return entryOf(xy, rest.slice(0, arrow), rest.slice(arrow + 4))
}

/** The first space-delimited token, or the whole payload when there is none. */
function firstToken(payload: string): string {
  const space = payload.indexOf(' ')
  return space === -1 ? payload : payload.slice(0, space)
}

/** One `u <XY> ... <h1> <h2> <h3> <path>` unmerged record. */
function parseUnmerged(payload: string): GitStatusEntry | null {
  const path = afterTokens(payload, 9)
  if (path === null) return null
  return { path: payload.slice(path), oldPath: null, state: 'conflicted', staged: false }
}

/** Byte offset just past the Nth space-delimited token, or null when absent. */
function afterTokens(payload: string, count: number): number | null {
  let pos = 0
  for (let i = 0; i < count; i++) {
    const next = payload.indexOf(' ', pos)
    if (next === -1) return null
    pos = next + 1
  }
  return pos
}

/** Derive the display state and staging flags from a porcelain-v2 XY pair.
 * In each column ` ` means unmodified and `.` means the change is absent on
 * that side, so a change counts as staged only when the index column carries
 * a real status letter. */
function entryOf(xy: string, path: string, oldPath: string | null): GitStatusEntry {
  const index = xy.charCodeAt(0)
  const staged = index !== 0x20 /* ' ' */ && index !== 0x2E /* '.' */
  return { path, oldPath, state: fileState(xy), staged: stateConflicted(xy) ? false : staged }
}

/** Whether the XY pair signals an unresolved merge conflict. Conflicts appear
 * only in `u` records, whose letters include `U` on either side. */
function stateConflicted(xy: string): boolean {
  return xy[0] === 'U' || xy[1] === 'U'
}

/** Map an XY pair onto one display state; conflicts always win. */
function fileState(xy: string): GitStatusFileState {
  if (stateConflicted(xy)) return 'conflicted'
  if (xy[0] === 'A' || xy[0] === 'C') return 'added'
  if (xy[0] === 'R') return 'renamed'
  if (xy[0] === 'D' || xy[1] === 'D') return 'deleted'
  return 'modified'
}

/**
 * Build the wire branch state from parsed headers.
 * @param parsed - the `# branch.*` accumulator from {@link parsePorcelainV2}.
 * @returns the branch facts the snapshot carries.
 */
export function branchStateOf(parsed: ParsedBranchHeader): GitBranchState {
  return {
    name: parsed.name,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
  }
}

/**
 * Parse the `%h<US>%s` head-teaser line.
 * @param line - the single log line, already trimmed of its terminator.
 * @returns the short hash and subject, or null when the line is not that pair.
 */
export function parseHeadTeaser(line: string): GitHeadState | null {
  const separator = line.indexOf('\x1f')
  if (separator === -1) return null
  const shortHash = line.slice(0, separator)
  const subject = line.slice(separator + 1)
  if (shortHash.length === 0 || subject.length === 0) return null
  return { shortHash, subject }
}
