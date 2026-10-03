/** Shared fixtures for the git-status Host specs. */

import type { Config } from '../src/index.ts'

/**
 * The deployment defaults with the named fields overridden. Cordis validates a
 * plugin config against the schema, which requires every field at a TypeScript
 * call site, so a spec that varies one limit states the rest explicitly here.
 * @param overrides - fields this spec varies.
 * @returns a complete configuration.
 */
export function configWith(overrides: Partial<Config> = {}): Config {
  return {
    timeoutMs: 15_000,
    historyLimit: 500,
    diffBytesLimit: 65_536,
    scanDepth: 1,
    scanIgnoredFolders: ['node_modules'],
    ...overrides,
  }
}
