import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import GitStatusGateway, { type Config } from '../src/index.ts'
import { runGit } from '../src/git.ts'
import { configWith } from './support.ts'

const gitAvailable = await runGit(['--version'], tmpdir()).then(
  outcome => outcome.code === 0 && outcome.spawnError === null,
)

const contexts: Context[] = []
const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A throwaway directory that is not itself a repository. */
function plainDir(): string {
  // macOS /tmp is a symlink to /private/tmp; git reports the real path.
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-git-discovery-')))
  tempDirs.push(directory)
  return directory
}

/** Create a committed repository at `<base>/<segments…>` and return its real root. */
async function repoAt(base: string, ...segments: readonly string[]): Promise<string> {
  const directory = join(base, ...segments)
  mkdirSync(directory, { recursive: true })
  await runGit(['init', '-q'], directory)
  await runGit(['config', 'user.email', 'test@example.com'], directory)
  await runGit(['config', 'user.name', 'DSH Test'], directory)
  writeFileSync(join(directory, 'tracked.txt'), 'one\n')
  await runGit(['add', '.'], directory)
  await runGit(['commit', '-qm', 'initial commit'], directory)
  return realpathSync(directory)
}

/** A gateway configured with the given deployment limits. */
async function gateway(config: Config = configWith()): Promise<GitStatusGateway> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(GitStatusGateway, config)
  return ctx.get('gitStatus') as GitStatusGateway
}

describe('GitStatusGateway repositories', () => {
  it('finds the repository cloned into a non-repository workspace', async () => {
    if (!gitAvailable) return
    const workspace = plainDir()
    const clone = await repoAt(workspace, 'sp_vision_25')
    const result = await (await gateway()).repositories({ cwd: workspace })
    expect(result.repositories).toEqual([{ root: clone, name: 'sp_vision_25' }])
  })

  it('lists the enclosing repository before the repositories inside it', async () => {
    if (!gitAvailable) return
    const workspace = plainDir()
    const enclosing = await repoAt(workspace)
    const nested = await repoAt(workspace, 'nested')
    // Two levels so the walk also lists the enclosing repository's own
    // children, where its `.git` directory must be skipped, not followed.
    const result = await (await gateway(configWith({ scanDepth: 2 }))).repositories({ cwd: enclosing })
    expect(result.repositories).toEqual([
      { root: enclosing, name: basename(enclosing) },
      { root: nested, name: 'nested' },
    ])
  })

  it('stops at the configured scan depth', async () => {
    if (!gitAvailable) return
    const workspace = plainDir()
    const deep = await repoAt(workspace, 'parent', 'clone')

    // The default depth is one level: `parent` is inspected, `parent/clone` is not.
    const shallow = await (await gateway()).repositories({ cwd: workspace })
    expect(shallow.repositories).toEqual([])
    expect(shallow.scanDepth).toBe(1)

    const deeper = await (await gateway(configWith({ scanDepth: 2 }))).repositories({ cwd: workspace })
    expect(deeper.repositories).toEqual([{ root: deep, name: 'clone' }])
    expect(deeper.scanDepth).toBe(2)
  })

  it('walks the whole subtree when the depth is unlimited', async () => {
    if (!gitAvailable) return
    const workspace = plainDir()
    const deep = await repoAt(workspace, 'a', 'b', 'clone')
    const result = await (await gateway(configWith({ scanDepth: -1 }))).repositories({ cwd: workspace })
    expect(result.repositories).toEqual([{ root: deep, name: 'clone' }])
  })

  it('does not enter the configured ignored directories', async () => {
    if (!gitAvailable) return
    const workspace = plainDir()
    const vendored = await repoAt(workspace, 'node_modules', 'tool')

    expect((await (await gateway(configWith({ scanDepth: 2 }))).repositories({ cwd: workspace })).repositories)
      .toEqual([])
    expect((await (await gateway(configWith({ scanDepth: 2, scanIgnoredFolders: [] })))
      .repositories({ cwd: workspace })).repositories).toEqual([{ root: vendored, name: 'tool' }])
  })

  it('skips a directory whose .git entry is not a repository', async () => {
    if (!gitAvailable) return
    const workspace = plainDir()
    const broken = join(workspace, 'broken')
    mkdirSync(broken)
    writeFileSync(join(broken, '.git'), 'not a gitdir\n')
    const clone = await repoAt(workspace, 'clone')

    const result = await (await gateway()).repositories({ cwd: workspace })
    expect(result.repositories).toEqual([{ root: clone, name: 'clone' }])
  })

  it('returns no repositories for a directory that holds none', async () => {
    if (!gitAvailable) return
    const workspace = plainDir()
    mkdirSync(join(workspace, 'src'))
    writeFileSync(join(workspace, 'readme.md'), '# notes\n')
    const result = await (await gateway()).repositories({ cwd: workspace })
    expect(result.repositories).toEqual([])
  })

  it('returns no repositories for a directory that cannot be read', async () => {
    if (!gitAvailable) return
    const result = await (await gateway()).repositories({ cwd: '/definitely/not/a/directory' })
    expect(result.repositories).toEqual([])
  })
})
