/**
 * Display-safe text primitives: terminal-escape removal, invisible-control
 * stripping, and UTF-8 byte-bounded truncation for untrusted text a client
 * renders on one line.
 * @module @deepseek-ai/dsh-display-text
 */

/** Operating-system-command escape sequences, including unterminated tails. */
const OSC_SEQUENCE = /(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu
/** Control-sequence-introducer escapes such as SGR color codes. */
const CSI_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu
/** Remaining two-byte ESC control sequences. */
const ESC_SEQUENCE = /\u001B[@-_]/gu
/** Non-whitespace C0/C1 control characters. */
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu
/** Directional and invisible controls that can make displayed text deceptive. */
const DIRECTIONAL_CONTROL = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu

/** Reject an invalid public text limit. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}

/**
 * Remove terminal escape sequences and invisible/directional controls, then
 * collapse to one trimmed line.
 * @param input - untrusted display text.
 * @returns the sanitized single-line text, possibly empty.
 */
export function sanitizeDisplayText(input: string): string {
  return input
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(ESC_SEQUENCE, '')
    .replace(CONTROL_CHARACTER, '')
    .replace(DIRECTIONAL_CONTROL, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * Truncate to a UTF-8 byte budget without splitting a Unicode code point.
 * @param input - text to bound.
 * @param maxBytes - positive UTF-8 byte budget.
 * @returns the longest leading code-point prefix within the budget.
 * @throws {Error} when `maxBytes` is not a positive integer.
 */
export function truncateDisplayTextUtf8(input: string, maxBytes: number): string {
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
 * Sanitize and bound one line of untrusted display text.
 * @param input - untrusted display text.
 * @param maxBytes - positive maximum encoded size.
 * @returns a terminal-safe one-line value, possibly empty after sanitization.
 * @throws {Error} when `maxBytes` is not a positive integer.
 */
export function normalizeDisplayText(input: string, maxBytes: number): string {
  return truncateDisplayTextUtf8(sanitizeDisplayText(input), maxBytes).trimEnd()
}
