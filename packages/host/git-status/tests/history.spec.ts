import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import GitStatusGateway from '../src/index.ts'
import { runGit } from '../src/git.ts'
import {
  historyArgs, parseHistoryLog, parseNumstat, parseRefs, validBranchName,
} from '../src/history.ts'

const gitAvailable = await runGit(['--version'], tmpdir()).then(
  outcome => outcome.code === 0 && outcome.spawnError === null,
)

const contexts: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** One record of the custom log format, for parser tests. git terminates
 * every record with a newline after the separator, so fixtures mirror that. */
function record(fields: readonly string[]): string {
  return fields.join('\x1f') + '\x1e\n'
}

describe('parseHistoryLog', () => {
  it('parses complete records and skips malformed ones', () => {
    const parsed = parseHistoryLog(
      record(['a'.repeat(40), 'abc1234', 'p1 p2', 'HEAD -> main', 'Tester', 't@t', '2026-01-01T00:00:00+08:00', 'subject'])
      + 'garbage\n\x1e\n'
      + record(['b'.repeat(40), 'b234567', '', '', 'Other', 'o@o', '2026-01-02T00:00:00+08:00', 'root']),
      10,
    )
    expect(parsed.truncated).toBe(false)
    expect(parsed.commits).toHaveLength(2)
    expect(parsed.commits[0]).toMatchObject({
      hash: 'a'.repeat(40),
      shortHash: 'abc1234',
      parents: ['p1', 'p2'],
      author: 'Tester',
      subject: 'subject',
    })
    expect(parsed.commits[0]?.refs).toEqual([{ kind: 'head', name: 'main' }])
    expect(parsed.commits[1]?.parents).toEqual([])
  })

  it('flags truncation when one more record than the page fits', () => {
    const parsed = parseHistoryLog(
      record(['a'.repeat(40), 'a1', '', '', 'A', 'a@a', 'd', 'one'])
      + record(['b'.repeat(40), 'b2', '', '', 'B', 'b@b', 'd', 'two'])
      + record(['c'.repeat(40), 'c3', '', '', 'C', 'c@c', 'd', 'three']),
      2,
    )
    expect(parsed.truncated).toBe(true)
    expect(parsed.commits).toHaveLength(2)
  })

  it('tolerates the trailing empty record', () => {
    const parsed = parseHistoryLog(record(['a'.repeat(40), 'a1', '', '', 'A', 'a@a', 'd', 'one']), 10)
    expect(parsed.commits).toHaveLength(1)
  })

  it('drops a record whose hash field is not a full hash', () => {
    const parsed = parseHistoryLog(
      record(['short', 's1', '', '', 'A', 'a@a', 'd', 'bad'])
      + record(['a'.repeat(40), 'a1', '', '', 'A', 'a@a', 'd', 'good']),
      10,
    )
    expect(parsed.commits).toHaveLength(1)
    expect(parsed.commits[0]?.shortHash).toBe('a1')
  })
})

describe('parseRefs', () => {
  it('parses head, branch, remote, and tag decorations', () => {
    expect(parseRefs('HEAD -> main, origin/main, tag: v1.0, feature')).toEqual([
      { kind: 'head', name: 'main' },
      { kind: 'remote', name: 'origin/main' },
      { kind: 'tag', name: 'v1.0' },
      { kind: 'branch', name: 'feature' },
    ])
  })

  it('parses a detached HEAD and skips remote HEAD aliases', () => {
    expect(parseRefs('HEAD')).toEqual([{ kind: 'head', name: '' }])
    expect(parseRefs('origin/HEAD -> origin/main, origin/main')).toEqual([
      { kind: 'remote', name: 'origin/main' },
    ])
    expect(parseRefs('')).toEqual([])
    expect(parseRefs('main, ')).toEqual([{ kind: 'branch', name: 'main' }])
  })
})

describe('parseNumstat', () => {
  it('parses plain, rename, and binary rows, skipping blanks', () => {
    const files = parseNumstat('12\t3\tfile.ts\n0\t0\told.ts => new.ts\n-\t-\timg.png\n\n5\t0\tsub/file.txt')
    expect(files).toEqual([
      { path: 'file.ts', oldPath: null, added: 12, removed: 3 },
      { path: 'new.ts', oldPath: 'old.ts', added: 0, removed: 0 },
      { path: 'img.png', oldPath: null, added: null, removed: null },
      { path: 'sub/file.txt', oldPath: null, added: 5, removed: 0 },
    ])
  })

  it('drops rows that are not numstat-shaped', () => {
    expect(parseNumstat('just one field\n\nx\ty\n')).toEqual([])
  })
})

describe('validBranchName', () => {
  it('accepts ordinary names and rejects git-invalid shapes', () => {
    expect(validBranchName('feature/panel-1')).toBe(true)
    expect(validBranchName('UPPER.case_2')).toBe(true)
    expect(validBranchName('')).toBe(false)
    expect(validBranchName('-dash')).toBe(false)
    expect(validBranchName('trailing.')).toBe(false)
    expect(validBranchName('a..b')).toBe(false)
    expect(validBranchName('has space')).toBe(false)
    expect(validBranchName('a~b')).toBe(false)
    expect(validBranchName('@')).toBe(false)
    expect(validBranchName('/lead')).toBe(false)
    expect(validBranchName('x'.repeat(251))).toBe(false)
  })
})

describe('historyArgs', () => {
  it('reads one extra record and applies the skip offset', () => {
    const args = historyArgs(50, 10)
    expect(args).toContain('--max-count=51')
    expect(args).toContain('--skip=10')
    expect(args.some(arg => arg.startsWith('--format='))).toBe(true)
  })
})

/** Hash anchors of the fixture repository's commits. */
interface RepoHashes {
  readonly first: string
  readonly feat: string
  readonly main: string
  readonly merge: string
  readonly edit: string
  readonly rename: string
  readonly binary: string
}

/** Build a throwaway repository with branches, a tag, a merge, a rename, and a binary file. */
async function graphRepo(): Promise<{ root: string; gateway: GitStatusGateway; hashes: RepoHashes }> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-git-history-')))
  tempDirs.push(root)
  await runGit(['init', '-q'], root)
  await runGit(['config', 'user.email', 'test@example.com'], root)
  await runGit(['config', 'user.name', 'DSH Test'], root)
  writeFileSync(join(root, 'base.txt'), 'one\n')
  await runGit(['add', '.'], root)
  await runGit(['commit', '-qm', 'first commit'], root)
  const first = (await runGit(['rev-parse', 'HEAD'], root)).stdout.trim()

  await runGit(['checkout', '-qb', 'feature'], root)
  writeFileSync(join(root, 'feat.txt'), 'feature work\n')
  await runGit(['add', '.'], root)
  await runGit(['commit', '-qm', 'feature work'], root)
  const feat = (await runGit(['rev-parse', 'HEAD'], root)).stdout.trim()

  await runGit(['checkout', '-q', '-'], root)
  writeFileSync(join(root, 'main.txt'), 'main work\n')
  await runGit(['add', '.'], root)
  await runGit(['commit', '-qm', 'main work'], root)
  const main = (await runGit(['rev-parse', 'HEAD'], root)).stdout.trim()
  await runGit(['tag', 'v0.1'], root)

  await runGit(['merge', '--no-ff', '-qm', 'merge feature', 'feature'], root)
  const merge = (await runGit(['rev-parse', 'HEAD'], root)).stdout.trim()

  writeFileSync(join(root, 'main.txt'), 'main work v2\n')
  await runGit(['commit', '-qam', 'edit main.txt'], root)
  const edit = (await runGit(['rev-parse', 'HEAD'], root)).stdout.trim()

  await runGit(['mv', 'base.txt', 'renamed.txt'], root)
  await runGit(['commit', '-qm', 'rename base'], root)
  const rename = (await runGit(['rev-parse', 'HEAD'], root)).stdout.trim()

  writeFileSync(join(root, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff]))
  await runGit(['add', '.'], root)
  await runGit(['commit', '-qm', 'add binary'], root)
  const binary = (await runGit(['rev-parse', 'HEAD'], root)).stdout.trim()

  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(GitStatusGateway)
  return {
    root,
    gateway: ctx.get('gitStatus') as GitStatusGateway,
    hashes: { first, feat, main, merge, edit, rename, binary },
  }
}

describe('GitStatusGateway history', () => {
  it('pages newest-first with refs and truncation', async () => {
    if (!gitAvailable) return
    const { root, gateway, hashes } = await graphRepo()
    const page = await gateway.history({ cwd: root, count: 3, skip: 0 })
    expect(page.failure).toBeNull()
    expect(page.truncated).toBe(true)
    expect(page.commits).toHaveLength(3)
    expect(page.commits[0]?.hash).toBe(hashes.binary)
    expect(page.commits[1]?.hash).toBe(hashes.rename)
    expect(page.commits[2]?.hash).toBe(hashes.edit)

    const full = await gateway.history({ cwd: root, count: 50, skip: 0 })
    expect(full.truncated).toBe(false)
    expect(full.commits).toHaveLength(7)
    const mergeRow = full.commits.find(commit => commit.hash === hashes.merge)
    expect(mergeRow?.parents).toEqual([hashes.main, hashes.feat])
    expect(mergeRow?.refs).toEqual([])
    const headRow = full.commits.find(commit => commit.hash === hashes.binary)
    expect(headRow?.refs).toEqual([{ kind: 'head', name: 'main' }])
    const featRow = full.commits.find(commit => commit.hash === hashes.feat)
    expect(featRow?.refs).toEqual([{ kind: 'branch', name: 'feature' }])
    const mainRow = full.commits.find(commit => commit.hash === hashes.main)
    expect(mainRow?.refs).toEqual([{ kind: 'tag', name: 'v0.1' }])
  })

  it('clamps the page size to the hard cap', async () => {
    if (!gitAvailable) return
    const { root, gateway } = await graphRepo()
    const page = await gateway.history({ cwd: root, count: 9999, skip: 0 })
    expect(page.failure).toBeNull()
    expect(page.commits.length).toBeLessThanOrEqual(500)
  })

  it('normalizes a zero page size and a negative skip', async () => {
    if (!gitAvailable) return
    const { root, gateway } = await graphRepo()
    const page = await gateway.history({ cwd: root, count: 0, skip: -3 })
    expect(page.failure).toBeNull()
    expect(page.commits).toHaveLength(1)
  })

  it('reports a failure outside a repository', async () => {
    if (!gitAvailable) return
    const { gateway } = await graphRepo()
    const plain = mkdtempSync(join(tmpdir(), 'dsh-git-history-plain-'))
    tempDirs.push(plain)
    const page = await gateway.history({ cwd: plain, count: 10, skip: 0 })
    expect(page.failure).not.toBeNull()
    expect(page.commits).toEqual([])
  })

  it('reads commit details with message body, renames, and binary files', async () => {
    if (!gitAvailable) return
    const { root, gateway, hashes } = await graphRepo()
    const result = await gateway.commitDetails({ cwd: root, hash: hashes.rename })
    expect(result.failure).toBeNull()
    expect(result.details?.hash).toBe(hashes.rename)
    expect(result.details?.message).toContain('rename base')
    expect(result.details?.files).toEqual([
      { path: 'renamed.txt', oldPath: 'base.txt', added: 0, removed: 0 },
    ])

    const binaryResult = await gateway.commitDetails({ cwd: root, hash: hashes.binary })
    expect(binaryResult.details?.files).toEqual([
      { path: 'blob.bin', oldPath: null, added: null, removed: null },
    ])

    const rootResult = await gateway.commitDetails({ cwd: root, hash: hashes.first })
    expect(rootResult.details?.parents).toEqual([])
  })

  it('reports a failure for an unknown commit hash', async () => {
    if (!gitAvailable) return
    const { root, gateway } = await graphRepo()
    const result = await gateway.commitDetails({ cwd: root, hash: 'deadbeef'.repeat(5) })
    expect(result.details).toBeNull()
    expect(result.failure).not.toBeNull()
  })

  it('reports a failure when the tree objects are unreadable', async () => {
    if (!gitAvailable) return
    const { root, gateway, hashes } = await graphRepo()
    const tree = (await runGit(['rev-parse', `${hashes.edit}^{tree}`], root)).stdout.trim()
    rmSync(join(root, '.git', 'objects', tree.slice(0, 2), tree.slice(2)))
    const result = await gateway.commitDetails({ cwd: root, hash: hashes.edit })
    expect(result.details).toBeNull()
    expect(result.failure).not.toBeNull()
  })
})

describe('GitStatusGateway fileDiff', () => {
  it('reads both sides of a modified file', async () => {
    if (!gitAvailable) return
    const { root, gateway, hashes } = await graphRepo()
    const result = await gateway.fileDiff({ cwd: root, hash: hashes.edit, path: 'main.txt', oldPath: null })
    expect(result.failure).toBeNull()
    expect(result.oldText).toBe('main work\n')
    expect(result.newText).toBe('main work v2\n')
    expect(result.binary).toBe(false)
  })

  it('renders a new file as a null parent side', async () => {
    if (!gitAvailable) return
    const { root, gateway, hashes } = await graphRepo()
    const result = await gateway.fileDiff({ cwd: root, hash: hashes.feat, path: 'feat.txt', oldPath: null })
    expect(result.failure).toBeNull()
    expect(result.oldText).toBeNull()
    expect(result.newText).toBe('feature work\n')
  })

  it('renders a root commit parent as a null old side', async () => {
    if (!gitAvailable) return
    const { root, gateway, hashes } = await graphRepo()
    const result = await gateway.fileDiff({ cwd: root, hash: hashes.first, path: 'base.txt', oldPath: null })
    expect(result.failure).toBeNull()
    expect(result.oldText).toBeNull()
    expect(result.newText).toBe('one\n')
  })

  it('reads the pre-rename path on the parent side', async () => {
    if (!gitAvailable) return
    const { root, gateway, hashes } = await graphRepo()
    const result = await gateway.fileDiff({ cwd: root, hash: hashes.rename, path: 'renamed.txt', oldPath: 'base.txt' })
    expect(result.failure).toBeNull()
    expect(result.oldText).toBe('one\n')
    expect(result.newText).toBe('one\n')
  })

  it('marks binary content with null sides and no failure', async () => {
    if (!gitAvailable) return
    const { root, gateway, hashes } = await graphRepo()
    const result = await gateway.fileDiff({ cwd: root, hash: hashes.binary, path: 'blob.bin', oldPath: null })
    expect(result.failure).toBeNull()
    expect(result.oldText).toBeNull()
    expect(result.newText).toBeNull()
    expect(result.binary).toBe(true)
  })

  it('reports a failure for a deleted blob object', async () => {
    if (!gitAvailable) return
    const { root, gateway, hashes } = await graphRepo()
    const blob = (await runGit(['rev-parse', `${hashes.edit}:main.txt`], root)).stdout.trim()
    rmSync(join(root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)))
    const result = await gateway.fileDiff({ cwd: root, hash: hashes.edit, path: 'main.txt', oldPath: null })
    expect(result.failure).not.toBeNull()
  })

  it('reports a failure for a deleted blob on the parent side', async () => {
    if (!gitAvailable) return
    const { root, gateway, hashes } = await graphRepo()
    const blob = (await runGit(['rev-parse', `${hashes.edit}^:main.txt`], root)).stdout.trim()
    rmSync(join(root, '.git', 'objects', blob.slice(0, 2), blob.slice(2)))
    const result = await gateway.fileDiff({ cwd: root, hash: hashes.edit, path: 'main.txt', oldPath: null })
    expect(result.failure).not.toBeNull()
  })

  it('renders a deleted file as a null commit side', async () => {
    if (!gitAvailable) return
    const { root, gateway } = await graphRepo()
    rmSync(join(root, 'main.txt'))
    await runGit(['commit', '-qam', 'delete main.txt'], root)
    const deleted = (await runGit(['rev-parse', 'HEAD'], root)).stdout.trim()
    const result = await gateway.fileDiff({ cwd: root, hash: deleted, path: 'main.txt', oldPath: null })
    expect(result.failure).toBeNull()
    expect(result.newText).toBeNull()
    expect(result.oldText).toBe('main work v2\n')
  })

  it('reports a spawn failure for an unresolvable directory', async () => {
    if (!gitAvailable) return
    const { gateway, hashes } = await graphRepo()
    const result = await gateway.fileDiff({ cwd: '/definitely/not/a/directory', hash: hashes.edit, path: 'main.txt', oldPath: null })
    expect(result.failure?.code).toBe('git-unavailable')
  })

  it('truncates a side beyond the byte cap', async () => {
    if (!gitAvailable) return
    const { root, gateway } = await graphRepo()
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(70_000) + '\n')
    await runGit(['add', '.'], root)
    await runGit(['commit', '-qm', 'add big file'], root)
    const big = (await runGit(['rev-parse', 'HEAD'], root)).stdout.trim()
    const result = await gateway.fileDiff({ cwd: root, hash: big, path: 'big.txt', oldPath: null })
    expect(result.failure).toBeNull()
    expect(result.truncated).toBe(true)
    expect(result.newText?.length).toBeLessThan(70_000)
  })
})

describe('GitStatusGateway mutations', () => {
  it('checks out a branch and detaches at a commit', async () => {
    if (!gitAvailable) return
    const { root, gateway } = await graphRepo()
    const branchResult = await gateway.checkout({ cwd: root, kind: 'branch', target: 'feature' })
    expect(branchResult).toEqual({ ok: true, failure: null })
    expect((await runGit(['branch', '--show-current'], root)).stdout.trim()).toBe('feature')

    const head = (await runGit(['rev-parse', 'HEAD'], root)).stdout.trim()
    const commitResult = await gateway.checkout({ cwd: root, kind: 'commit', target: head })
    expect(commitResult).toEqual({ ok: true, failure: null })
  })

  it('rejects an invalid branch name before running git', async () => {
    if (!gitAvailable) return
    const { root, gateway } = await graphRepo()
    const result = await gateway.checkout({ cwd: root, kind: 'branch', target: 'bad name' })
    expect(result.ok).toBe(false)
    expect(result.failure?.code).toBe('invalid-name')
  })

  it('surfaces git errors for an unknown branch and a dirty-tree switch', async () => {
    if (!gitAvailable) return
    const { root, gateway } = await graphRepo()
    const unknown = await gateway.checkout({ cwd: root, kind: 'branch', target: 'no-such-branch' })
    expect(unknown.ok).toBe(false)
    expect(unknown.failure?.message).toContain('pathspec')

    await runGit(['checkout', '-q', 'feature'], root)
    // base.txt exists on both branches, so a local edit blocks the switch back.
    writeFileSync(join(root, 'base.txt'), 'local edit\n')
    const dirty = await gateway.checkout({ cwd: root, kind: 'branch', target: 'main' })
    expect(dirty.ok).toBe(false)
    expect(dirty.failure?.message).toContain('local changes')
  })

  it('kills a checkout that hangs in its hook', async () => {
    if (!gitAvailable) return
    const { root, gateway } = await graphRepo()
    const hook = join(root, '.git', 'hooks', 'post-checkout')
    writeFileSync(hook, '#!/bin/sh\nsleep 30\n')
    chmodSync(hook, 0o755)
    const result = await gateway.checkout({ cwd: root, kind: 'branch', target: 'feature' })
    expect(result.ok).toBe(false)
    expect(result.failure?.code).toBe('timeout')
    rmSync(hook)
  }, 20_000)

  it('creates a branch at a commit without checking it out', async () => {
    if (!gitAvailable) return
    const { root, gateway, hashes } = await graphRepo()
    const result = await gateway.createBranch({ cwd: root, name: 'from-history', atHash: hashes.first })
    expect(result).toEqual({ ok: true, failure: null })
    expect((await runGit(['rev-parse', 'from-history'], root)).stdout.trim()).toBe(hashes.first)
  })

  it('rejects invalid and duplicate branch names', async () => {
    if (!gitAvailable) return
    const { root, gateway } = await graphRepo()
    const invalid = await gateway.createBranch({ cwd: root, name: 'bad~name', atHash: 'x' })
    expect(invalid.failure?.code).toBe('invalid-name')
    const duplicate = await gateway.createBranch({ cwd: root, name: 'main', atHash: 'x' })
    expect(duplicate.ok).toBe(false)
    expect(duplicate.failure?.message).toContain('already exists')
  })
})
