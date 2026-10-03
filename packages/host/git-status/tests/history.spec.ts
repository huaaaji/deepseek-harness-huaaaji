import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import GitStatusGateway from '../src/index.ts'
import { runGit } from '../src/git.ts'
import { configWith } from './support.ts'
import {
  historyArgs, parseBranchList, parseHistoryLog, parseNumstat, parseRefs, validBranchName,
  validObjectId, validRepoPath,
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
    expect(parseRefs('upstream/HEAD -> upstream/main, upstream/main')).toEqual([
      { kind: 'remote', name: 'upstream/main' },
    ])
    expect(parseRefs('')).toEqual([])
    expect(parseRefs('main, ')).toEqual([{ kind: 'branch', name: 'main' }])
  })
})

describe('parseNumstat', () => {
  it('parses plain, rename, and binary rows, skipping blanks', () => {
    const files = parseNumstat([
      '12\t3\tfile.ts\0',
      '0\t0\t\0old.ts\0new.ts\0',
      '-\t-\timg.png\0',
      '\0',
      '5\t0\tsub/file.txt\0',
    ].join(''))
    expect(files).toEqual([
      { path: 'file.ts', oldPath: null, added: 12, removed: 3 },
      { path: 'new.ts', oldPath: 'old.ts', added: 0, removed: 0 },
      { path: 'img.png', oldPath: null, added: null, removed: null },
      { path: 'sub/file.txt', oldPath: null, added: 5, removed: 0 },
    ])
  })

  it('reads a directory-changing rename as two whole paths', () => {
    // git's non -z output compresses this pair to `src/{old => other}/file.ts`,
    // which no path-splitting rule can undo; -z always spells both paths out.
    const files = parseNumstat('0\t0\t\0src/old/file.ts\0src/other/file.ts\0')
    expect(files).toEqual([
      { path: 'src/other/file.ts', oldPath: 'src/old/file.ts', added: 0, removed: 0 },
    ])
  })

  it('keeps a tab inside a path', () => {
    const files = parseNumstat('1\t0\tweird\tname.ts\0')
    expect(files).toEqual([
      { path: 'weird\tname.ts', oldPath: null, added: 1, removed: 0 },
    ])
  })

  it('drops rows that are not numstat-shaped', () => {
    expect(parseNumstat('just one field\0\0x\0')).toEqual([])
    expect(parseNumstat('1\t0\t\0only-old\0')).toEqual([])
  })
})

describe('parseBranchList', () => {
  it('strips the current marker and drops detached HEAD and remote aliases', () => {
    expect(parseBranchList('* main\n  feature\n  * (HEAD detached at 47f9438)\n  origin/HEAD -> origin/main\n  origin/main\n\n')).toEqual([
      'main', 'feature', 'origin/main',
    ])
  })

  it('returns an empty list for empty output', () => {
    expect(parseBranchList('')).toEqual([])
  })
})

describe('validObjectId', () => {
  it('accepts abbreviated and full hexadecimal object names', () => {
    expect(validObjectId('abc1234')).toBe(true)
    expect(validObjectId('a'.repeat(40))).toBe(true)
    expect(validObjectId('ABC1234')).toBe(true)
  })

  it('refuses option-shaped and non-hexadecimal revisions', () => {
    // `--output=/tmp/x` reaches git's option parser when it is not refused here.
    expect(validObjectId('--output=/tmp/x')).toBe(false)
    expect(validObjectId('-f')).toBe(false)
    expect(validObjectId('main')).toBe(false)
    expect(validObjectId('abc123')).toBe(false)
    expect(validObjectId('a'.repeat(41))).toBe(false)
    expect(validObjectId('')).toBe(false)
  })
})

describe('validRepoPath', () => {
  it('accepts repository-relative paths, including a leading dash', () => {
    expect(validRepoPath('src/a.ts')).toBe(true)
    expect(validRepoPath('-odd-name.ts')).toBe(true)
  })

  it('refuses empty, absolute, and NUL-holding paths', () => {
    expect(validRepoPath('')).toBe(false)
    expect(validRepoPath('/etc/passwd')).toBe(false)
    expect(validRepoPath('a\0b')).toBe(false)
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

  it('selects topological order alone', () => {
    // Passing --date-order after --topo-order would select commit-date order,
    // because git keeps the later sort flag.
    expect(historyArgs(50, 0)).toContain('--topo-order')
    expect(historyArgs(50, 0)).not.toContain('--date-order')
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

  // A remote tracking ref so `git branch --remotes --contains` has content.
  await runGit(['update-ref', 'refs/remotes/origin/main', binary], root)

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
    expect(headRow?.refs).toEqual([
      { kind: 'head', name: 'main' },
      { kind: 'remote', name: 'origin/main' },
    ])
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
    expect(result.details?.localBranches).toEqual(['main'])
    expect(result.details?.remoteBranches).toEqual(['origin/main'])

    const binaryResult = await gateway.commitDetails({ cwd: root, hash: hashes.binary })
    expect(binaryResult.details?.files).toEqual([
      { path: 'blob.bin', oldPath: null, added: null, removed: null },
    ])

    const rootResult = await gateway.commitDetails({ cwd: root, hash: hashes.first })
    expect(rootResult.details?.parents).toEqual([])
    // The root commit is reachable from every branch in the fixture (git
    // lists branch names alphabetically, so match the set, not the order).
    expect(rootResult.details?.localBranches).toHaveLength(2)
    expect(rootResult.details?.localBranches).toEqual(expect.arrayContaining(['main', 'feature']))
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

  it('reads a directory-changing rename through the -z path pairs', async () => {
    if (!gitAvailable) return
    const { root, gateway } = await graphRepo()
    mkdirSync(join(root, 'src', 'old'), { recursive: true })
    writeFileSync(join(root, 'src', 'old', 'file.ts'), 'nested\n')
    await runGit(['add', '.'], root)
    await runGit(['commit', '-qm', 'add nested file'], root)
    mkdirSync(join(root, 'src', 'other'), { recursive: true })
    await runGit(['mv', 'src/old/file.ts', 'src/other/file.ts'], root)
    await runGit(['commit', '-qm', 'move nested file'], root)
    const moved = (await runGit(['rev-parse', 'HEAD'], root)).stdout.trim()

    // git's non -z numstat compresses this pair to `src/{old => other}/file.ts`.
    const details = await gateway.commitDetails({ cwd: root, hash: moved })
    expect(details.failure).toBeNull()
    expect(details.details?.files).toEqual([
      { path: 'src/other/file.ts', oldPath: 'src/old/file.ts', added: 0, removed: 0 },
    ])

    const diff = await gateway.fileDiff({
      cwd: root, hash: moved, path: 'src/other/file.ts', oldPath: 'src/old/file.ts',
    })
    expect(diff.failure).toBeNull()
    expect(diff.oldText).toBe('nested\n')
    expect(diff.newText).toBe('nested\n')
  })

  it('reads multi-byte content without replacement characters', async () => {
    if (!gitAvailable) return
    const { root, gateway } = await graphRepo()
    // 120 KB of three-byte characters crosses several pipe chunks, so a
    // per-chunk decode would corrupt the text the diff surface renders.
    const text = '\u4e2d'.repeat(40_000) + '\n'
    writeFileSync(join(root, 'cjk.txt'), text)
    await runGit(['add', '.'], root)
    await runGit(['commit', '-qm', 'add cjk file'], root)
    const hash = (await runGit(['rev-parse', 'HEAD'], root)).stdout.trim()

    const result = await gateway.fileDiff({ cwd: root, hash, path: 'cjk.txt', oldPath: null })
    expect(result.failure).toBeNull()
    expect(result.truncated).toBe(false)
    expect(result.newText).toBe(text)
  })

  it('reports a missing working directory as not-a-repo', async () => {
    if (!gitAvailable) return
    const { gateway, hashes } = await graphRepo()
    const result = await gateway.fileDiff({ cwd: '/definitely/not/a/directory', hash: hashes.edit, path: 'main.txt', oldPath: null })
    expect(result.failure?.code).toBe('not-a-repo')
    expect(result.failure?.message).toBe('working directory does not exist')
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

describe('GitStatusGateway wire validation', () => {
  it('refuses option-shaped wire fields before git runs', async () => {
    if (!gitAvailable) return
    const { root, gateway, hashes } = await graphRepo()
    const escapePath = join(tmpdir(), 'dsh-git-status-escape')
    rmSync(`${escapePath}:base.txt`, { force: true })

    // `git show --output=<file>` would write the commit to that path, and
    // `git checkout -f` would discard local work; the hash and target shapes
    // are refused before either reaches git's option parser.
    const injected = await gateway.fileDiff({
      cwd: root, hash: `--output=${escapePath}`, path: 'base.txt', oldPath: null,
    })
    expect(injected.failure?.code).toBe('invalid-revision')
    expect(existsSync(`${escapePath}:base.txt`)).toBe(false)

    const details = await gateway.commitDetails({ cwd: root, hash: `--output=${escapePath}` })
    expect(details.details).toBeNull()
    expect(details.failure?.code).toBe('invalid-revision')

    const checkout = await gateway.checkout({ cwd: root, kind: 'commit', target: '-f' })
    expect(checkout.ok).toBe(false)
    expect(checkout.failure?.code).toBe('invalid-revision')

    const branch = await gateway.createBranch({ cwd: root, name: 'probe', atHash: '--no-track' })
    expect(branch.ok).toBe(false)
    expect(branch.failure?.code).toBe('invalid-revision')

    const path = await gateway.fileDiff({ cwd: root, hash: hashes.first, path: '/etc/passwd', oldPath: null })
    expect(path.failure?.code).toBe('invalid-path')
  })

  it('keeps local work when a commit-shaped checkout is refused', async () => {
    if (!gitAvailable) return
    const { root, gateway } = await graphRepo()
    writeFileSync(join(root, 'base.txt'), 'local edit\n')
    const refused = await gateway.checkout({ cwd: root, kind: 'commit', target: '-f' })
    expect(refused.ok).toBe(false)
    expect(readFileSync(join(root, 'base.txt'), 'utf8')).toBe('local edit\n')
  })

  it('clamps the history page to the configured limit', async () => {
    if (!gitAvailable) return
    const { root } = await graphRepo()
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(GitStatusGateway, configWith({ historyLimit: 2 }))
    const gateway = ctx.get('gitStatus') as GitStatusGateway
    const page = await gateway.history({ cwd: root, count: 100, skip: 0 })
    expect(page.failure).toBeNull()
    expect(page.commits).toHaveLength(2)
    expect(page.truncated).toBe(true)
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
    const { root } = await graphRepo()
    // A short configured deadline exercises the same kill path as the default
    // one without holding the suite for the production 15s budget.
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(GitStatusGateway, configWith({ timeoutMs: 300 }))
    const gateway = ctx.get('gitStatus') as GitStatusGateway
    const hook = join(root, '.git', 'hooks', 'post-checkout')
    writeFileSync(hook, '#!/bin/sh\nsleep 30\n')
    chmodSync(hook, 0o755)
    const result = await gateway.checkout({ cwd: root, kind: 'branch', target: 'feature' })
    expect(result.ok).toBe(false)
    expect(result.failure?.code).toBe('timeout')
    rmSync(hook)
  }, 10_000)

  it('creates a branch at a commit without checking it out', async () => {
    if (!gitAvailable) return
    const { root, gateway, hashes } = await graphRepo()
    const result = await gateway.createBranch({ cwd: root, name: 'from-history', atHash: hashes.first })
    expect(result).toEqual({ ok: true, failure: null })
    expect((await runGit(['rev-parse', 'from-history'], root)).stdout.trim()).toBe(hashes.first)
  })

  it('rejects invalid and duplicate branch names', async () => {
    if (!gitAvailable) return
    const { root, gateway, hashes } = await graphRepo()
    const invalid = await gateway.createBranch({ cwd: root, name: 'bad~name', atHash: hashes.first })
    expect(invalid.failure?.code).toBe('invalid-name')
    const duplicate = await gateway.createBranch({ cwd: root, name: 'main', atHash: hashes.first })
    expect(duplicate.ok).toBe(false)
    expect(duplicate.failure?.message).toContain('already exists')
  })
})
