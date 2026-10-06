/**
 * Recap text normalization: terminal-safe, single-line, UTF-8 bounded output
 * for text a client displays in a transcript row.
 */

/** Operating-system-command escapes, terminated or truncated at the end of input. */
const OSC_ESCAPE = /(?:\u001B\]|\u009D)[\s\S]*?(?:\u0007|\u001B\\|$)/gu
/** Control-sequence-introducer escapes, including SGR color codes. */
const CSI_ESCAPE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu
/** Remaining two-byte escape sequences. */
const SHORT_ESCAPE = /\u001B[@-_]/gu
/** Non-whitespace C0 and C1 control characters. */
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu
/** Invisible and directional controls that can reorder or hide displayed text. */
const INVISIBLE_CONTROL = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu

/** Reject a non-positive integer limit. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}

/** Remove escape sequences and invisible controls, then collapse to one line. */
function singleDisplayLine(input: string): string {
  return input
    .replace(OSC_ESCAPE, '')
    .replace(CSI_ESCAPE, '')
    .replace(SHORT_ESCAPE, '')
    .replace(CONTROL_CHARACTER, '')
    .replace(INVISIBLE_CONTROL, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Truncate text to a UTF-8 byte budget without splitting a Unicode code point.
 * @param input - text to bound.
 * @param maxBytes - positive UTF-8 byte budget.
 * @returns the longest leading code-point prefix within the budget.
 */
export function truncateRecapUtf8(input: string, maxBytes: number): string {
  assertPositiveInteger('maxBytes', maxBytes)
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input
  let used = 0
  let output = ''
  for (const character of input) {
    const bytes = Buffer.byteLength(character, 'utf8')
    if (used + bytes > maxBytes) break
    output += character
    used += bytes
  }
  return output
}

/**
 * Normalize one accepted recap and enforce its UTF-8 byte budget.
 * @param input - untrusted recap text.
 * @param maxBytes - positive maximum encoded size.
 * @returns a terminal-safe single line, possibly empty after sanitization.
 */
export function normalizeSessionRecap(input: string, maxBytes: number): string {
  return truncateRecapUtf8(singleDisplayLine(input), maxBytes).trimEnd()
}

/**
 * Bound one digest entry's text to its own byte budget.
 * @param input - extracted entry text.
 * @param maxBytes - positive per-entry UTF-8 byte budget.
 * @returns the normalized single-line entry text.
 */
export function normalizeRecapEntry(input: string, maxBytes: number): string {
  return truncateRecapUtf8(singleDisplayLine(input), maxBytes).trimEnd()
}
