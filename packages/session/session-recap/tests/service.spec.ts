import {
  createMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
  type ContextFormed,
} from '@deepseek-ai/dsh-llm'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import SessionStore, { Session, SessionId, type SessionSeq } from '@deepseek-ai/dsh-session'
import SessionRecapService, {
  SessionRecapError,
  SessionRecapProviderId,
  foldSessionRecap,
  type Config,
  type SessionRecapEntry,
  type SessionRecapProvider,
  type SessionRecapProviderRequest,
  type SessionRecapProviderResult,
} from '@deepseek-ai/dsh-session-recap'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'recap-test': { kind: 'recap-test' } & ContextFormed
  }
}

const CONFIG = { maxBytes: 400, maxEntryBytes: 120 } as const

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

async function setup(config: Config = CONFIG): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionRecapService, config)
  return ctx
}

function startTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
}

function prompt(session: Session, text: string) {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

function notice(session: Session, text: string) {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'recap-test', form: 'notice', summary: text },
  }), { surfaceOp: 'append' })
}

function assistant(session: Session, turn: number, text: string) {
  return session.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    }),
  }, { surfaceOp: 'append' })
}

function toolExchange(session: Session, turn: number, callId: string, result: string) {
  const id = ToolCallId(callId)
  session.append('tool/call', { turn, step: 1, callId: id, name: 'bash', arguments: '{}' })
  return session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({ callId: id, content: [{ type: 'text', text: result }], isError: false }),
  }, { surfaceOp: 'append' })
}

function route(session: Session, provider: string, model: string): void {
  session.append('request/header', { header: { config: { provider, model } }, reason: 'initial' })
}

/** A provider that returns whatever its result factory produces. */
function providerOf(
  result: (request: SessionRecapProviderRequest) => Promise<SessionRecapProviderResult>,
  id = 'recap-provider',
): SessionRecapProvider {
  return { id: SessionRecapProviderId(id), generate: result }
}

describe('SessionRecapService configuration', () => {
  it('requires explicit positive limits', () => {
    expect(() => new SessionRecapService(new Context(), undefined as never))
      .toThrow('configuration is required')
    expect(() => new SessionRecapService(new Context(), null as never))
      .toThrow('configuration is required')
    expect(() => new SessionRecapService(new Context(), { maxBytes: 0, maxEntryBytes: 10 }))
      .toThrow(/maxBytes must be a positive integer/)
    expect(() => new SessionRecapService(new Context(), { maxBytes: 10, maxEntryBytes: 1.5 }))
      .toThrow(/maxEntryBytes must be a positive integer/)
  })
})

describe('SessionRecapService digest and acceptance', () => {
  it('collects the covered window, accepts a normalized recap, and leaves history untouched', async () => {
    const ctx = await setup()
    let observed: SessionRecapProviderRequest | undefined
    ctx.sessionRecap.register(providerOf(async (request) => {
      observed = request
      const first = request.entries[0]!
      return {
        text: '\u001B[31mShipped the recap seam\u001B[0m and wired the command',
        sourceSeqs: [first.seq],
        ...(request.route === undefined ? {} : { model: request.route }),
      }
    }))
    const session = ctx.sessions.create(SessionId('digest'))
    startTurn(session, 1)
    const first = prompt(session, 'Add the recap seam')
    const reply = assistant(session, 1, 'Seam landed')
    const result = toolExchange(session, 1, 'call-1', 'ok')
    const injected = notice(session, 'background job finished')
    startTurn(session, 2)
    const second = prompt(session, 'Now wire the command')
    route(session, 'main-route', 'chat-model')
    const before = session.snapshotEvents().length

    await expect(ctx.sessionRecap.generate(session)).resolves.toMatchObject({
      text: 'Shipped the recap seam and wired the command',
      source: { kind: 'provider', provider: 'recap-provider', model: { provider: 'main-route', model: 'chat-model' } },
      sourceSeqs: [first.seq],
      turnRange: { first: 1, last: 2 },
    })
    expect(observed?.route).toEqual({ provider: 'main-route', model: 'chat-model' })
    expect(observed?.turnRange).toEqual({ first: 1, last: 2 })
    expect(observed?.entries.map(entry => [entry.kind, entry.turn])).toEqual([
      ['user', 1],
      ['assistant', 1],
      ['tool', 1],
      ['notice', 1],
      ['user', 2],
    ])
    expect(observed?.entries[2]).toMatchObject({ name: 'bash', text: 'ok' })

    const logged = session.snapshotEvents().findLast(event => event.type === 'session/recap')
    expect(logged?.data).toMatchObject({
      text: 'Shipped the recap seam and wired the command',
      sourceSeqs: [first.seq],
      turnRange: { first: 1, last: 2 },
    })
    expect(session.snapshotEvents().length).toBe(before + 1)
    expect(session.deriveMessages()).toHaveLength(5)
    expect(result.seq).toBeLessThan(second.seq)
    expect(injected.seq).toBeGreaterThan(reply.seq)
    expect(ctx.sessionRecap.get(session)).toEqual({
      text: 'Shipped the recap seam and wired the command',
      source: { kind: 'provider', provider: 'recap-provider', model: { provider: 'main-route', model: 'chat-model' } },
      sourceSeqs: [first.seq],
      turnRange: { first: 1, last: 2 },
      eventSeq: logged?.seq,
      updatedAt: logged?.time,
    })
    expect(foldSessionRecap(session.snapshotEvents())).toEqual(ctx.sessionRecap.get(session))
  })

  it('covers only the window after the last accepted recap and reports an empty window', async () => {
    const ctx = await setup()
    const sources: SessionSeq[][] = []
    ctx.sessionRecap.register(providerOf(async (request) => {
      sources.push(request.entries.map(entry => entry.seq))
      return { text: `recap ${sources.length}`, sourceSeqs: [request.entries[0]!.seq] }
    }))
    const session = ctx.sessions.create(SessionId('window'))
    startTurn(session, 1)
    const first = prompt(session, 'First')
    await expect(ctx.sessionRecap.generate(session)).resolves.toMatchObject({ text: 'recap 1' })
    await expect(ctx.sessionRecap.generate(session)).rejects.toMatchObject({ code: 'empty' })
    startTurn(session, 2)
    const second = prompt(session, 'Second')
    const third = assistant(session, 2, 'Done')
    await expect(ctx.sessionRecap.generate(session)).resolves.toMatchObject({
      text: 'recap 2',
      turnRange: { first: 2, last: 2 },
    })
    expect(sources).toEqual([[first.seq], [second.seq, third.seq]])
    expect(ctx.sessionRecap.get(session)?.eventSeq).toBe(
      session.snapshotEvents().findLast(event => event.type === 'session/recap')?.seq,
    )
  })

  it('omits an absent route, caps the accepted text, and bounds each digest entry', async () => {
    const ctx = await setup({ maxBytes: 12, maxEntryBytes: 8 })
    let observed: SessionRecapProviderRequest | undefined
    ctx.sessionRecap.register(providerOf(async (request) => {
      observed = request
      return { text: 'completed the whole migration', sourceSeqs: [request.entries[0]!.seq] }
    }))
    const session = ctx.sessions.create(SessionId('caps'))
    startTurn(session, 1)
    prompt(session, '0123456789ABCDEF')
    await expect(ctx.sessionRecap.generate(session)).resolves.toMatchObject({ text: 'completed th' })
    expect(observed?.route).toBeUndefined()
    expect(observed?.entries[0]?.text).toBe('01234567')
    expect(ctx.sessionRecap.get(session)?.source).toEqual({ kind: 'provider', provider: 'recap-provider' })
  })

  it('skips entries that carry no visible text and accepts an omitted model report', async () => {
    const ctx = await setup()
    let entries: readonly SessionRecapEntry[] = []
    ctx.sessionRecap.register(providerOf(async (request) => {
      entries = request.entries
      return { text: 'Only the tool ran', sourceSeqs: [request.entries[0]!.seq] }
    }))
    const session = ctx.sessions.create(SessionId('sparse'))
    startTurn(session, 1)
    prompt(session, '   ')
    assistant(session, 1, '\u0007')
    const result = toolExchange(session, 1, 'call-2', 'done')
    toolExchange(session, 1, 'call-3', '\u001B[31m')
    await ctx.sessionRecap.generate(session)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ seq: result.seq, kind: 'tool', text: 'done' })
  })

  it('records a tool result whose call was never observed without a tool name', async () => {
    const ctx = await setup()
    let entries: readonly SessionRecapEntry[] = []
    ctx.sessionRecap.register(providerOf(async (request) => {
      entries = request.entries
      return { text: 'Unpaired tool result', sourceSeqs: [request.entries[0]!.seq] }
    }))
    const session = ctx.sessions.create(SessionId('unpaired'))
    startTurn(session, 1)
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('never-called'),
        content: [{ type: 'text', text: 'orphan output' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    await expect(ctx.sessionRecap.generate(session)).resolves.toMatchObject({ text: 'Unpaired tool result' })
    expect(entries[0]).toMatchObject({ kind: 'tool', text: 'orphan output', turn: 1 })
    expect(entries[0]?.name).toBeUndefined()
  })

  it('returns undefined before any recap and for logs whose last event is not a recap', async () => {
    const session = Session.create(SessionId('fold'))
    expect(foldSessionRecap(session.snapshotEvents())).toBeUndefined()
    session.append('turn/start', { turn: 1 })
    expect(foldSessionRecap(session.snapshotEvents())).toBeUndefined()
  })

  it('reports generation failure for provider errors and invalid results', async () => {
    const cases: [string, SessionRecapProviderResult | null, RegExp][] = [
      ['invalid object', null, /returned an invalid result/],
      ['non-string text', { text: 7 as never, sourceSeqs: [] }, /text must be a string/],
      ['empty text', { text: '\u001B[31m \u0007', sourceSeqs: [] }, /returned empty text/],
      ['missing seqs', { text: 'text', sourceSeqs: [] }, /at least one source seq/],
      ['seqs not an array', { text: 'text', sourceSeqs: 'x' as never }, /at least one source seq/],
      ['unknown seq', { text: 'text', sourceSeqs: [999 as never] }, /ordered seqs from the request/],
      ['non-numeric seq', { text: 'text', sourceSeqs: ['1' as never] }, /ordered seqs from the request/],
    ]
    for (const [label, result, expected] of cases) {
      const ctx = await setup()
      ctx.sessionRecap.register(providerOf(async () => result as SessionRecapProviderResult))
      const session = ctx.sessions.create(SessionId(`invalid-${label}`))
      startTurn(session, 1)
      prompt(session, 'Work')
      await expect(ctx.sessionRecap.generate(session), label).rejects.toThrow(expected)
      expect(session.snapshotEvents().some(event => event.type === 'session/recap'), label).toBe(false)
    }

    const ctx = await setup()
    ctx.sessionRecap.register(providerOf(async () => { throw new Error('model exploded') }))
    const session = ctx.sessions.create(SessionId('provider-throw'))
    startTurn(session, 1)
    prompt(session, 'Work')
    await expect(ctx.sessionRecap.generate(session)).rejects.toMatchObject({ code: 'generation' })
    const failure: unknown = await ctx.sessionRecap.generate(session).then(
      () => { throw new Error('expected the recap to fail') },
      (error: unknown) => error,
    )
    expect(String(failure)).toContain('model exploded')

    const ordered = await setup()
    ordered.sessionRecap.register(providerOf(async request => ({
      text: 'out of order',
      sourceSeqs: [request.entries[1]!.seq, request.entries[0]!.seq],
    })))
    const orderedSession = ordered.sessions.create(SessionId('ordered'))
    startTurn(orderedSession, 1)
    prompt(orderedSession, 'One')
    assistant(orderedSession, 1, 'Two')
    await expect(ordered.sessionRecap.generate(orderedSession))
      .rejects.toThrow(/ordered seqs from the request/)

    for (const [label, model] of [
      ['bad model', { provider: '', model: 'm' }],
      ['non-object model', null],
    ] as const) {
      const models = await setup()
      models.sessionRecap.register(providerOf(async request => ({
        text: 'text',
        sourceSeqs: [request.entries[0]!.seq],
        model: model as never,
      })))
      const modelSession = models.sessions.create(SessionId(`model-${label}`))
      startTurn(modelSession, 1)
      prompt(modelSession, 'Work')
      await expect(models.sessionRecap.generate(modelSession), label)
        .rejects.toThrow(/non-empty provider and model/)
    }
  })
})

describe('SessionRecapService lifecycle', () => {
  it('reports an unregistered provider and rejects detached sessions or pre-aborted requests', async () => {
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('no-provider'))
    startTurn(session, 1)
    prompt(session, 'Work')
    await expect(ctx.sessionRecap.generate(session)).rejects.toMatchObject({ code: 'unavailable' })
    await expect(ctx.sessionRecap.generate(Session.create(SessionId('detached'))))
      .rejects.toThrow(/not live in this store/)

    ctx.sessionRecap.register(providerOf(async () => ({ text: 'unused', sourceSeqs: [] })))
    const controller = new AbortController()
    controller.abort(new Error('already cancelled'))
    await expect(ctx.sessionRecap.generate(session, controller.signal)).rejects.toThrow('already cancelled')
  })

  it('validates provider registrations and replaces a disposed registration', async () => {
    const ctx = await setup()
    expect(() => ctx.sessionRecap.register(null as never)).toThrow(/provider must be an object/)
    expect(() => ctx.sessionRecap.register({ id: '', generate: async () => ({ text: 'x', sourceSeqs: [] }) } as never))
      .toThrow(/provider id must be a non-empty string/)
    expect(() => ctx.sessionRecap.register({ id: SessionRecapProviderId('x') } as never))
      .toThrow(/requires generate\(\)/)

    const dispose = ctx.sessionRecap.register(providerOf(async () => ({ text: 'x', sourceSeqs: [] }), 'first'))
    expect(() => ctx.sessionRecap.register(providerOf(async () => ({ text: 'y', sourceSeqs: [] }), 'second')))
      .toThrow(/already registered/)
    await dispose()
    const session = ctx.sessions.create(SessionId('replaced'))
    startTurn(session, 1)
    prompt(session, 'Work')
    await expect(ctx.sessionRecap.generate(session)).rejects.toMatchObject({ code: 'unavailable' })
    const disposeSecond = ctx.sessionRecap.register(providerOf(async request => ({
      text: 'second provider',
      sourceSeqs: [request.entries[0]!.seq],
    }), 'second'))
    await expect(ctx.sessionRecap.generate(session)).resolves.toMatchObject({ text: 'second provider' })
    await disposeSecond()
  })

  it('propagates caller cancellation and session disposal to active generation', async () => {
    const callerCtx = await setup()
    const pending = deferred<SessionRecapProviderResult>()
    let signal: AbortSignal | undefined
    callerCtx.sessionRecap.register(providerOf(async (request) => {
      signal = request.signal
      return pending.promise
    }))
    const session = callerCtx.sessions.create(SessionId('cancel'))
    startTurn(session, 1)
    prompt(session, 'Work')
    const controller = new AbortController()
    const running = callerCtx.sessionRecap.generate(session, controller.signal)
    await settle()
    controller.abort(new Error('caller cancelled'))
    pending.resolve({ text: 'late', sourceSeqs: [] })
    await expect(running).rejects.toThrow('caller cancelled')
    expect(signal?.aborted).toBe(true)

    const disposeCtx = await setup()
    const disposePending = deferred<SessionRecapProviderResult>()
    let disposeSignal: AbortSignal | undefined
    disposeCtx.sessionRecap.register(providerOf(async (request) => {
      disposeSignal = request.signal
      return disposePending.promise
    }))
    const prepared = disposeCtx.sessions.prepare(SessionId('session-dispose'))
    const detach = disposeCtx.sessions.enter(prepared)
    disposeCtx.sessions.announce(prepared)
    startTurn(prepared, 1)
    prompt(prepared, 'Work')
    const disposed = disposeCtx.sessionRecap.generate(prepared)
    await settle()
    detach()
    disposePending.resolve({ text: 'ignored', sourceSeqs: [] })
    await expect(disposed).rejects.toThrow('session disposed during recap generation')
    expect(disposeSignal?.aborted).toBe(true)
  })

  it('supersedes an in-flight generation and rejects new work once the service is disposed', async () => {
    const ctx = await setup()
    const first = deferred<SessionRecapProviderResult>()
    const second = deferred<SessionRecapProviderResult>()
    let calls = 0
    ctx.sessionRecap.register(providerOf(async () => {
      calls += 1
      return calls === 1 ? first.promise : second.promise
    }))
    const session = ctx.sessions.create(SessionId('supersede'))
    startTurn(session, 1)
    const covered = prompt(session, 'Work')
    const running = ctx.sessionRecap.generate(session)
    await settle()
    const superseding = ctx.sessionRecap.generate(session)
    await settle()
    first.resolve({ text: 'stale', sourceSeqs: [] })
    second.resolve({ text: 'fresh', sourceSeqs: [covered.seq] })
    await expect(running).rejects.toThrow('superseded older generation')
    await expect(superseding).resolves.toMatchObject({ text: 'fresh' })

    const service = ctx.sessionRecap
    await ctx.fiber.dispose()
    await expect(service.generate(session)).rejects.toThrow('session-recap service disposed')
  })

  it('keeps a disposing provider unavailable until its registration is released', async () => {
    const ctx = await setup()
    const pending = deferred<SessionRecapProviderResult>()
    const dispose = ctx.sessionRecap.register(providerOf(() => pending.promise))
    const session = ctx.sessions.create(SessionId('closing'))
    startTurn(session, 1)
    prompt(session, 'Work')
    const running = ctx.sessionRecap.generate(session)
    await settle()
    const disposal = dispose()
    await expect(ctx.sessionRecap.generate(session)).rejects.toMatchObject({ code: 'unavailable' })
    pending.resolve({ text: 'late', sourceSeqs: [] })
    await expect(running).rejects.toThrow('was disposed')
    await disposal
  })

  it('aborts active generation when the owning service is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const serviceFiber = await ctx.plugin(SessionRecapService, CONFIG)
    const pending = deferred<SessionRecapProviderResult>()
    let signal: AbortSignal | undefined
    ctx.sessionRecap.register(providerOf(async (request) => {
      signal = request.signal
      return pending.promise
    }))
    const session = ctx.sessions.create(SessionId('service-dispose'))
    startTurn(session, 1)
    prompt(session, 'Work')
    const running = ctx.sessionRecap.generate(session)
    await settle()
    const disposal = serviceFiber.dispose()
    pending.resolve({ text: 'late', sourceSeqs: [] })
    await expect(running).rejects.toThrow('session-recap service disposed')
    expect(signal?.aborted).toBe(true)
    await disposal
  })

  it('exposes an expected-failure error class that callers can narrow on', () => {
    expect(new SessionRecapError('empty', 'nothing')).toMatchObject({ name: 'SessionRecapError', code: 'empty' })
  })

  it('disposes cleanly with no provider ever registered', async () => {
    const ctx = await setup()
    await expect(ctx.fiber.dispose()).resolves.toBeUndefined()
  })

  it('reports provider rejection through the service logger contract', async () => {
    const ctx = await setup()
    const warn = vi.spyOn(ctx.logger, 'warn')
    ctx.sessionRecap.register(providerOf(async () => { throw new Error('boom') }))
    const session = ctx.sessions.create(SessionId('warn'))
    startTurn(session, 1)
    prompt(session, 'Work')
    await expect(ctx.sessionRecap.generate(session)).rejects.toMatchObject({ code: 'generation' })
    expect(warn).not.toHaveBeenCalled()
  })
})
