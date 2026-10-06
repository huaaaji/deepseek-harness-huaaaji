import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import LlmRuntime, { createUserMessage, ToolCallId, isAgentLoopRequest, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionRecapService, { SessionRecapProviderId } from '@deepseek-ai/dsh-session-recap'
import type { SessionRecapEntry, SessionRecapProviderRequest } from '@deepseek-ai/dsh-session-recap'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  generateSessionRecapWithLlm,
  registerSessionRecapLlmProvider,
  resolveSessionRecapLlmConfig,
  selectSessionRecapDigest,
  SESSION_RECAP_TIMEOUT_CODE,
} from '@deepseek-ai/dsh-session-recap-llm'
import type { SessionRecapLlmConfig } from '@deepseek-ai/dsh-session-recap-llm'

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
    if (signal === undefined) throw new Error('expected recap request signal')
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

class DelayedSuccessAdapter extends LlmAdapter {
  constructor(private readonly delayMs: number) {
    super()
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    await new Promise<void>(resolve => setTimeout(resolve, this.delayMs))
    yield * SCRIPT
  }
}

const SCRIPT: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '  Wired the recap seam \u001B[31m and the command  ' },
  { type: 'finish', reason: { kind: 'stop' } },
]

const CONFIG = {
  targetCharacters: 120,
  maxInputBytes: 4_000,
  maxOutputTokens: 64,
  timeoutMs: 1_000,
} as const

const RECAP_PROVIDER = SessionRecapProviderId('test-recap-provider')
const CONFIG_SERVICE = { maxBytes: 400, maxEntryBytes: 120 } as const
let nextSession = 0

function entries(count: number, textLength = 8): SessionRecapEntry[] {
  return Array.from({ length: count }, (_value, index) => ({
    seq: SessionSeq(index),
    kind: index === 0 ? 'user' : index % 2 === 0 ? 'assistant' : 'tool',
    turn: index + 1,
    ...(index % 2 === 1 ? { name: 'bash' } : {}),
    text: `entry ${index} ${'x'.repeat(textLength)}`,
  }))
}

function request(ctx: Context, window = entries(3), signal = new AbortController().signal): SessionRecapProviderRequest {
  const session = ctx.sessions.create(SessionId(`recap-call-${++nextSession}`))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'start the window' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  return {
    session,
    entries: window,
    turnRange: { first: window[0]!.turn, last: window.at(-1)!.turn },
    route: { provider: 'current-route', model: 'current-model' },
    signal,
  }
}

async function withScript(script: readonly StreamChunk[]): Promise<{ ctx: Context; adapter: RecordingAdapter }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  const adapter = new RecordingAdapter(script)
  ctx.llm.registerAdapter(['current-route'], adapter)
  return { ctx, adapter }
}

describe('resolveSessionRecapLlmConfig', () => {
  it('requires every deployment limit and a complete optional route pair', () => {
    expect(() => resolveSessionRecapLlmConfig(undefined as never)).toThrow(/configuration is required/)
    expect(() => resolveSessionRecapLlmConfig(null as never)).toThrow(/configuration is required/)
    expect(() => resolveSessionRecapLlmConfig('invalid' as never)).toThrow(/configuration is required/)
    expect(() => resolveSessionRecapLlmConfig({ ...CONFIG, extra: true } as SessionRecapLlmConfig))
      .toThrow(/unknown config key "extra"/)
    expect(() => resolveSessionRecapLlmConfig({ ...CONFIG, targetCharacters: 0 }))
      .toThrow(/targetCharacters must be a positive integer/)
    expect(() => resolveSessionRecapLlmConfig({ ...CONFIG, maxInputBytes: 1.5 }))
      .toThrow(/maxInputBytes must be a positive integer/)
    expect(() => resolveSessionRecapLlmConfig({ ...CONFIG, maxOutputTokens: -1 }))
      .toThrow(/maxOutputTokens must be a positive integer/)
    expect(() => resolveSessionRecapLlmConfig({ ...CONFIG, timeoutMs: 0 }))
      .toThrow(/timeoutMs must be a positive integer/)
    expect(() => resolveSessionRecapLlmConfig({ ...CONFIG, timeoutMs: MAX_TIMER_DELAY_MS + 1 }))
      .toThrow(/timeoutMs must not exceed/)
    expect(() => resolveSessionRecapLlmConfig({ ...CONFIG, provider: 'only-provider' }))
      .toThrow(/provider and model must be supplied together/)
    expect(() => resolveSessionRecapLlmConfig({ ...CONFIG, model: 'only-model' }))
      .toThrow(/provider and model must be supplied together/)
    expect(() => resolveSessionRecapLlmConfig({ ...CONFIG, provider: '', model: 'model' }))
      .toThrow(/overrides must be non-empty strings/)
    expect(() => resolveSessionRecapLlmConfig({ ...CONFIG, provider: 'provider', model: 1 } as never))
      .toThrow(/overrides must be non-empty strings/)
    expect(resolveSessionRecapLlmConfig(CONFIG)).toMatchObject(CONFIG)
  })
})

describe('selectSessionRecapDigest', () => {
  it('keeps the window head and adds tail entries while they fit', () => {
    const config = resolveSessionRecapLlmConfig(CONFIG)
    const full = entries(4)
    const digest = selectSessionRecapDigest(full, config)
    expect(digest.entries.map(entry => entry.seq)).toEqual([0, 1, 2, 3])
    expect(digest.framed).toContain('entry 3')

    const oneTail = resolveSessionRecapLlmConfig({ ...CONFIG, maxInputBytes: 200 })
    const trimmed = selectSessionRecapDigest(full, oneTail)
    expect(trimmed.entries[0]?.seq).toBe(0)
    expect(trimmed.entries.at(-1)?.seq).toBe(3)
    expect(trimmed.entries.length).toBeLessThan(full.length)
    expect(Buffer.byteLength(trimmed.framed, 'utf8')).toBeLessThanOrEqual(200)
  })

  it('requires one entry and rejects a window whose first entry alone exceeds the budget', () => {
    const config = resolveSessionRecapLlmConfig(CONFIG)
    expect(() => selectSessionRecapDigest([], config)).toThrow(/at least one digest entry/)
    const single = entries(1, 4_000)
    expect(() => selectSessionRecapDigest(single, config)).toThrow(/exceeding maxInputBytes/)
  })
})

describe('generateSessionRecapWithLlm', () => {
  it('uses the exact logged route, records the request before dispatch, and normalizes the text', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(LlmRuntime)
    const providerRequest = request(ctx)
    let requestWasLoggedAtDispatch = false
    const adapter = new RecordingAdapter(SCRIPT, () => {
      requestWasLoggedAtDispatch = providerRequest.session.snapshotEvents()
        .some(event => event.type === 'session/recap-llm-request')
    })
    ctx.llm.registerAdapter(['current-route'], adapter)

    const result = await generateSessionRecapWithLlm(
      ctx,
      resolveSessionRecapLlmConfig(CONFIG),
      providerRequest,
      RECAP_PROVIDER,
    )

    expect(result).toEqual({
      text: 'Wired the recap seam and the command',
      sourceSeqs: providerRequest.entries.map(entry => entry.seq),
      model: { provider: 'current-route', model: 'current-model' },
    })
    expect(requestWasLoggedAtDispatch).toBe(true)
    const options = adapter.requests[0]!
    expect(Object.isFrozen(options)).toBe(true)
    expect(isAgentLoopRequest(options)).toBe(false)
    expect(options).toMatchObject({
      provider: 'current-route',
      model: 'current-model',
      maxTokens: 64,
      sessionId: providerRequest.session.id,
      purpose: 'session-recap',
    })
    expect(options.system).toContain('120 characters')
    const loggedRequest = providerRequest.session.snapshotEvents()
      .findLast(event => event.type === 'session/recap-llm-request')?.data
    expect(loggedRequest).toMatchObject({
      recapProvider: RECAP_PROVIDER,
      sourceSeqs: providerRequest.entries.map(entry => entry.seq),
      route: { provider: 'current-route', model: 'current-model' },
      system: options.system,
      maxTokens: 64,
    })
    expect(loggedRequest?.prompt).toContain('entry 0')
    expect(loggedRequest?.prompt).toBe(
      (options.messages[0]?.content[0] as { type: 'text'; text: string }).text,
    )
  })

  it('uses paired explicit overrides and rejects a request with no route or a pre-aborted caller', async () => {
    const { ctx, adapter } = await withScript(SCRIPT)
    const explicit = resolveSessionRecapLlmConfig({ ...CONFIG, provider: 'current-route', model: 'explicit-model' })
    const routed = request(ctx)
    await generateSessionRecapWithLlm(ctx, explicit, routed, RECAP_PROVIDER)
    expect(adapter.requests[0]).toMatchObject({ provider: 'current-route', model: 'explicit-model' })

    const unrouted = request(ctx)
    const { route: _droppedRoute, ...withoutRoute } = unrouted
    await expect(generateSessionRecapWithLlm(
      ctx,
      resolveSessionRecapLlmConfig(CONFIG),
      withoutRoute,
      RECAP_PROVIDER,
    )).rejects.toThrow(/no logged request route/)

    const controller = new AbortController()
    controller.abort(new Error('caller stopped'))
    const aborted = request(ctx, entries(2), controller.signal)
    await expect(generateSessionRecapWithLlm(ctx, resolveSessionRecapLlmConfig(CONFIG), aborted, RECAP_PROVIDER))
      .rejects.toThrow('caller stopped')
  })

  it.each([
    [{ kind: 'error', failure: { message: 'provider failed', code: 'SERVER' } }, 'provider failed', 'SERVER'],
    [{ kind: 'aborted', failure: { message: 'provider aborted', code: 'ABORTED' } }, 'provider aborted', 'ABORTED'],
  ] satisfies Array<[FinishReason, string, string]>)('preserves %s terminal failure details', async (reason, message, code) => {
    const { ctx } = await withScript([{ type: 'finish', reason }])
    const providerRequest = request(ctx)
    await expect(generateSessionRecapWithLlm(
      ctx,
      resolveSessionRecapLlmConfig(CONFIG),
      providerRequest,
      RECAP_PROVIDER,
    )).rejects.toMatchObject({ message, code })
  })

  it.each([
    [{ kind: 'max-tokens' }, /reached maxOutputTokens/],
    [{ kind: 'tool-calls' }, /unexpectedly requested a tool/],
    [{ kind: 'future-finish' } as never, /unsupported finish reason "future-finish"/],
  ] satisfies Array<[FinishReason, RegExp]>)('rejects the terminal finish reason %s', async (reason, error) => {
    const { ctx } = await withScript([{ type: 'finish', reason }])
    const providerRequest = request(ctx)
    await expect(generateSessionRecapWithLlm(
      ctx,
      resolveSessionRecapLlmConfig(CONFIG),
      providerRequest,
      RECAP_PROVIDER,
    )).rejects.toThrow(error)
  })

  it('rejects tool-call blocks and a successful response with no text', async () => {
    const tool = await withScript([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: ToolCallId('recap-tool'), name: 'unexpected', argumentsDelta: '{}' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const toolRequest = request(tool.ctx)
    await expect(generateSessionRecapWithLlm(
      tool.ctx,
      resolveSessionRecapLlmConfig(CONFIG),
      toolRequest,
      RECAP_PROVIDER,
    )).rejects.toThrow(/output must contain text only/)

    const reasoning = await withScript([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'no final recap' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    const reasoningRequest = request(reasoning.ctx)
    await expect(generateSessionRecapWithLlm(
      reasoning.ctx,
      resolveSessionRecapLlmConfig(CONFIG),
      reasoningRequest,
      RECAP_PROVIDER,
    )).rejects.toThrow(/produced no text/)
  })

  it('aborts at the configured deadline and rejects a stream that finishes late', async () => {
    vi.useFakeTimers()
    try {
      const aborted = new Context()
      await aborted.plugin(SessionStore)
      await aborted.plugin(LlmRuntime)
      aborted.llm.registerAdapter(['current-route'], new CooperativeAdapter())
      const abortedRequest = request(aborted)
      const pendingAbort = generateSessionRecapWithLlm(
        aborted,
        resolveSessionRecapLlmConfig({ ...CONFIG, timeoutMs: 10 }),
        abortedRequest,
        RECAP_PROVIDER,
      )
      const rejectedAbort = expect(pendingAbort).rejects.toMatchObject({
        code: SESSION_RECAP_TIMEOUT_CODE,
        timeoutMs: 10,
      })
      await vi.advanceTimersByTimeAsync(10)
      await rejectedAbort

      const late = new Context()
      await late.plugin(SessionStore)
      await late.plugin(LlmRuntime)
      late.llm.registerAdapter(['current-route'], new DelayedSuccessAdapter(20))
      const lateRequest = request(late)
      const pendingLate = generateSessionRecapWithLlm(
        late,
        resolveSessionRecapLlmConfig({ ...CONFIG, timeoutMs: 10 }),
        lateRequest,
        RECAP_PROVIDER,
      )
      const rejectedLate = expect(pendingLate).rejects.toMatchObject({
        code: SESSION_RECAP_TIMEOUT_CODE,
        timeoutMs: 10,
      })
      await vi.advanceTimersByTimeAsync(20)
      await rejectedLate
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('registerSessionRecapLlmProvider', () => {
  it('registers a provider that the recap service accepts end to end', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionRecapService, CONFIG_SERVICE)
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['current-route'], new RecordingAdapter(SCRIPT))
    registerSessionRecapLlmProvider(ctx, { ...CONFIG, provider: 'current-route', model: 'recap-model' }, 'recap-llm-test')

    const session = ctx.sessions.create(SessionId('registered-recap'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Wire the recap provider' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    await expect(ctx.sessionRecap.generate(session)).resolves.toMatchObject({
      text: 'Wired the recap seam and the command',
      source: { kind: 'provider', provider: 'recap-llm-test', model: { provider: 'current-route', model: 'recap-model' } },
    })
    expect(session.snapshotEvents().some(event => event.type === 'session/recap-llm-request')).toBe(true)
  })
})
