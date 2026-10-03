/** Subdirectory repository discovery for the git-status Remote. */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** The filesystem entry that marks a working tree. */
const GIT_ENTRY = '.git'

/**
 * Child directory names of one directory, in name order.
 * @param directory - directory to list.
 * @returns the child directory names, or null when the directory cannot be read.
 */
async function childDirectories(directory: string): Promise<string[] | null> {
  try {
    const entries = await readdir(directory, { withFileTypes: true })
    return entries
      .filter(entry => entry.isDirectory() && entry.name !== GIT_ENTRY)
      .map(entry => entry.name)
      .sort()
  } catch {
    // An unreadable, permission-denied, or vanished directory simply
    // contributes no candidate; the caller reports what it did find.
    return null
  }
}

/**
 * Whether one directory holds the `.git` entry that marks a working tree. The
 * entry is a directory for an ordinary repository and a file for a linked
 * worktree or submodule, so only its presence matters.
 * @param directory - candidate directory.
 * @returns true when the directory carries a `.git` entry.
 */
async function holdsGitEntry(directory: string): Promise<boolean> {
  try {
    await stat(join(directory, GIT_ENTRY))
    return true
  } catch {
    return false
  }
}

/**
 * Candidate repository directories below a starting directory. The starting
 * directory itself is never a candidate — it is the enclosing repository, which
 * the caller resolves separately — so a caller wanting both asks git about the
 * start and passes the subdirectories here.
 *
 * The walk descends at most `depth` levels, mirroring `git.repositoryScanMaxDepth`:
 * one level means the immediate subdirectories. Directories named by `ignored`,
 * and every `.git` directory, are never entered. Symbolic links are not
 * followed, because a directory entry reports itself as a link rather than a
 * directory, which also removes the cycle risk of an unlimited walk.
 * @param start - directory whose subdirectories are walked.
 * @param depth - levels to descend; `-1` walks the whole subtree.
 * @param ignored - child directory names the walk does not enter, matched exactly.
 * @returns candidate directories in breadth-first, name-sorted order.
 */
export async function scanSubdirectories(
  start: string,
  depth: number,
  ignored: readonly string[],
): Promise<readonly string[]> {
  const candidates: string[] = []
  let frontier: readonly string[] = [start]
  let level = 0
  while (frontier.length > 0 && (depth === -1 || level < depth)) {
    const next: string[] = []
    for (const directory of frontier) {
      const children = await childDirectories(directory)
      if (children === null) continue
      for (const name of children) {
        if (ignored.includes(name)) continue
        next.push(join(directory, name))
      }
    }
    level += 1
    for (const child of next) {
      if (await holdsGitEntry(child)) candidates.push(child)
    }
    frontier = next
  }
  return candidates
}
