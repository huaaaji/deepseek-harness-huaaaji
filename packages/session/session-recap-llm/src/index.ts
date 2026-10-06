/**
 * Shared route, framing, timeout, assembly, and validation policy for
 * model-backed session-recap providers.
 * @module @deepseek-ai/dsh-session-recap-llm
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import {
  assertAuxiliaryTextLimits,
  AuxiliaryTextLimitsFields,
  resolveAuxiliaryTextRoute,
  runAuxiliaryTextCall,
} from '@deepseek-ai/dsh-auxiliary-text-call'
import type { AuxiliaryTextLimits, AuxiliaryTextModelIdentity } from '@deepseek-ai/dsh-auxiliary-text-call'
import { normalizeSessionRecap, SessionRecapProviderId } from '@deepseek-ai/dsh-session-recap'
import type {
  SessionRecapEntry,
  SessionRecapProviderRequest,
  SessionRecapProviderResult,
} from '@deepseek-ai/dsh-session-recap'

/** Feature label prefixed to every diagnostic this policy raises. */
const LABEL = 'session-recap-llm'

/** Exact model-visible request recorded before one auxiliary recap dispatch. */
export interface SessionRecapLlmRequestEventData {
  /** Registered recap-provider identity responsible for the request. */
  readonly recapProvider: SessionRecapProviderId
  /** Exact digest entry seqs represented in `messages`. */
  readonly sourceSeqs: SessionSeq[]
  /** Exact auxiliary LLM route. */
  readonly route: AuxiliaryTextModelIdentity
  /** Exact auxiliary system prompt. */
  readonly system: string
  /** Exact framed user prompt dispatched to the model. */
  readonly prompt: string
  /** Exact auxiliary output-token cap. */
  readonly maxTokens: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only pre-dispatch record of one session-recap model request. */
    'session/recap-llm-request': SessionRecapLlmRequestEventData
  }
}

/** Capability-owned timeout reason code for auxiliary recap requests. */
export const SESSION_RECAP_TIMEOUT_CODE = 'SESSION_RECAP_TIMEOUT'

/** Required deployment policy for one model-backed recap plugin. */
export interface SessionRecapLlmConfig extends AuxiliaryTextLimits {
  /** Target character count for the one-line recap. */
  readonly targetCharacters: number
}

/** Validated immutable model-provider policy. */
export interface ResolvedSessionRecapLlmConfig extends SessionRecapLlmConfig {}

/** Shared Loader field schemas with no library defaults. */
export const SessionRecapLlmConfigFields = {
  targetCharacters: z.number().step(1).min(1).required(),
  maxInputBytes: AuxiliaryTextLimitsFields.maxInputBytes,
  maxOutputTokens: AuxiliaryTextLimitsFields.maxOutputTokens,
  timeoutMs: AuxiliaryTextLimitsFields.timeoutMs,
  provider: AuxiliaryTextLimitsFields.provider,
  model: AuxiliaryTextLimitsFields.model,
}

/** Shared Loader schema with no library defaults. */
export const SessionRecapLlmConfigSchema: z<SessionRecapLlmConfig> = z.object(SessionRecapLlmConfigFields)

/** Complete configuration key set for direct construction validation. */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'targetCharacters',
  'maxInputBytes',
  'maxOutputTokens',
  'timeoutMs',
  'provider',
  'model',
])

/**
 * Validate and detach required model-provider configuration.
 * @param config - untrusted plugin configuration.
 * @returns immutable policy with optional route absence preserved.
 */
export function resolveSessionRecapLlmConfig(config: SessionRecapLlmConfig): ResolvedSessionRecapLlmConfig {
  const candidate: unknown = config
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error('session-recap-llm: configuration is required')
  }
  const value = candidate as SessionRecapLlmConfig
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`session-recap-llm: unknown config key "${key}"`)
  }
  if (!Number.isInteger(value.targetCharacters) || value.targetCharacters <= 0) {
    throw new Error('session-recap-llm: targetCharacters must be a positive integer')
  }
  assertAuxiliaryTextLimits(LABEL, value)
  return deepFreeze({ ...value })
}

/**
 * Register one model-backed provider through the shared configuration and call policy.
 * @param ctx - context exposing the recap and LLM services.
 * @param config - untrusted required deployment policy.
 * @param id - stable plugin id recorded with generated recaps.
 */
export function registerSessionRecapLlmProvider(
  ctx: Context,
  config: SessionRecapLlmConfig,
  id: string,
): void {
  const resolved = resolveSessionRecapLlmConfig(config)
  const provider = SessionRecapProviderId(id)
  ctx.sessionRecap.register({
    id: provider,
    async generate(request) {
      return generateSessionRecapWithLlm(ctx, resolved, request, provider)
    },
  })
}

/** Stable one-line instruction for the covered window. */
function systemPrompt(config: ResolvedSessionRecapLlmConfig): string {
  return [
    'Summarize what happened in this window of an AI coding-assistant session, for the user who was away.',
    'Return only the summary on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
    'Use the language of the entries and report the work that was done, not the process of reading it.',
    `Aim for about ${config.targetCharacters} characters.`,
  ].join('\n')
}

/** Frame exact entries as JSON so entry text cannot break structural delimiters. */
function frameEntries(entries: readonly SessionRecapEntry[]): string {
  return `Summarize this session window:\n${JSON.stringify(entries.map(entry => ({
    seq: entry.seq,
    turn: entry.turn,
    kind: entry.kind,
    ...(entry.name === undefined ? {} : { name: entry.name }),
    text: entry.text,
  })))}`
}

/**
 * Select the digest entries one request can carry within its byte budget.
 * The window's first entry always contributes, so the recap keeps the prompt
 * that started the window; later entries join from the tail while they fit.
 * @param entries - the covered window in log order.
 * @param config - validated policy carrying the input budget.
 * @returns the framed prompt and the entries it represents.
 */
export function selectSessionRecapDigest(
  entries: readonly SessionRecapEntry[],
  config: ResolvedSessionRecapLlmConfig,
): { framed: string; entries: SessionRecapEntry[] } {
  const head = entries[0]
  if (head === undefined) throw new Error('session-recap-llm: at least one digest entry is required')
  const selected: SessionRecapEntry[] = [head]
  for (let index = entries.length - 1; index >= 1; index -= 1) {
    const entry = entries[index]
    if (entry === undefined) break
    selected.push(entry)
    if (Buffer.byteLength(frameEntries(selected), 'utf8') > config.maxInputBytes) {
      selected.pop()
      break
    }
  }
  selected.sort((left, right) => left.seq - right.seq)
  const framed = frameEntries(selected)
  const inputBytes = Buffer.byteLength(framed, 'utf8')
  if (inputBytes > config.maxInputBytes) {
    throw new Error(`session-recap-llm: input is ${inputBytes} bytes, exceeding maxInputBytes ${config.maxInputBytes}`)
  }
  return { framed, entries: selected }
}

/**
 * Generate one recap through the shared auxiliary LLM call.
 * @param ctx - context exposing the registered LLM service.
 * @param config - validated model-provider policy.
 * @param request - service-owned session, route, digest snapshot, and cancellation.
 * @param recapProvider - registered recap-provider identity recorded with the request.
 * @returns normalized non-empty recap text, exact source seqs, and used model route.
 */
export async function generateSessionRecapWithLlm(
  ctx: Context,
  config: ResolvedSessionRecapLlmConfig,
  request: SessionRecapProviderRequest,
  recapProvider: SessionRecapProviderId,
): Promise<SessionRecapProviderResult> {
  request.signal.throwIfAborted()
  const digest = selectSessionRecapDigest(request.entries, config)
  const route = resolveAuxiliaryTextRoute(LABEL, config, request.route)
  const sourceSeqs = digest.entries.map(entry => entry.seq)
  const text = await runAuxiliaryTextCall(ctx, {
    label: LABEL,
    session: request.session,
    route,
    system: systemPrompt(config),
    framedInput: digest.framed,
    maxInputBytes: config.maxInputBytes,
    maxTokens: config.maxOutputTokens,
    timeoutMs: config.timeoutMs,
    timeoutCode: SESSION_RECAP_TIMEOUT_CODE,
    purpose: 'session-recap',
    source: { kind: 'user' },
    signal: request.signal,
    record: ({ system, maxTokens }) => {
      request.session.append('session/recap-llm-request', {
        recapProvider,
        sourceSeqs,
        route,
        system,
        prompt: digest.framed,
        maxTokens,
      })
    },
  })
  const recap = normalizeSessionRecap(text, Number.MAX_SAFE_INTEGER)
  if (recap.length === 0) throw new Error('session-recap-llm: recap model produced no text')
  return { text: recap, sourceSeqs, model: route }
}
