import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime, { CommandId, type CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, type SessionSeq } from '@deepseek-ai/dsh-session'
import SessionRecapService, {
  SessionRecapProviderId,
  type SessionRecapProvider,
  type SessionRecapProviderRequest,
  type SessionRecapProviderResult,
} from '@deepseek-ai/dsh-session-recap'
import * as commandRecap from '@deepseek-ai/dsh-command-recap'

const RECAP_TEXT = 'You asked for a recap of the migration work.'
const PROVIDER_ID = SessionRecapProviderId('command-recap-test')

/** One recap provider whose generation step the test supplies. */
function providerOf(
  generate: (request: SessionRecapProviderRequest) => Promise<SessionRecapProviderResult>,
): SessionRecapProvider {
  return { id: PROVIDER_ID, generate }
}

/** The minimal live handle the command registry and this handler read. */
function agentFor(session: Session): Agent {
  return { session } as Agent
}

interface HarnessOptions {
  readonly provider?: SessionRecapProvider
  readonly entries?: boolean
  readonly detachedSession?: boolean
}

interface Harness {
  readonly ctx: Context
  readonly session: Session
  readonly agent: Agent
  readonly plugin: Awaited<ReturnType<Context['plugin']>>
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const ctx = new Context()
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionRecapService, { maxBytes: 512, maxEntryBytes: 128 })
  if (options.provider !== undefined) ctx.sessionRecap.register(options.provider)
  const session = options.detachedSession === true
    ? Session.create(SessionId('command-recap-detached'))
    : ctx.sessions.create(SessionId('command-recap'))
  if (options.entries !== false) {
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'do the work' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
  const agent = agentFor(session)
  const plugin = await ctx.plugin(commandRecap)
  return { ctx, session, agent, plugin }
}

async function run(
  test: Harness,
  suffix = '',
  controller = new AbortController(),
): Promise<NonNullable<Awaited<ReturnType<CommandRuntime['execute']>>>> {
  const execution = await test.ctx.commands.execute(test.agent, `/recap${suffix}`, [], controller.signal)
  if (execution === undefined) throw new Error('recap command was not registered')
  return execution
}

/** Assert the executor-owned lifecycle pair and return its pairing id. */
function expectLastLifecycle(
  test: Harness,
  args: string,
  outcome: CommandResult,
): string {
  const lifecycle = test.session.snapshotEvents()
    .filter(event => event.type === 'command/run' || event.type === 'command/done')
    .slice(-2)
  const runEvent = lifecycle[0]
  const doneEvent = lifecycle[1]
  if (runEvent?.type !== 'command/run' || doneEvent?.type !== 'command/done') {
    throw new Error(`expected command lifecycle pair, got ${lifecycle.map(event => event.type).join(',')}`)
  }
  expect(lifecycle.map(event => ({ type: event.type, data: event.data }))).toEqual([
    {
      type: 'command/run',
      data: {
        commandId: runEvent.data.commandId,
        name: 'recap',
        args,
        source: { kind: 'user' },
      },
    },
    {
      type: 'command/done',
      data: {
        commandId: runEvent.data.commandId,
        ...outcome,
      },
    },
  ])
  expect(doneEvent.data.commandId).toBe(runEvent.data.commandId)
  return runEvent.data.commandId
}

/** A provider that always reports one digest entry as its source. */
function reportingProvider(onCall?: () => void): SessionRecapProvider {
  return providerOf(async (request) => {
    onCall?.()
    const entry = request.entries[0]
    if (entry === undefined) throw new Error('expected one digest entry')
    return { text: RECAP_TEXT, sourceSeqs: [entry.seq] }
  })
}

describe('@deepseek-ai/dsh-command-recap registration', () => {
  it('registers one argument-free command with Loader-safe exports and disposes it', async () => {
    const test = await harness({ provider: reportingProvider() })
    expect(commandRecap.name).toBe('command-recap')
    expect(commandRecap.inject).toEqual(['commands', 'sessionRecap'])
    expect('default' in commandRecap).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    expect(loader.unwrapExports(commandRecap)).toBe(commandRecap)
    expect(test.ctx.commands.list(test.agent)).toContainEqual({
      definitionId: '@deepseek-ai/dsh-command-recap',
      name: 'recap',
      description: 'Generate a recap of recent work',
    })

    await test.plugin.dispose()
    expect(test.ctx.commands.find(test.agent, 'recap')).toBeUndefined()
  })
})

describe('/recap human command', () => {
  it('reports the generated recap with its source event and leaves history unchanged', async () => {
    let sourceSeq: SessionSeq | undefined
    const test = await harness({
      provider: providerOf(async (request) => {
        const entry = request.entries[0]
        if (entry === undefined) throw new Error('expected one digest entry')
        sourceSeq = entry.seq
        return { text: RECAP_TEXT, sourceSeqs: [entry.seq] }
      }),
    })
    const execution = await run(test)
    const recapEvent = test.session.snapshotEvents().findLast(event => event.type === 'session/recap')
    if (recapEvent?.type !== 'session/recap') throw new Error('no session/recap event was appended')
    expect(execution.result).toEqual({
      kind: 'success',
      text: RECAP_TEXT,
      sourceEventSeq: recapEvent.seq,
    })
    expect(recapEvent.data).toEqual({
      text: RECAP_TEXT,
      source: { kind: 'provider', provider: PROVIDER_ID },
      sourceSeqs: [sourceSeq],
      turnRange: { first: 1, last: 1 },
    })
    expect(execution.commandId).toBe(expectLastLifecycle(test, '', execution.result))
    expect(test.session.deriveMessages()).toHaveLength(1)
  })

  it('rejects arguments without invoking the generator', async () => {
    let calls = 0
    const test = await harness({ provider: reportingProvider(() => { calls += 1 }) })
    const rejected = await run(test, ' now')
    expect(rejected.result).toEqual({ kind: 'error', text: 'Usage: /recap (no arguments)' })
    expect(rejected.commandId).toBe(expectLastLifecycle(test, ' now', rejected.result))
    expect(calls).toBe(0)
    expect(test.session.snapshotEvents().some(event => event.type === 'session/recap')).toBe(false)
  })

  it('maps an unavailable generator to a direct error', async () => {
    const test = await harness()
    const execution = await run(test)
    expect(execution.result).toEqual({
      kind: 'error',
      text: 'Recap is unavailable because no recap generator is configured.',
    })
    expect(execution.commandId).toBe(expectLastLifecycle(test, '', execution.result))
  })

  it('maps an empty window to a direct error', async () => {
    let calls = 0
    const test = await harness({ entries: false, provider: reportingProvider(() => { calls += 1 }) })
    const execution = await run(test)
    expect(execution.result).toEqual({ kind: 'error', text: 'Nothing new to recap yet.' })
    expect(execution.commandId).toBe(expectLastLifecycle(test, '', execution.result))
    expect(calls).toBe(0)
  })

  it('maps a generation failure to a direct error', async () => {
    const test = await harness({
      provider: providerOf(async () => { throw new Error('provider exploded') }),
    })
    const execution = await run(test)
    expect(execution.result).toEqual({ kind: 'error', text: 'The recap could not be generated.' })
    expect(execution.commandId).toBe(expectLastLifecycle(test, '', execution.result))
  })

  it('maps a caller cancellation the handler observes to the cancelled outcome', async () => {
    const test = await harness({ provider: reportingProvider() })
    const definition = test.ctx.commands.find(test.agent, 'recap')
    if (definition === undefined) throw new Error('recap command was not registered')
    const controller = new AbortController()
    controller.abort(new Error('operator cancelled'))
    const result = await definition.handler({
      commandId: CommandId('direct-cancellation'),
      agent: test.agent,
      rawInput: '',
      attachments: [],
      signal: controller.signal,
    })
    expect(result).toEqual({ kind: 'error', text: 'Recap cancelled.' })
  })

  it('preserves the executor-owned cancellation and an unexpected implementation failure', async () => {
    const controller = new AbortController()
    const abort = new Error('operator cancelled')
    const cancelled = await harness({
      provider: providerOf(async () => {
        controller.abort(abort)
        throw new Error('provider failed after cancellation')
      }),
    })
    await expect(run(cancelled, '', controller)).rejects.toBe(abort)
    expectLastLifecycle(cancelled, '', { kind: 'error', text: abort.message })

    const detached = await harness({ detachedSession: true, provider: reportingProvider() })
    await expect(run(detached)).rejects.toThrow(/is not live in this store/)
  })

  it('unregisters /recap before draining an in-flight handler', async () => {
    const started = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const finished = Promise.withResolvers<undefined>()
    const test = await harness({
      provider: providerOf(async (request) => {
        started.resolve(undefined)
        await release.promise
        finished.resolve(undefined)
        const entry = request.entries[0]
        if (entry === undefined) throw new Error('expected one digest entry')
        return { text: RECAP_TEXT, sourceSeqs: [entry.seq] }
      }),
    })

    const execution = run(test)
    await started.promise
    let disposed = false
    const disposal = test.plugin.dispose()
    void disposal.then(() => { disposed = true })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(test.ctx.commands.find(test.agent, 'recap')).toBeUndefined()
    expect(disposed).toBe(false)

    release.resolve(undefined)
    await finished.promise
    await expect(execution).resolves.toMatchObject({ result: { kind: 'success', text: RECAP_TEXT } })
    await disposal
    expect(disposed).toBe(true)
  })
})
