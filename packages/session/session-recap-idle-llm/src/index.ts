/**
 * Idle-cadence session recap: schedules one automatic recap after a completed
 * turn has left the session untouched for the configured idle delay.
 * @module @deepseek-ai/dsh-session-recap-idle-llm
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session } from '@deepseek-ai/dsh-session'
import { SessionRecapError } from '@deepseek-ai/dsh-session-recap'
import {
  registerSessionRecapLlmProvider,
  resolveSessionRecapLlmConfig,
  SessionRecapLlmConfigFields,
} from '@deepseek-ai/dsh-session-recap-llm'
import type { SessionRecapLlmConfig } from '@deepseek-ai/dsh-session-recap-llm'

export const name = 'session-recap-idle-llm'
export const inject = ['sessionRecap', 'llm', 'sessions']

/** Required idle cadence plus the shared generation policy. */
export interface Config extends SessionRecapLlmConfig {
  /** Idle delay after a completed turn before an automatic recap is generated. */
  readonly minIdleMs: number
  /** Completed turns a session must have before an automatic recap is generated. */
  readonly minTurns: number
}

/** Loader schema; every field is required and the library supplies no defaults. */
/* jscpd:ignore-start -- Loader requires each plugin to export its own statically walkable schema; the field validators remain shared. */
export const Config: z<Config> = z.object({
  minIdleMs: z.number().step(1).min(1).required(),
  minTurns: z.number().step(1).min(1).required(),
  targetCharacters: SessionRecapLlmConfigFields.targetCharacters,
  maxInputBytes: SessionRecapLlmConfigFields.maxInputBytes,
  maxOutputTokens: SessionRecapLlmConfigFields.maxOutputTokens,
  timeoutMs: SessionRecapLlmConfigFields.timeoutMs,
  provider: SessionRecapLlmConfigFields.provider,
  model: SessionRecapLlmConfigFields.model,
})
/* jscpd:ignore-end */

/** Complete configuration key set for direct construction validation. */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'minIdleMs',
  'minTurns',
  'targetCharacters',
  'maxInputBytes',
  'maxOutputTokens',
  'timeoutMs',
  'provider',
  'model',
])

/** Validate one positive integer cadence field. */
function assertCadence(name: 'minIdleMs' | 'minTurns', value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}

/** Completed turns recorded in one session log. */
function completedTurns(session: Session): number {
  // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
  return session.snapshotEvents().filter(event => event.type === 'turn/end').length
}

/**
 * Register the idle-cadence model provider and arm one timer per session.
 * @param ctx - context exposing the recap, LLM, and session services.
 * @param config - required idle cadence plus the shared generation policy.
 */
export function apply(ctx: Context, config: Config): void {
  const candidate: unknown = config
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error('session-recap-idle-llm: configuration is required')
  }
  for (const key of Object.keys(config)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`session-recap-idle-llm: unknown config key "${key}"`)
  }
  assertCadence('minIdleMs', config.minIdleMs)
  assertCadence('minTurns', config.minTurns)

  const generation: SessionRecapLlmConfig = {
    targetCharacters: config.targetCharacters,
    maxInputBytes: config.maxInputBytes,
    maxOutputTokens: config.maxOutputTokens,
    timeoutMs: config.timeoutMs,
    ...config.provider === undefined ? {} : { provider: config.provider },
    ...config.model === undefined ? {} : { model: config.model },
  }
  const resolved = resolveSessionRecapLlmConfig(generation)
  registerSessionRecapLlmProvider(ctx, resolved, name)

  const timers = new Map<Session, ReturnType<typeof setTimeout>>()
  const clear = (session: Session): void => {
    const timer = timers.get(session)
    if (timer === undefined) return
    clearTimeout(timer)
    timers.delete(session)
  }

  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') {
      clear(session)
      return
    }
    if (event.type !== 'turn/end') return
    clear(session)
    const reason = event.data.reason
    if (reason.kind !== 'completed') return
    const timer = setTimeout(() => {
      timers.delete(session)
      if (completedTurns(session) < config.minTurns) return
      void ctx.sessionRecap.generate(session).catch((error: unknown) => {
        if (error instanceof SessionRecapError && (error.code === 'empty' || error.code === 'unavailable')) return
        ctx.logger.warn(`session "${session.id}": automatic recap failed: ${String(error)}`)
      })
    }, config.minIdleMs)
    timers.set(session, timer)
  })

  ctx.on('session/disposed', (session) => {
    clear(session)
  })

  ctx.effect(() => () => {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
  }, 'session-recap-idle-llm timers')
}
