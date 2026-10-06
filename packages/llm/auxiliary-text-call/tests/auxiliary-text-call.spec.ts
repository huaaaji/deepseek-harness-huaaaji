import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import LlmRuntime, { ToolCallId, isAgentLoopRequest, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  assertAuxiliaryTextLimits,
  resolveAuxiliaryTextRoute,
  runAuxiliaryTextCall,
} from '@deepseek-ai/dsh-auxiliary-text-call'

class RecordingAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(
    private readonly script: readonly StreamChunk[],
    private readonly onDispatch?: () => void,
  ) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.onDispatch?.()
    this.requests.push(options)
    yield * this.script
  }
}

class CooperativeAdapter extends LlmAdapter {
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const signal = options.signal
    if (signal === undefined) throw new Error('expected auxiliary request signal')
    await new Promise<never>((_resolve, reject) => {
      const rejectAbort = (): void => {
        // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- exercise exact AbortSignal.reason propagation
        reject(signal.reason)
      }
      if (signal.aborted) {
        rejectAbort()
        return
      }
      signal.addEventListener('abort', rejectAbort, { once: true })
    })
  }
}

const SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'first ' },
  { type: 'text-delta', index: 0, text: 'second' },
  { type: 'finish', reason: { kind: 'stop' } },
]

const LIMITS = {
  maxInputBytes: 1_000,
  maxOutputTokens: 32,
  timeoutMs: 1_000,
} as const

async function harness(script: readonly StreamChunk[] = SCRIPT, onDispatch?: () => void) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  const adapter = new RecordingAdapter(script, onDispatch)
  ctx.llm.registerAdapter(['route-a'], adapter)
  const session = ctx.sessions.create(SessionId('auxiliary'))
  session.append('turn/start', { turn: 1 })
  return { ctx, adapter, session }
}

function callOptions(session: Awaited<ReturnType<typeof harness>>['session'], overrides: Partial<AuxiliaryTextCallOptions> = {}) {
  return {
    label: 'auxiliary-text-call',
    session,
    route: { provider: 'route-a', model: 'model-a' },
    system: 'Summarize.',
    framedInput: 'payload',
    maxInputBytes: LIMITS.maxInputBytes,
    maxTokens: LIMITS.maxOutputTokens,
    timeoutMs: LIMITS.timeoutMs,
    timeoutCode: 'AUXILIARY_TIMEOUT',
    purpose: 'session-recap' as const,
    source: { kind: 'user' as const },
    signal: new AbortController().signal,
    record: (): void => undefined,
    ...overrides,
  }
}

type AuxiliaryTextCallOptions = Parameters<typeof runAuxiliaryTextCall>[1]

describe('assertAuxiliaryTextLimits', () => {
  it('validates each limit and the optional route pair under one label', () => {
    expect(() => { assertAuxiliaryTextLimits('probe', { ...LIMITS, maxInputBytes: 0 }) })
      .toThrow('probe: maxInputBytes must be a positive integer')
    expect(() => { assertAuxiliaryTextLimits('probe', { ...LIMITS, maxOutputTokens: 1.5 }) })
      .toThrow('probe: maxOutputTokens must be a positive integer')
    expect(() => { assertAuxiliaryTextLimits('probe', { ...LIMITS, timeoutMs: Number.NaN }) })
      .toThrow('probe: timeoutMs must be a positive integer')
    expect(() => { assertAuxiliaryTextLimits('probe', { ...LIMITS, timeoutMs: MAX_TIMER_DELAY_MS + 1 }) })
      .toThrow(/timeoutMs must not exceed/)
    expect(() => { assertAuxiliaryTextLimits('probe', { ...LIMITS, provider: 'only' }) })
      .toThrow(/provider and model must be supplied together/)
    expect(() => { assertAuxiliaryTextLimits('probe', { ...LIMITS, model: 'only' }) })
      .toThrow(/provider and model must be supplied together/)
    expect(() => { assertAuxiliaryTextLimits('probe', { ...LIMITS, provider: '', model: 'm' }) })
      .toThrow(/overrides must be non-empty strings/)
    expect(() => { assertAuxiliaryTextLimits('probe', { ...LIMITS, provider: 'p', model: '' }) })
      .toThrow(/overrides must be non-empty strings/)
    expect(() => { assertAuxiliaryTextLimits('probe', { ...LIMITS, provider: 'p', model: 'm' }) })
      .not.toThrow()
  })
})

describe('resolveAuxiliaryTextRoute', () => {
  it('prefers the explicit pair and otherwise requires a logged route', () => {
    expect(resolveAuxiliaryTextRoute('probe', { ...LIMITS, provider: 'p', model: 'm' }, { provider: 'logged', model: 'x' }))
      .toEqual({ provider: 'p', model: 'm' })
    expect(resolveAuxiliaryTextRoute('probe', LIMITS, { provider: 'logged', model: 'x' }))
      .toEqual({ provider: 'logged', model: 'x' })
    expect(() => resolveAuxiliaryTextRoute('probe', LIMITS)).toThrow(/no logged request route/)
  })
})

describe('runAuxiliaryTextCall', () => {
  it('measures the input, records the request before dispatch, and returns joined text', async () => {
    let recordedAtDispatch: unknown
    let record: unknown
    const { ctx, adapter, session } = await harness(SCRIPT, () => {
      recordedAtDispatch = record
    })
    const text = await runAuxiliaryTextCall(ctx, callOptions(session, {
      record: (request) => { record = request },
    }))

    expect(text).toBe('first second')
    expect(recordedAtDispatch).toEqual(record)
    const options = adapter.requests[0]!
    expect(Object.isFrozen(options)).toBe(true)
    expect(Object.isFrozen(options.messages)).toBe(true)
    expect(isAgentLoopRequest(options)).toBe(false)
    expect(options).toMatchObject({
      provider: 'route-a',
      model: 'model-a',
      maxTokens: 32,
      sessionId: session.id,
      purpose: 'session-recap',
      system: 'Summarize.',
    })
    expect(record).toEqual({ system: 'Summarize.', messages: options.messages, maxTokens: 32 })
  })

  it('rejects an oversized input, an absent route resolution, and a pre-aborted caller before dispatch', async () => {
    const { ctx, adapter, session } = await harness()
    await expect(runAuxiliaryTextCall(ctx, callOptions(session, { framedInput: 'x'.repeat(20), maxInputBytes: 4 })))
      .rejects.toThrow(/input is 20 bytes, exceeding maxInputBytes 4/)
    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    await expect(runAuxiliaryTextCall(ctx, callOptions(session, { signal: controller.signal })))
      .rejects.toThrow('caller stopped')
    expect(adapter.requests).toEqual([])
  })

  it.each([
    [{ kind: 'error', failure: { message: 'provider failed', code: 'SERVER' } }, 'provider failed', 'SERVER'],
    [{ kind: 'aborted', failure: { message: 'provider aborted', code: 'ABORTED' } }, 'provider aborted', 'ABORTED'],
  ] satisfies Array<[FinishReason, string, string]>)('preserves %s terminal failure details', async (reason, message, code) => {
    const { ctx, session } = await harness([{ type: 'finish', reason }])
    await expect(runAuxiliaryTextCall(ctx, callOptions(session)))
      .rejects.toMatchObject({ message, code })
  })

  it.each([
    [{ kind: 'max-tokens' }, /output reached maxOutputTokens/],
    [{ kind: 'tool-calls' }, /the model unexpectedly requested a tool/],
    [{ kind: 'future-finish' } as never, /unsupported finish reason "future-finish"/],
  ] satisfies Array<[FinishReason, RegExp]>)('rejects the terminal finish reason %s', async (reason, error) => {
    const { ctx, session } = await harness([{ type: 'finish', reason }])
    await expect(runAuxiliaryTextCall(ctx, callOptions(session))).rejects.toThrow(error)
  })

  it('rejects tool-call blocks and returns empty text for a text-free response', async () => {
    const tool = await harness([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: ToolCallId('auxiliary-tool'), name: 'unexpected', argumentsDelta: '{}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    await expect(runAuxiliaryTextCall(tool.ctx, callOptions(tool.session)))
      .rejects.toThrow(/output must contain text only/)

    const reasoning = await harness([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'thinking' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    await expect(runAuxiliaryTextCall(reasoning.ctx, callOptions(reasoning.session))).resolves.toBe('')
  })

  it('aborts a cooperative stream at the declared deadline', async () => {
    vi.useFakeTimers()
    try {
      const ctx = new Context()
      await ctx.plugin(SessionStore)
      await ctx.plugin(LlmRuntime)
      ctx.llm.registerAdapter(['route-a'], new CooperativeAdapter())
      const session = ctx.sessions.create(SessionId('auxiliary-timeout'))
      session.append('turn/start', { turn: 1 })
      const pending = runAuxiliaryTextCall(ctx, callOptions(session, { timeoutMs: 10 }))
      const rejected = expect(pending).rejects.toMatchObject({ code: 'AUXILIARY_TIMEOUT', timeoutMs: 10 })
      await vi.advanceTimersByTimeAsync(10)
      await rejected
    } finally {
      vi.useRealTimers()
    }
  })
})
