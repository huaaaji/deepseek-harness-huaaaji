/** Wire types for the file-viewer Remote: bounded directory listings and line-numbered text windows. */

/** Why a list or read could not answer. */
export type FileViewerFailureCode =
  | 'not-found'
  | 'not-directory'
  | 'not-text'
  | 'not-regular-file'
  | 'too-large'
  | 'permission-denied'
  | 'sandbox-denied'
  | 'io-error'
  | 'aborted'

/** Structured failure carried inside an otherwise complete result. */
export interface FileViewerFailure {
  readonly code: FileViewerFailureCode
  readonly message: string
}

/** Remote request: list one directory's direct children. */
export interface FileViewerListRequest {
  /** Absolute directory to list; relative paths resolve against the process cwd. */
  readonly path: string
}

/** One direct child the GUI lists. */
export interface FileViewerEntry {
  /** Basename of the child inside the listed directory. */
  readonly name: string
  /** Whether the child is a regular file or a directory. */
  readonly kind: 'file' | 'directory'
  /** Byte size of a regular file, 0 for a directory. */
  readonly size: number
}

/** Directory listing result. `failure` is non-null exactly when the listing could not answer. */
export interface FileViewerListResult {
  /** The resolved directory path that answered. */
  readonly path: string
  readonly entries: readonly FileViewerEntry[]
  /** True when more children exist beyond the returned head. */
  readonly truncated: boolean
  readonly failure: FileViewerFailure | null
}

/** Remote request: read one file as a bounded, line-numbered window. */
export interface FileViewerReadRequest {
  /** Absolute file path to read; relative paths resolve against the process cwd. */
  readonly path: string
  /** 1-based first line to return. */
  readonly offset: number
  /** Maximum number of lines to return. */
  readonly limit: number
}

/** One line of a file window, keeping its file line number. */
export interface FileViewerLine {
  /** 1-based line number in the file. */
  readonly number: number
  /** Line text without its trailing newline. */
  readonly text: string
}

/** File read result. `failure` is non-null exactly when the read could not answer. */
export interface FileViewerReadResult {
  /** The resolved file path that answered. */
  readonly path: string
  /** The 1-based first line the window requested, kept even when `lines` is empty. */
  readonly offset: number
  readonly lines: readonly FileViewerLine[]
  /** Exact total line count in the file. */
  readonly totalLines: number
  /** True when the selected output hit the byte cap. */
  readonly truncatedByBytes: boolean
  /** True when the file carries a NUL byte and cannot be shown as text. */
  readonly binary: boolean
  /** Syntax-highlighting language hint from the extension, or null for plain text. */
  readonly language: string | null
  readonly failure: FileViewerFailure | null
}
