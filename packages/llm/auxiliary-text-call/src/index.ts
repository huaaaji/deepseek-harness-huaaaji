/**
 * One bounded, one-shot auxiliary text request over `ctx.llm.stream()`:
 * shared limits, route resolution, deadline, stream assembly, terminal-reason
 * mapping, and text-only validation for feature plugins that summarize or
 * label a session outside the agent loop.
 * @module @deepseek-ai/dsh-auxiliary-text-call
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type {
  FinishReason,
  GenerateOptions,
  Message,
  MessageSource,
} from '@deepseek-ai/dsh-llm'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { Session } from '@deepseek-ai/dsh-session'

/** Exact auxiliary model route one bounded request dispatches to. */
export interface AuxiliaryTextModelIdentity {
  /** Registered LLM provider route. */
  readonly provider: string
  /** Provider model id. */
  readonly model: string
}

/** Deployment-varying bounds every bounded auxiliary text request carries. */
export interface AuxiliaryTextLimits {
  /** Maximum UTF-8 bytes in the final framed user prompt. */
  readonly maxInputBytes: number
  /** Auxiliary generation output-token cap. */
  readonly maxOutputTokens: number
  /** End-to-end auxiliary request deadline in milliseconds. */
  readonly timeoutMs: number
  /** Optional explicit provider route; must be paired with `model`. */
  readonly provider?: string
  /** Optional explicit model id; must be paired with `provider`. */
  readonly model?: string
}

/**
 * Loader field schemas for the shared limits; each plugin composes them into
 * its own statically walkable schema.
 */
export const AuxiliaryTextLimitsFields = {
  maxInputBytes: z.number().step(1).min(1).required(),
  maxOutputTokens: z.number().step(1).min(1).required(),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).required(),
  provider: z.string(),
  model: z.string(),
}

/** Validate one positive integer limit. */
function assertPositiveInteger(label: string, name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label}: ${name} must be a positive integer`)
  }
}

/**
 * Validate the shared limits, including the paired route override.
 * @param label - feature label prefixed to every diagnostic.
 * @param limits - untrusted shared limits.
 * @throws {Error} when a limit is not a positive integer, the deadline exceeds the runtime timer
 * limit, or the route override is incomplete.
 */
export function assertAuxiliaryTextLimits(label: string, limits: AuxiliaryTextLimits): void {
  assertPositiveInteger(label, 'maxInputBytes', limits.maxInputBytes)
  assertPositiveInteger(label, 'maxOutputTokens', limits.maxOutputTokens)
  assertPositiveInteger(label, 'timeoutMs', limits.timeoutMs)
  if (limits.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`${label}: timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`)
  }
  if ((limits.provider === undefined) !== (limits.model === undefined)) {
    throw new Error(`${label}: provider and model must be supplied together`)
  }
  if (limits.provider !== undefined
    && (typeof limits.provider !== 'string' || limits.provider.length === 0
      || typeof limits.model !== 'string' || limits.model.length === 0)) {
    throw new Error(`${label}: provider and model overrides must be non-empty strings`)
  }
}

/**
 * Resolve the explicit route override or the supplied logged route.
 * @param label - feature label prefixed to every diagnostic.
 * @param limits - validated shared limits.
 * @param route - the session's logged main-request route, when one exists.
 * @returns the exact provider and model the request dispatches to.
 * @throws {Error} when neither an override pair nor a logged route is available.
 */
export function resolveAuxiliaryTextRoute(
  label: string,
  limits: AuxiliaryTextLimits,
  route?: AuxiliaryTextModelIdentity,
): AuxiliaryTextModelIdentity {
  if (limits.provider !== undefined && limits.model !== undefined) {
    return { provider: limits.provider, model: limits.model }
  }
  if (route === undefined) {
    throw new Error(`${label}: no logged request route is available; configure provider and model together`)
  }
  return route
}

/** Accepted input for one bounded auxiliary text request. */
export interface AuxiliaryTextCallOptions {
  /** Feature label prefixed to every diagnostic, such as `session-title-llm`. */
  readonly label: string
  /** Live session the request belongs to and whose log records it. */
  readonly session: Session
  /** Exact auxiliary route. */
  readonly route: AuxiliaryTextModelIdentity
  /** Exact auxiliary system prompt. */
  readonly system: string
  /** Final user prompt text, measured against `maxInputBytes` before dispatch. */
  readonly framedInput: string
  /** UTF-8 byte ceiling for `framedInput`. */
  readonly maxInputBytes: number
  /** Output-token cap. */
  readonly maxTokens: number
  /** End-to-end deadline. */
  readonly timeoutMs: number
  /** Abort reason code recorded when the deadline expires. */
  readonly timeoutCode: string
  /** Provider-neutral purpose stamped on the request. */
  readonly purpose: 'session-title' | 'session-recap'
  /** Producer source recorded on the auxiliary user message. */
  readonly source: MessageSource
  /** Cancellation from supersession, disposal, or the explicit caller. */
  readonly signal: AbortSignal
  /**
   * Record the exact request durably after measurement and before dispatch.
   * @param request - the exact system prompt, messages, and output cap being dispatched.
   */
  readonly record: (request: { system: string; messages: Message[]; maxTokens: number }) => void
}

/**
 * Translate terminal finish reasons into an auxiliary-call failure.
 * @param label - feature label prefixed to every diagnostic.
 * @param finish - the terminal reason the assembler reported.
 * @returns the failure to raise, or `undefined` for a normal stop.
 */
function finishError(label: string, finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens':
      return new Error(`${label}: output reached maxOutputTokens`)
    case 'tool-calls':
      return new Error(`${label}: the model unexpectedly requested a tool`)
    default:
      return new Error(`${label}: unsupported finish reason "${String((finish as { kind?: unknown }).kind)}"`)
  }
}

/**
 * Run one bounded auxiliary text request and return its text content.
 * The framed input is measured against the byte ceiling before the request is
 * recorded or dispatched, cancellation is rechecked while consuming the
 * stream and after it completes, and only a `stop` finish with text blocks is
 * accepted.
 * @param ctx - context exposing the registered LLM service.
 * @param options - request identity, exact input, limits, cancellation, and the durable record callback.
 * @returns the concatenated text blocks of the accepted response.
 * @throws {Error} when the input exceeds its byte ceiling, the deadline or caller cancels, the
 * provider reports a terminal failure, the response carries a tool call, or it contains no text.
 */
export async function runAuxiliaryTextCall(
  ctx: Context,
  options: AuxiliaryTextCallOptions,
): Promise<string> {
  options.signal.throwIfAborted()
  const inputBytes = Buffer.byteLength(options.framedInput, 'utf8')
  if (inputBytes > options.maxInputBytes) {
    throw new Error(
      `${options.label}: input is ${inputBytes} bytes, exceeding maxInputBytes ${options.maxInputBytes}`,
    )
  }
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: options.framedInput }],
    source: options.source,
  })]
  using callDeadline = deadline(options.signal, options.timeoutMs, options.timeoutCode)
  const generateOptions: GenerateOptions = deepFreeze({
    provider: options.route.provider,
    model: options.route.model,
    messages,
    system: options.system,
    maxTokens: options.maxTokens,
    sessionId: options.session.id,
    purpose: options.purpose,
    signal: callDeadline.signal,
  })
  options.record({ system: options.system, messages, maxTokens: options.maxTokens })
  callDeadline.signal.throwIfAborted()
  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(generateOptions)) {
    callDeadline.signal.throwIfAborted()
    assembler.push(chunk)
  }
  callDeadline.signal.throwIfAborted()
  const terminalError = finishError(options.label, assembler.finish)
  if (terminalError !== undefined) throw terminalError
  const blocks = assembler.blocks()
  if (blocks.some(block => block.type === 'tool-call')) {
    throw new Error(`${options.label}: output must contain text only`)
  }
  return blocks
    .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join(' ')
}
