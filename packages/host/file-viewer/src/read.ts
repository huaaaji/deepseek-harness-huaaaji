/**
 * Pure read windowing for the file-viewer Remote: turn provider-decoded text
 * chunks into a bounded, line-numbered window and map a file extension to a
 * syntax-highlighting language hint. Mirrors the read tool's windowing
 * (packages/fs/tool-fs/src/read-render.ts) so the viewer and the model-facing
 * read share one bound contract.
 * @module @deepseek-ai/dsh-host-file-viewer/read
 */

import { FsError } from '@deepseek-ai/dsh-fs'
import type { FileViewerLine } from './types.ts'

/** Default maximum bytes returned for a file's windowed lines. */
export const DEFAULT_MAX_BYTES = 50 * 1024

/** Default maximum characters returned for a single line. */
export const DEFAULT_MAX_LINE_LENGTH = 2000

/** Default maximum number of lines returned by one read. */
export const DEFAULT_MAX_LINES = 2000

/** Default file size at or above which reads stream. */
export const DEFAULT_STREAM_MIN_SIZE = 10 * 1024 * 1024

/** Resolved read window the caller supplies to {@link buildWindow}. */
export interface ReadWindow {
  /** 1-based first line to return. */
  offset: number
  /** Maximum number of lines to return. */
  limit: number
  /** Maximum characters returned for a single line. */
  maxLineLength: number
  /** Maximum bytes of selected output. */
  maxBytes: number
}

/** The windowed result {@link buildWindow} produces. */
export interface WindowResult {
  /** Returned lines, already numbered. */
  lines: FileViewerLine[]
  /** Exact total line count in the file. */
  totalLines: number
  /** Whether selected output hit the byte cap. */
  truncatedByBytes: boolean
}

interface WindowAccumulator {
  lines: FileViewerLine[]
  totalLines: number
  outputBytes: number
  truncatedByBytes: boolean
}

function newAccumulator(): WindowAccumulator {
  return { lines: [], totalLines: 0, outputBytes: 0, truncatedByBytes: false }
}

function truncateLine(line: string, maxLineLength: number): string {
  return line.length > maxLineLength
    ? `${line.substring(0, maxLineLength)}... (line truncated to ${maxLineLength} chars)`
    : line
}

function lineByteSize(line: string, currentLineCount: number): number {
  return Buffer.byteLength(line, 'utf8') + (currentLineCount > 0 ? 1 : 0)
}

function consumeLine(acc: WindowAccumulator, rawLine: string, request: ReadWindow): void {
  acc.totalLines += 1
  if (acc.truncatedByBytes || acc.totalLines < request.offset || acc.lines.length >= request.limit) return

  const text = truncateLine(rawLine, request.maxLineLength)
  const bytes = lineByteSize(text, acc.lines.length)
  if (acc.outputBytes + bytes > request.maxBytes) {
    acc.truncatedByBytes = true
    return
  }
  acc.outputBytes += bytes
  acc.lines.push({ number: acc.totalLines, text })
}

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

function finish(acc: WindowAccumulator, request: ReadWindow, displayPath: string): WindowResult {
  if (!acc.truncatedByBytes && request.offset > acc.totalLines && !(acc.totalLines === 0 && request.offset === 1)) {
    throw new FsError(`offset ${request.offset} is out of range for "${displayPath}" (${acc.totalLines} lines)`, 'FS_NOT_FOUND')
  }
  return { lines: acc.lines, totalLines: acc.totalLines, truncatedByBytes: acc.truncatedByBytes }
}

/**
 * Build one window from streamed or whole-file chunks, enforcing line and byte
 * caps while still scanning to an exact total line count, and throwing
 * `FS_NOT_FOUND` when the requested offset is past EOF.
 * @param chunks - decoded text chunks in file order; chunk boundaries carry no meaning.
 * @param request - the resolved window.
 * @param displayPath - the caller-facing path used in the offset-out-of-range error.
 * @returns the numbered window lines, the total line count seen, and the byte-cap truncation flag.
 */
export async function buildWindow(
  chunks: AsyncIterable<string> | Iterable<string>,
  request: ReadWindow,
  displayPath: string,
): Promise<WindowResult> {
  const acc = newAccumulator()
  const lineBufferCap = request.maxLineLength + 1
  let lineBuffer = ''

  function appendToLineBuffer(segment: string): void {
    if (lineBuffer.length >= lineBufferCap) return
    lineBuffer += segment
    if (lineBuffer.length > lineBufferCap) lineBuffer = lineBuffer.slice(0, lineBufferCap)
  }

  function flushLine(): void {
    consumeLine(acc, stripCarriageReturn(lineBuffer), request)
    lineBuffer = ''
  }

  for await (const chunk of chunks) {
    let startPos = 0
    let newlinePos: number
    while ((newlinePos = chunk.indexOf('\n', startPos)) !== -1) {
      appendToLineBuffer(chunk.slice(startPos, newlinePos))
      flushLine()
      startPos = newlinePos + 1
    }
    appendToLineBuffer(chunk.slice(startPos))
  }
  if (lineBuffer.length > 0) flushLine()
  return finish(acc, request, displayPath)
}

/**
 * Lowercased file-extension to syntax-highlighting language hint. Keys are the
 * extension without its dot; an absent key means plain text. The map is
 * intentionally small — common source, config, and markup extensions a
 * line-numbered code view benefits from highlighting.
 */
const LANG_BY_EXTENSION: Readonly<Record<string, string>> = {
  ts: 'ts', tsx: 'tsx', mts: 'ts', cts: 'ts',
  js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
  json: 'json', jsonc: 'json',
  py: 'py', rb: 'rb', go: 'go', rs: 'rs', java: 'java',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cxx: 'cpp',
  cs: 'cs', kt: 'kotlin', swift: 'swift', php: 'php',
  sh: 'sh', bash: 'sh', zsh: 'sh',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'ini',
  md: 'md', markdown: 'md', mdx: 'mdx',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  sql: 'sql', xml: 'xml', lua: 'lua',
}

/**
 * Derive a syntax-highlighting language hint from a path's file extension.
 * @param path - the model-facing path the read reported.
 * @returns the language hint, or `undefined` when the extension maps to none.
 */
export function langFromPath(path: string): string | undefined {
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return undefined
  const ext = base.slice(dot + 1).toLowerCase()
  return Object.hasOwn(LANG_BY_EXTENSION, ext) ? LANG_BY_EXTENSION[ext] : undefined
}
