/** Read-only file/directory Remote over ctx.fs for the Web GUI file viewer. */

import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import z from '@deepseek-ai/schemastery'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
// Typert-generated ./typert and ./remote artifacts import Zod at runtime.
import type {} from 'zod'
import { failureOf, resolveLimit, resolveOffset } from './failure.ts'
import {
  buildWindow,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINE_LENGTH,
  DEFAULT_MAX_LINES,
  DEFAULT_STREAM_MIN_SIZE,
  langFromPath,
} from './read.ts'
import type {
  FileViewerEntry,
  FileViewerFailure,
  FileViewerListRequest,
  FileViewerListResult,
  FileViewerReadRequest,
  FileViewerReadResult,
} from './types.ts'

export type * from './types.ts'

/** Default maximum directory entries returned by one list. */
export const DEFAULT_MAX_ENTRIES = 1000

/** Deployment-varying bounds of the file-viewer Remote. Every field defaults in
 * the schema, so a deployment changes one in cordis.yml without editing code. */
export interface FileViewerConfig {
  /** Maximum directory entries returned by one list. */
  maxEntries?: number
  /** Maximum bytes returned for a file's windowed lines. */
  maxBytes?: number
  /** Maximum characters returned for a single line. */
  maxLineLength?: number
  /** Maximum number of lines returned by one read. */
  maxLines?: number
  /** Files at or above this size stream; smaller files read whole into memory. */
  streamMinSize?: number
}

/** Remote-only service answering bounded file/directory reads through ctx.fs. */
export class FileViewerGateway extends TypertRemoteService {
  static inject = ['fs']

  static Config: z<FileViewerConfig> = z.object({
    maxEntries: z.number().step(1).min(1).default(DEFAULT_MAX_ENTRIES),
    maxBytes: z.number().step(1).min(1).default(DEFAULT_MAX_BYTES),
    maxLineLength: z.number().step(1).min(1).default(DEFAULT_MAX_LINE_LENGTH),
    maxLines: z.number().step(1).min(1).default(DEFAULT_MAX_LINES),
    streamMinSize: z.number().step(1).min(1).default(DEFAULT_STREAM_MIN_SIZE),
  })

  private readonly resolved: Required<FileViewerConfig>

  constructor(ctx: Context, config: FileViewerConfig = {}) {
    super(ctx, 'fileViewer')
    this.resolved = {
      maxEntries: config.maxEntries ?? DEFAULT_MAX_ENTRIES,
      maxBytes: config.maxBytes ?? DEFAULT_MAX_BYTES,
      maxLineLength: config.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH,
      maxLines: config.maxLines ?? DEFAULT_MAX_LINES,
      streamMinSize: config.streamMinSize ?? DEFAULT_STREAM_MIN_SIZE,
    }
  }

  /**
   * List one directory's direct children, name-sorted by the backend, with
   * special files dropped and a bounded head. Failures are reported inside the
   * result rather than as RPC errors so the GUI renders a stable surface.
   * @param request - the directory to list.
   * @returns the bounded listing.
   */
  @Remote('list')
  async list(request: FileViewerListRequest): Promise<FileViewerListResult> {
    try {
      const target = await this.ctx.fs.resolve(request.path)
      const info = await this.ctx.fs.stat(target)
      if (info === undefined) {
        return listFailure(request.path, { code: 'not-found', message: `路径不存在：${request.path}` })
      }
      if (info.type !== 'directory') {
        return listFailure(request.path, { code: 'not-directory', message: `不是目录：${request.path}` })
      }
      const children = await this.ctx.fs.listDir(target)
      const entries: FileViewerEntry[] = []
      for (const child of children) {
        if (child.type === 'other') continue
        entries.push({ name: child.name, kind: child.type, size: child.size ?? 0 })
      }
      const truncated = entries.length > this.resolved.maxEntries
      return {
        path: target.displayPath,
        entries: entries.slice(0, this.resolved.maxEntries),
        truncated,
        failure: null,
      }
    } catch (error) {
      return listFailure(request.path, failureOf(error))
    }
  }

  /**
   * Read one file as a bounded, line-numbered text window. Binary files report
   * `binary: true` with an empty window; every other failure is carried in
   * `failure` beside the empty default state.
   * @param request - the file to read plus the 1-based line window.
   * @returns the numbered window and its syntax hint.
   */
  @Remote('read')
  async read(request: FileViewerReadRequest): Promise<FileViewerReadResult> {
    const offset = resolveOffset(request.offset)
    const limit = resolveLimit(request.limit, this.resolved.maxLines)
    try {
      const target = await this.ctx.fs.resolve(request.path)
      const info = await this.ctx.fs.stat(target)
      if (info === undefined) {
        return readFailure(request.path, offset, { code: 'not-found', message: `路径不存在：${request.path}` })
      }
      if (info.type !== 'file') {
        return readFailure(request.path, offset, { code: 'not-regular-file', message: `不是普通文件：${request.path}` })
      }
      // Stream when the file is large OR size is unknown, so a size-less backend
      // never buffers an arbitrarily large file (mirrors the read tool).
      const chunks = info.size === undefined || info.size >= this.resolved.streamMinSize
        ? await this.ctx.fs.streamText(target, undefined)
        : [await this.ctx.fs.readText(target, undefined)]
      const window = await buildWindow(
        chunks,
        { offset, limit, maxLineLength: this.resolved.maxLineLength, maxBytes: this.resolved.maxBytes },
        target.displayPath,
      )
      return {
        path: target.displayPath,
        offset,
        lines: window.lines,
        totalLines: window.totalLines,
        truncatedByBytes: window.truncatedByBytes,
        binary: false,
        language: langFromPath(target.displayPath) ?? null,
        failure: null,
      }
    } catch (error) {
      // A binary file is a successful domain outcome: report it as binary with
      // an empty window instead of a failure the GUI would render as an error.
      if (error instanceof FsError && error.code === 'FS_NOT_TEXT') {
        return {
          path: request.path,
          offset,
          lines: [],
          totalLines: 0,
          truncatedByBytes: false,
          binary: true,
          language: null,
          failure: null,
        }
      }
      return readFailure(request.path, offset, failureOf(error))
    }
  }
}

/** A failed list result whose `failure` is set and every other field is empty. */
function listFailure(path: string, failure: FileViewerFailure): FileViewerListResult {
  return { path, entries: [], truncated: false, failure }
}

/** A failed read result whose `failure` is set and every other field is empty. */
function readFailure(path: string, offset: number, failure: FileViewerFailure): FileViewerReadResult {
  return {
    path,
    offset,
    lines: [],
    totalLines: 0,
    truncatedByBytes: false,
    binary: false,
    language: null,
    failure,
  }
}

export default FileViewerGateway
