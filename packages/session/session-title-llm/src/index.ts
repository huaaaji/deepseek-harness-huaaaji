/**
 * Shared route, framing, timeout, assembly, and validation policy for
 * model-backed session-title providers.
 * @module @deepseek-ai/dsh-session-title-llm
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-session-title-llm': { kind: 'dsh-session-title-llm' } & ContextFormed
  }
}

import type { Message } from '@deepseek-ai/dsh-llm'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import {
  assertAuxiliaryTextLimits,
  AuxiliaryTextLimitsFields,
  resolveAuxiliaryTextRoute,
  runAuxiliaryTextCall,
} from '@deepseek-ai/dsh-auxiliary-text-call'
import type { AuxiliaryTextLimits, AuxiliaryTextModelIdentity } from '@deepseek-ai/dsh-auxiliary-text-call'
import {
  normalizeSessionTitle,
  SessionTitleProviderId,
} from '@deepseek-ai/dsh-session-title'
import type {
  SessionTitleAutomaticMode,
  SessionTitleProviderRequest,
  SessionTitleProviderResult,
  SessionTitleUserMessage,
} from '@deepseek-ai/dsh-session-title'

/** Feature label prefixed to every diagnostic this policy raises. */
const LABEL = 'session-title-llm'

/** Exact model-visible request recorded before one auxiliary title dispatch. */
export interface SessionTitleLlmRequestEventData {
  /** Registered title-provider identity responsible for the request. */
  readonly titleProvider: SessionTitleProviderId
  /** Exact human `user/message` seqs represented in `messages`. */
  readonly messageSeqs: SessionSeq[]
  /** Exact auxiliary LLM route. */
  readonly route: AuxiliaryTextModelIdentity
  /** Exact auxiliary system prompt. */
  readonly system: string
  /** Exact auxiliary message list. */
  readonly messages: Message[]
  /** Exact auxiliary output-token cap. */
  readonly maxTokens: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only pre-dispatch record of one session-title model request. */
    'session/title-llm-request': SessionTitleLlmRequestEventData
  }
}

/** Capability-owned timeout reason code for auxiliary title requests. */
export const SESSION_TITLE_TIMEOUT_CODE = 'SESSION_TITLE_TIMEOUT'

/** Required deployment policy for one model-backed title plugin. */
export interface SessionTitleLlmConfig extends AuxiliaryTextLimits {
  /** Target word count for non-CJK titles. */
  readonly targetWords: number
  /** Target character count for Chinese, Japanese, or Korean titles. */
  readonly targetCjkCharacters: number
}

/** Validated immutable model-provider policy. */
export interface ResolvedSessionTitleLlmConfig extends SessionTitleLlmConfig {}

/** Shared Loader field schemas with no library defaults. */
export const SessionTitleLlmConfigFields = {
  targetWords: z.number().step(1).min(1).required(),
  targetCjkCharacters: z.number().step(1).min(1).required(),
  maxInputBytes: AuxiliaryTextLimitsFields.maxInputBytes,
  maxOutputTokens: AuxiliaryTextLimitsFields.maxOutputTokens,
  timeoutMs: AuxiliaryTextLimitsFields.timeoutMs,
  provider: AuxiliaryTextLimitsFields.provider,
  model: AuxiliaryTextLimitsFields.model,
}

/** Shared Loader schema with no library defaults. */
export const SessionTitleLlmConfigSchema: z<SessionTitleLlmConfig> = z.object(SessionTitleLlmConfigFields)

/** Complete configuration key set for direct construction validation. */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'targetWords',
  'targetCjkCharacters',
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
export function resolveSessionTitleLlmConfig(
  config: SessionTitleLlmConfig,
): ResolvedSessionTitleLlmConfig {
  const candidate: unknown = config
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error('session-title-llm: configuration is required')
  }
  const value = candidate as SessionTitleLlmConfig
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`session-title-llm: unknown config key "${key}"`)
  }
  if (!Number.isInteger(value.targetWords) || value.targetWords <= 0) {
    throw new Error('session-title-llm: targetWords must be a positive integer')
  }
  if (!Number.isInteger(value.targetCjkCharacters) || value.targetCjkCharacters <= 0) {
    throw new Error('session-title-llm: targetCjkCharacters must be a positive integer')
  }
  assertAuxiliaryTextLimits(LABEL, value)
  return deepFreeze({ ...value })
}

/** Select the provider-owned message subset from one fixed service revision. */
export type SessionTitleLlmMessageSelector = (
  messages: readonly SessionTitleUserMessage[],
) => readonly SessionTitleUserMessage[]

/**
 * Register one model-backed provider through the shared configuration and call policy.
 * @param ctx - context exposing the title and LLM services.
 * @param config - untrusted required deployment policy.
 * @param id - stable plugin id recorded with generated titles.
 * @param automatic - provider-owned automatic generation cadence.
 * @param selectMessages - exact source-message selection for one revision.
 */
export function registerSessionTitleLlmProvider(
  ctx: Context,
  config: SessionTitleLlmConfig,
  id: string,
  automatic: SessionTitleAutomaticMode,
  selectMessages: SessionTitleLlmMessageSelector,
): void {
  const resolved = resolveSessionTitleLlmConfig(config)
  const titleProvider = SessionTitleProviderId(id)
  ctx.sessionTitle.register({
    id: titleProvider,
    automatic,
    async generate(request) {
      return generateSessionTitleWithLlm(ctx, resolved, request, selectMessages(request.messages), titleProvider)
    },
  })
}

/** Stable language-aware system instruction shared by both provider plugins. */
function systemPrompt(config: ResolvedSessionTitleLlmConfig): string {
  return [
    'Create a concise title for an AI coding-assistant session from the supplied human messages.',
    'Return only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
    'Use the language of the messages.',
    `Aim for about ${config.targetWords} words in non-CJK languages or ${config.targetCjkCharacters} CJK characters.`,
  ].join('\n')
}

/** Frame exact messages as JSON so user text cannot break structural delimiters. */
function frameMessages(messages: readonly SessionTitleUserMessage[]): string {
  return `Generate the session title from this JSON array of human messages:\n${JSON.stringify(messages)}`
}

/**
 * Generate one title through the shared auxiliary LLM call.
 * @param ctx - context exposing the registered LLM service.
 * @param config - validated model-provider policy.
 * @param request - service-owned session, route, message snapshot, and cancellation.
 * @param selectedMessages - exact provider-selected subset to frame and attribute.
 * @param titleProvider - registered title-provider identity recorded with the request.
 * @returns normalized non-empty title, exact source seqs, and used model route.
 */
export async function generateSessionTitleWithLlm(
  ctx: Context,
  config: ResolvedSessionTitleLlmConfig,
  request: SessionTitleProviderRequest,
  selectedMessages: readonly SessionTitleUserMessage[],
  titleProvider: SessionTitleProviderId,
): Promise<SessionTitleProviderResult> {
  request.signal.throwIfAborted()
  if (selectedMessages.length === 0) {
    throw new Error('session-title-llm: at least one source message is required')
  }
  const framedInput = frameMessages(selectedMessages)
  const route = resolveAuxiliaryTextRoute(LABEL, config, request.route)
  const messageSeqs = selectedMessages.map(message => message.seq)
  const text = await runAuxiliaryTextCall(ctx, {
    label: LABEL,
    session: request.session,
    route,
    system: systemPrompt(config),
    framedInput,
    maxInputBytes: config.maxInputBytes,
    maxTokens: config.maxOutputTokens,
    timeoutMs: config.timeoutMs,
    timeoutCode: SESSION_TITLE_TIMEOUT_CODE,
    purpose: 'session-title',
    source: { kind: 'dsh-session-title-llm' },
    signal: request.signal,
    record: ({ system, messages, maxTokens }) => {
      request.session.append('session/title-llm-request', {
        titleProvider,
        messageSeqs,
        route,
        system,
        messages,
        maxTokens,
      })
    },
  })
  const title = normalizeSessionTitle(text, Number.MAX_SAFE_INTEGER)
  if (title.length === 0) throw new Error('session-title-llm: title model produced no text')
  return { title, messageSeqs, model: route }
}
