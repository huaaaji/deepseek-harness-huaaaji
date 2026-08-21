import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import FileViewerGateway, { DEFAULT_MAX_ENTRIES, type FileViewerConfig } from '../src/index.ts'

interface Target {
  targetKey: string
  displayPath: string
}

interface FakeFs {
  resolve: (path: string) => Promise<Target>
  stat: (target: Target) => Promise<{ type: 'file' | 'directory' | 'other'; size?: number } | undefined>
  listDir: (target: Target) => Promise<Array<{ name: string; type: 'file' | 'directory' | 'other'; size?: number }>>
  readText: (target: Target) => Promise<string>
  streamText: (target: Target) => Promise<AsyncIterable<string> | Iterable<string>>
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** A fake fs answering with the overrides, defaults otherwise. */
function fakeFs(overrides: Partial<FakeFs> = {}): FakeFs {
  return {
    resolve: async (path: string) => ({ targetKey: `k:${path}`, displayPath: path }),
    stat: async () => ({ type: 'file', size: 4 }),
    listDir: async () => [],
    readText: async () => '',
    streamText: async () => [''],
    ...overrides,
  }
}

/** Boot the gateway against one fake fs and optional config, returning the live service. */
async function viewer(fs: FakeFs, config?: FileViewerConfig): Promise<FileViewerGateway> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.reflect.provide('fs', fs)
  await ctx.plugin(FileViewerGateway, config ?? {})
  return ctx.get('fileViewer') as FileViewerGateway
}

describe('FileViewerGateway', () => {
  it('publishes the two direct methods under the fileViewer namespace', async () => {
    const gateway = await viewer(fakeFs())
    expect(gateway.typertRemote).toMatchObject({ serviceKey: 'fileViewer', namespace: 'fileViewer' })
    expect(remoteMethods(gateway)).toEqual([
      { method: 'list', invocation: { kind: 'direct' } },
      { method: 'read', invocation: { kind: 'direct' } },
    ])
  })

  describe('list', () => {
    it('returns files and directories, dropping special entries', async () => {
      const gateway = await viewer(fakeFs({
        stat: async target => target.displayPath === '/dir' ? { type: 'directory' } : { type: 'file', size: 1 },
        listDir: async () => [
          { name: 'a.txt', type: 'file', size: 3 },
          { name: 'sub', type: 'directory' },
          { name: 'pipe', type: 'other' },
        ],
      }))
      expect(await gateway.list({ path: '/dir' })).toEqual({
        path: '/dir',
        entries: [
          { name: 'a.txt', kind: 'file', size: 3 },
          { name: 'sub', kind: 'directory', size: 0 },
        ],
        truncated: false,
        failure: null,
      })
    })

    it('marks a listing past the entry cap as truncated', async () => {
      const children = Array.from({ length: DEFAULT_MAX_ENTRIES + 1 }, (_, index) => ({
        name: `f${index}`, type: 'file' as const, size: 1,
      }))
      const gateway = await viewer(fakeFs({
        stat: async () => ({ type: 'directory' }),
        listDir: async () => children,
      }))
      const result = await gateway.list({ path: '/dir' })
      expect(result.entries).toHaveLength(DEFAULT_MAX_ENTRIES)
      expect(result.truncated).toBe(true)
      expect(result.failure).toBeNull()
    })

    it('honors a config-overridden entry cap', async () => {
      const children = Array.from({ length: 4 }, (_, index) => ({
        name: `f${index}`, type: 'file' as const, size: 1,
      }))
      const gateway = await viewer(fakeFs({
        stat: async () => ({ type: 'directory' }),
        listDir: async () => children,
      }), { maxEntries: 3 })
      const result = await gateway.list({ path: '/dir' })
      expect(result.entries).toHaveLength(3)
      expect(result.truncated).toBe(true)
      expect(result.failure).toBeNull()
    })

    it('reports not-found for an absent path', async () => {
      const gateway = await viewer(fakeFs({ stat: async () => undefined }))
      const result = await gateway.list({ path: '/missing' })
      expect(result.failure?.code).toBe('not-found')
      expect(result.entries).toEqual([])
    })

    it('reports not-directory for a file path', async () => {
      const gateway = await viewer(fakeFs({ stat: async () => ({ type: 'file', size: 1 }) }))
      const result = await gateway.list({ path: '/file' })
      expect(result.failure?.code).toBe('not-directory')
    })

    it('reports a thrown filesystem error as a structured failure', async () => {
      const gateway = await viewer(fakeFs({
        stat: async () => { throw new FsError('denied', 'FS_PERMISSION_DENIED') },
      }))
      const result = await gateway.list({ path: '/dir' })
      expect(result.failure).toEqual({ code: 'permission-denied', message: 'denied' })
    })
  })

  describe('read', () => {
    it('returns a numbered, syntax-tagged window from a small file', async () => {
      const gateway = await viewer(fakeFs({ readText: async () => 'one\ntwo\n' }))
      const result = await gateway.read({ path: '/f.ts', offset: 1, limit: 10 })
      expect(result.path).toBe('/f.ts')
      expect(result.lines).toEqual([
        { number: 1, text: 'one' },
        { number: 2, text: 'two' },
      ])
      expect(result.totalLines).toBe(2)
      expect(result.language).toBe('ts')
      expect(result.failure).toBeNull()
    })

    it('streams a size-less file and reports a null language for no extension', async () => {
      const gateway = await viewer(fakeFs({
        stat: async () => ({ type: 'file' }),
        streamText: async () => ['a\nb'],
      }))
      const result = await gateway.read({ path: '/Makefile', offset: 1, limit: 10 })
      expect(result.lines).toEqual([
        { number: 1, text: 'a' },
        { number: 2, text: 'b' },
      ])
      expect(result.language).toBeNull()
    })

    it('reports a binary file as a successful empty window', async () => {
      const gateway = await viewer(fakeFs({
        readText: async () => { throw new FsError('binary content', 'FS_NOT_TEXT') },
      }))
      const result = await gateway.read({ path: '/f.bin', offset: 1, limit: 10 })
      expect(result.binary).toBe(true)
      expect(result.lines).toEqual([])
      expect(result.failure).toBeNull()
    })

    it('reports not-found for an absent file', async () => {
      const gateway = await viewer(fakeFs({ stat: async () => undefined }))
      const result = await gateway.read({ path: '/missing', offset: 1, limit: 10 })
      expect(result.failure?.code).toBe('not-found')
    })

    it('reports not-regular-file for a directory path', async () => {
      const gateway = await viewer(fakeFs({ stat: async () => ({ type: 'directory' }) }))
      const result = await gateway.read({ path: '/dir', offset: 1, limit: 10 })
      expect(result.failure?.code).toBe('not-regular-file')
    })

    it('reports a non-text filesystem error through its code', async () => {
      const gateway = await viewer(fakeFs({
        readText: async () => { throw new FsError('huge', 'FS_TOO_LARGE') },
      }))
      const result = await gateway.read({ path: '/big.ts', offset: 1, limit: 10 })
      expect(result.failure).toEqual({ code: 'too-large', message: 'huge' })
    })

    it('reports a plain thrown error as io-error', async () => {
      const gateway = await viewer(fakeFs({
        readText: async () => { throw new Error('boom') },
      }))
      const result = await gateway.read({ path: '/f.ts', offset: 1, limit: 10 })
      expect(result.failure?.code).toBe('io-error')
    })

    it('clamps an out-of-range offset to a not-found failure', async () => {
      const gateway = await viewer(fakeFs({ readText: async () => 'one\n' }))
      const result = await gateway.read({ path: '/f.ts', offset: 5, limit: 10 })
      expect(result.failure?.code).toBe('not-found')
    })
  })
})
