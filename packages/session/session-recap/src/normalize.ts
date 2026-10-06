/**
 * Recap text normalization: terminal-safe, single-line, UTF-8 bounded output
 * for text a client displays in a transcript row.
 */

import { normalizeDisplayText, truncateDisplayTextUtf8 } from '@deepseek-ai/dsh-display-text'

/**
 * Truncate text to a UTF-8 byte budget without splitting a Unicode code point.
 * @param input - text to bound.
 * @param maxBytes - positive UTF-8 byte budget.
 * @returns the longest leading code-point prefix within the budget.
 */
export function truncateRecapUtf8(input: string, maxBytes: number): string {
  return truncateDisplayTextUtf8(input, maxBytes)
}

/**
 * Normalize one accepted recap and enforce its UTF-8 byte budget.
 * @param input - untrusted recap text.
 * @param maxBytes - positive maximum encoded size.
 * @returns a terminal-safe single line, possibly empty after sanitization.
 */
export function normalizeSessionRecap(input: string, maxBytes: number): string {
  return normalizeDisplayText(input, maxBytes)
}

/**
 * Bound one digest entry's text to its own byte budget.
 * @param input - extracted entry text.
 * @param maxBytes - positive per-entry UTF-8 byte budget.
 * @returns the normalized single-line entry text.
 */
export function normalizeRecapEntry(input: string, maxBytes: number): string {
  return normalizeDisplayText(input, maxBytes)
}
