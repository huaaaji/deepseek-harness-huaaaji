import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session, type SessionSeq } from '@deepseek-ai/dsh-session'
import SessionRecapService, {
  SessionRecapProviderId,
  type SessionRecapProviderRequest,
} from '@deepseek-ai/dsh-session-recap'
import * as commandRecap from '@deepseek-ai/dsh-command-recap'

const RECAP_TEXT = 'Recap from the composed provider.'
const PROVIDER_ID = SessionRecapProviderId('loader-command-recap-test')

/** Source seq the composed provider reported, captured for the durable-event assertion. */
let reportedSourceSeq: SessionSeq | undefined

/** Test-only provider plugin mounted from the cordis.yml fixture. */
const testRecapProvider = {
  name: 'test-recap-provider',
  inject: ['sessionRecap'],
  apply(ctx: Context): void {
    ctx.effect(() => ctx.sessionRecap.register({
      id: PROVIDER_ID,
      generate: async (request: SessionRecapProviderRequest) => {
        const entry = request.entries[0]
        if (entry === undefined) throw new Error('expected one digest entry')
        reportedSourceSeq = entry.seq
        return { text: RECAP_TEXT, sourceSeqs: [entry.seq] }
      },
    }), 'test recap provider')
  },
}

/** The minimal live handle the command registry and this handler read. */
function agentFor(session: Session): Agent {
  return { session } as Agent
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  reportedSourceSeq = undefined
})

describe('command-recap real Loader composition', () => {
  it('discovers and executes /recap through the assembled command plane', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-command-recap-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-recap'",
      '  config:',
      '    maxBytes: 4096',
      '    maxEntryBytes: 512',
      "- name: '@deepseek-ai/dsh-commands'",
      "- name: '@test/recap-provider'",
      "- name: '@deepseek-ai/dsh-command-recap'",
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-session-recap', SessionRecapService],
      ['@deepseek-ai/dsh-commands', CommandRuntime],
      ['@test/recap-provider', testRecapProvider],
      ['@deepseek-ai/dsh-command-recap', commandRecap],
    ])
    const internal = context.loader.internal
    if (internal === undefined) throw new Error('the Node internal module loader is unavailable')
    context.loader.internal = Object.assign({}, internal, {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    })
    await context.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await context.loader.await()

    const session = context.sessions.create(SessionId('loader-command-recap'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'compose the recap' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const agent = agentFor(session)

    expect(context.commands.list(agent)).toContainEqual({
      definitionId: '@deepseek-ai/dsh-command-recap',
      name: 'recap',
      description: 'Generate a recap of recent work',
    })
    const execution = await context.commands.execute(agent, '/recap', [], new AbortController().signal)
    if (execution === undefined) throw new Error('Loader composition did not resolve /recap')
    const recapEvent = session.snapshotEvents().findLast(event => event.type === 'session/recap')
    if (recapEvent?.type !== 'session/recap') throw new Error('no session/recap event was appended')
    expect(execution.result).toEqual({
      kind: 'success',
      text: RECAP_TEXT,
      sourceEventSeq: recapEvent.seq,
    })
    expect(recapEvent.data).toEqual({
      text: RECAP_TEXT,
      source: { kind: 'provider', provider: PROVIDER_ID },
      sourceSeqs: [reportedSourceSeq],
      turnRange: { first: 1, last: 1 },
    })
    expect(session.snapshotEvents()
      .filter(event => event.type === 'command/run' || event.type === 'session/recap' || event.type === 'command/done')
      .map(event => event.type)).toEqual(['command/run', 'session/recap', 'command/done'])
    expect(session.deriveMessages()).toHaveLength(1)
  })
})
