import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import LlmRuntime, { createMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionRecapService from '@deepseek-ai/dsh-session-recap'
import { Config as IdleConfig, apply as applyIdle, inject, name } from '@deepseek-ai/dsh-session-recap-idle-llm'

class ScriptedAdapter extends LlmAdapter {
  constructor(private readonly script: readonly StreamChunk[]) {
    super()
  }

  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield * this.script
  }
}

class FailingAdapter extends LlmAdapter {
  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('provider exploded')
  }
}

const SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'Idle recap' },
  { type: 'finish', reason: { kind: 'stop' } },
]

const RECAP_CONFIG = { maxBytes: 400, maxEntryBytes: 120 } as const
const IDLE_CONFIG = {
  minIdleMs: 1_000,
  minTurns: 2,
  targetCharacters: 120,
  maxInputBytes: 4_000,
  maxOutputTokens: 64,
  timeoutMs: 500,
  provider: 'recap-route',
  model: 'recap-model',
} as const

type IdleProviderConfig = Parameters<typeof applyIdle>[1]

async function harness(adapter: LlmAdapter = new ScriptedAdapter(SCRIPT)) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionRecapService, RECAP_CONFIG)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['recap-route'], adapter)
  return ctx
}

function completeTurn(_ctx: Context, session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `prompt ${turn}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: `answer ${turn}` }],
      source: { kind: 'model', provider: 'recap-route', model: 'recap-model' },
    }),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

function recapEvents(session: Session) {
  return session.snapshotEvents().filter(event => event.type === 'session/recap')
}

afterEach(() => {
  vi.useRealTimers()
})

describe('session-recap-idle-llm plugin surface', () => {
  it('exports the function-plugin identity and validates the idle cadence', async () => {
    expect(name).toBe('session-recap-idle-llm')
    expect(inject).toEqual(['sessionRecap', 'llm', 'sessions'])

    const ctx = await harness()
    expect(() => { applyIdle(ctx, undefined as never) }).toThrow('configuration is required')
    expect(() => { applyIdle(ctx, { ...IDLE_CONFIG, extra: true } as IdleProviderConfig) })
      .toThrow(/unknown config key "extra"/)
    expect(() => { applyIdle(ctx, { ...IDLE_CONFIG, minIdleMs: 0 }) })
      .toThrow(/minIdleMs must be a positive integer/)
    expect(() => { applyIdle(ctx, { ...IDLE_CONFIG, minTurns: 1.5 }) })
      .toThrow(/minTurns must be a positive integer/)
    expect(() => { applyIdle(ctx, { ...IDLE_CONFIG, maxInputBytes: 0 }) })
      .toThrow(/maxInputBytes must be a positive integer/)
    expect(IdleConfig).toBeDefined()
  })
})

describe('session-recap-idle-llm cadence', () => {
  it('generates one recap after a completed turn sits idle, and none without a completed turn', async () => {
    vi.useFakeTimers()
    const ctx = await harness()
    await ctx.plugin({ name, inject, Config: IdleConfig, apply: applyIdle }, IDLE_CONFIG)
    const session = ctx.sessions.create(SessionId('idle-happy'))

    completeTurn(ctx, session, 1)
    await vi.advanceTimersByTimeAsync(IDLE_CONFIG.minIdleMs)
    expect(recapEvents(session)).toHaveLength(0)

    completeTurn(ctx, session, 2)
    await vi.advanceTimersByTimeAsync(IDLE_CONFIG.minIdleMs)
    expect(recapEvents(session)).toHaveLength(1)
    expect(ctx.sessionRecap.get(session)).toMatchObject({
      text: 'Idle recap',
      source: { kind: 'provider', provider: name },
      turnRange: { first: 1, last: 2 },
    })

    session.append('turn/start', { turn: 3 })
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    await vi.advanceTimersByTimeAsync(IDLE_CONFIG.minIdleMs)
    expect(recapEvents(session)).toHaveLength(1)
  })

  it('clears a pending timer when a new turn starts or the session is disposed', async () => {
    vi.useFakeTimers()
    const ctx = await harness()
    const fiber = await ctx.plugin({ name, inject, Config: IdleConfig, apply: applyIdle }, IDLE_CONFIG)
    const session = ctx.sessions.create(SessionId('idle-cancel'))
    completeTurn(ctx, session, 1)
    completeTurn(ctx, session, 2)

    session.append('turn/start', { turn: 3 })
    await vi.advanceTimersByTimeAsync(IDLE_CONFIG.minIdleMs)
    expect(recapEvents(session)).toHaveLength(0)

    session.append('turn/end', { turn: 3, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    await vi.advanceTimersByTimeAsync(IDLE_CONFIG.minIdleMs)
    expect(recapEvents(session)).toHaveLength(0)

    const disposed = ctx.sessions.prepare(SessionId('idle-disposed'))
    const detach = ctx.sessions.enter(disposed)
    ctx.sessions.announce(disposed)
    detach()
    completeTurn(ctx, session, 4)
    await vi.advanceTimersByTimeAsync(IDLE_CONFIG.minIdleMs)
    expect(recapEvents(session)).toHaveLength(1)

    completeTurn(ctx, session, 5)
    await fiber.dispose()
    await vi.advanceTimersByTimeAsync(IDLE_CONFIG.minIdleMs)
    expect(recapEvents(session)).toHaveLength(1)
  })

  it('falls back to the session logged route when the plugin config omits the pair', async () => {
    vi.useFakeTimers()
    const ctx = await harness()
    const { provider: _provider, model: _model, ...unrouted } = IDLE_CONFIG
    await ctx.plugin({ name, inject, Config: IdleConfig, apply: applyIdle }, unrouted)
    const session = ctx.sessions.create(SessionId('idle-logged-route'))
    session.append('request/header', {
      header: { config: { provider: 'recap-route', model: 'recap-model' } },
      reason: 'initial',
    })
    completeTurn(ctx, session, 1)
    completeTurn(ctx, session, 2)

    await vi.advanceTimersByTimeAsync(IDLE_CONFIG.minIdleMs)
    expect(recapEvents(session)).toHaveLength(1)
    expect(ctx.sessionRecap.get(session)?.source).toMatchObject({
      model: { provider: 'recap-route', model: 'recap-model' },
    })
  })

  it('warns on an automatic generation failure and releases every timer on disposal', async () => {
    vi.useFakeTimers()
    const ctx = await harness(new FailingAdapter())
    const warn = vi.spyOn(ctx.logger, 'warn')
    await ctx.plugin({ name, inject, Config: IdleConfig, apply: applyIdle }, IDLE_CONFIG)
    const session = ctx.sessions.create(SessionId('idle-failure'))
    completeTurn(ctx, session, 1)
    completeTurn(ctx, session, 2)

    await vi.advanceTimersByTimeAsync(IDLE_CONFIG.minIdleMs)
    expect(recapEvents(session)).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('automatic recap failed'))

    await vi.advanceTimersByTimeAsync(IDLE_CONFIG.minIdleMs)
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
