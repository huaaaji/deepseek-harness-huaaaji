import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import GitStatusGateway from '../src/index.ts'
import { failureOf, runGit } from '../src/git.ts'

/** Whether this machine can answer git queries (CI sandboxes may not ship git). */
const gitAvailable = await runGit(['--version'], tmpdir()).then(
  outcome => outcome.code === 0 && outcome.spawnError === null,
)

const contexts: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Create a throwaway repository with one committed file. */
async function repo(): Promise<{ root: string; gateway: GitStatusGateway }> {
  // macOS /tmp is a symlink to /private/tmp; git reports the real path.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-git-status-')))
  tempDirs.push(root)
  await runGit(['init', '-q'], root)
  await runGit(['config', 'user.email', 'test@example.com'], root)
  await runGit(['config', 'user.name', 'DSH Test'], root)
  writeFileSync(join(root, 'tracked.txt'), 'one\n')
  await runGit(['add', 'tracked.txt'], root)
  await runGit(['commit', '-q', '-m', 'initial commit'], root)

  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(GitStatusGateway)
  const gateway = ctx.get('gitStatus') as GitStatusGateway
  return { root, gateway }
}

describe('GitStatusGateway', () => {
  it('publishes the direct methods under the gitStatus namespace', async () => {
    const { gateway } = await repo()
    expect(gateway.typertRemote).toMatchObject({
      serviceKey: 'gitStatus',
      namespace: 'gitStatus',
    })
    expect(remoteMethods(gateway)).toEqual([
      { method: 'status', invocation: { kind: 'direct' } },
      { method: 'repositories', invocation: { kind: 'direct' } },
      { method: 'history', invocation: { kind: 'direct' } },
      { method: 'commitDetails', invocation: { kind: 'direct' } },
      { method: 'fileDiff', invocation: { kind: 'direct' } },
      { method: 'checkout', invocation: { kind: 'direct' } },
      { method: 'createBranch', invocation: { kind: 'direct' } },
    ])
  })

  it.skipIf(!gitAvailable)('reports a clean working tree', async () => {
    const { root, gateway } = await repo()
    const snapshot = await gateway.status({ cwd: root })
    expect(snapshot.failure).toBeNull()
    expect(snapshot.root).toBe(root)
    expect(['master', 'main']).toContain(snapshot.branch?.name)
    expect(snapshot.head?.shortHash ?? '').toMatch(/^[0-9a-f]{7}$/)
    expect(snapshot.head?.subject).toBe('initial commit')
    expect(snapshot.counts).toEqual({ staged: 0, unstaged: 0, untracked: 0, conflicted: 0 })
    expect(snapshot.entries).toEqual([])
  })

  it.skipIf(!gitAvailable)('classifies staged, unstaged, and untracked changes', async () => {
    const { root, gateway } = await repo()
    writeFileSync(join(root, 'tracked.txt'), 'two\n')
    writeFileSync(join(root, 'staged.txt'), 'staged\n')
    writeFileSync(join(root, 'untracked.txt'), 'new\n')
    await runGit(['add', 'staged.txt'], root)
    mkdirSync(join(root, 'renamed-dir'))
    writeFileSync(join(root, 'renamed-dir', 'moved.txt'), 'moved\n')
    await runGit(['add', 'renamed-dir'], root)

    const snapshot = await gateway.status({ cwd: root })
    expect(snapshot.failure).toBeNull()
    expect(snapshot.counts).toEqual({ staged: 2, unstaged: 1, untracked: 1, conflicted: 0 })
    const byPath = Object.fromEntries(snapshot.entries.map(entry => [entry.path, entry]))
    expect(byPath['tracked.txt']).toMatchObject({ state: 'modified', staged: false })
    expect(byPath['staged.txt']).toMatchObject({ state: 'added', staged: true })
    expect(byPath['renamed-dir/moved.txt']).toMatchObject({ state: 'added', staged: true })
    expect(byPath['untracked.txt']).toMatchObject({ state: 'untracked', staged: false })
  })

  it.skipIf(!gitAvailable)('walks up from a subdirectory to the repository root', async () => {
    const { root, gateway } = await repo()
    const sub = join(root, 'sub')
    mkdirSync(sub)
    writeFileSync(join(sub, 'file.txt'), 'x\n')
    const snapshot = await gateway.status({ cwd: sub })
    expect(snapshot.failure).toBeNull()
    expect(snapshot.root).toBe(root)
    expect(snapshot.counts.untracked).toBe(1)
  })

  it.skipIf(!gitAvailable)('reports not-a-repo for a plain directory', async () => {
    const { gateway } = await repo()
    const plain = mkdtempSync(join(tmpdir(), 'dsh-git-status-plain-'))
    tempDirs.push(plain)
    const snapshot = await gateway.status({ cwd: plain })
    expect(snapshot.failure?.code).toBe('not-a-repo')
    expect(snapshot.root).toBeNull()
    expect(snapshot.entries).toEqual([])
  })

  it.skipIf(!gitAvailable)('reports an empty repository without a head', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-git-status-empty-')))
    tempDirs.push(root)
    await runGit(['init', '-q'], root)
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(GitStatusGateway)
    const gateway = ctx.get('gitStatus') as GitStatusGateway

    const snapshot = await gateway.status({ cwd: root })
    expect(snapshot.failure).toBeNull()
    expect(snapshot.head).toBeNull()
    expect(snapshot.counts).toEqual({ staged: 0, unstaged: 0, untracked: 0, conflicted: 0 })
  })

  it.skipIf(!gitAvailable)('counts conflicted entries from a real merge conflict', async () => {
    const { root, gateway } = await repo()
    await runGit(['checkout', '-q', '-b', 'side'], root)
    writeFileSync(join(root, 'tracked.txt'), 'side\n')
    await runGit(['commit', '-qam', 'side change'], root)
    await runGit(['checkout', '-q', '-'], root)
    writeFileSync(join(root, 'tracked.txt'), 'main\n')
    await runGit(['commit', '-qam', 'main change'], root)
    await runGit(['merge', 'side'], root)

    const snapshot = await gateway.status({ cwd: root })
    expect(snapshot.failure).toBeNull()
    expect(snapshot.counts.conflicted).toBe(1)
    expect(snapshot.entries[0]).toMatchObject({ path: 'tracked.txt', state: 'conflicted' })
  })

  it.skipIf(!gitAvailable)('reports a failure when git status cannot read the index', async () => {
    const { root, gateway } = await repo()
    writeFileSync(join(root, '.git', 'index'), 'garbage')
    const snapshot = await gateway.status({ cwd: root })
    expect(snapshot.failure).not.toBeNull()
    expect(snapshot.failure?.message).toContain('index')
    expect(snapshot.root).toBeNull()
  })

  it.skipIf(!gitAvailable)('kills a hung git run after the timeout', async () => {
    const { root } = await repo()
    const outcome = await runGit(['-c', 'alias.slow=!sleep 30', 'slow'], root, { timeoutMs: 300 })
    expect(outcome.signal).toBe('SIGKILL')
    expect(failureOf(outcome, 'fallback').code).toBe('timeout')
  })

  it.skipIf(!gitAvailable)('names a missing working directory instead of a missing git binary', async () => {
    const outcome = await runGit(['--version'], '/definitely/not/a/directory')
    expect(outcome.directoryMissing).toBe(true)
    expect(failureOf(outcome, 'fallback').code).toBe('not-a-repo')
  })

  it.skipIf(!gitAvailable)('reports git-unavailable when the binary is not on PATH', async () => {
    const { root } = await repo()
    const path = process.env.PATH
    // The cwd exists, so the same ENOENT can only mean the binary is missing.
    process.env.PATH = ''
    try {
      const outcome = await runGit(['--version'], root)
      expect(outcome.directoryMissing).toBe(false)
      expect(outcome.spawnError?.code).toBe('ENOENT')
      expect(failureOf(outcome, 'fallback').code).toBe('git-unavailable')
    } finally {
      process.env.PATH = path
    }
  })

  it.skipIf(!gitAvailable)('reports a spawn failure when the working directory is a file', async () => {
    const { root } = await repo()
    // A path that exists but is not a directory reaches spawn and fails there.
    const outcome = await runGit(['--version'], join(root, 'tracked.txt'))
    expect(outcome.directoryMissing).toBe(false)
    expect(outcome.spawnError?.code).toBe('ENOTDIR')
    expect(failureOf(outcome, 'fallback').code).toBe('git-error')
  })

  it.skipIf(!gitAvailable)('stops a capped read at its budget without splitting a character', async () => {
    const { root } = await repo()
    writeFileSync(join(root, 'emoji.txt'), 'a\u{1F600}b\n')
    await runGit(['add', 'emoji.txt'], root)
    await runGit(['commit', '-qm', 'emoji'], root)
    const hash = (await runGit(['rev-parse', 'HEAD'], root)).stdout.trim()
    // The budget lands on the emoji's second code unit; a lone surrogate would
    // reach the diff surface as a broken character.
    const outcome = await runGit(['show', `${hash}:emoji.txt`], root, { maxStdoutChars: 2 })
    expect(outcome.truncated).toBe(true)
    expect(outcome.stdout).toBe('a')
  })
})
