/** Wire-failure mapping and request-window normalization for the file-viewer Remote. */

import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsErrorCode } from '@deepseek-ai/dsh-fs'
import type { FileViewerFailure, FileViewerFailureCode } from './types.ts'

/** Map a filesystem error code to the wire failure vocabulary. */
export function failureCode(code: FsErrorCode): FileViewerFailureCode {
  switch (code) {
    case 'FS_NOT_FOUND': return 'not-found'
    case 'FS_NOT_DIRECTORY': return 'not-directory'
    case 'FS_NOT_TEXT': return 'not-text'
    case 'FS_NOT_REGULAR_FILE': return 'not-regular-file'
    case 'FS_TOO_LARGE': return 'too-large'
    case 'FS_PERMISSION_DENIED': return 'permission-denied'
    case 'FS_SANDBOX_DENIED': return 'sandbox-denied'
    case 'FS_ABORTED': return 'aborted'
    default: return 'io-error'
  }
}

/** Convert any caught error into a structured wire failure. */
export function failureOf(error: unknown): FileViewerFailure {
  if (error instanceof FsError) {
    return { code: failureCode(error.code), message: error.message }
  }
  if (error instanceof Error) {
    return { code: 'io-error', message: error.message }
  }
  return { code: 'io-error', message: String(error) }
}

/** Clamp a client offset to a positive 1-based integer. */
export function resolveOffset(value: number): number {
  return Number.isInteger(value) && value >= 1 ? value : 1
}

/** Clamp a client limit to a positive integer no larger than the line cap. */
export function resolveLimit(value: number, maxLines: number): number {
  if (!Number.isInteger(value) || value < 1) return maxLines
  return Math.min(value, maxLines)
}
