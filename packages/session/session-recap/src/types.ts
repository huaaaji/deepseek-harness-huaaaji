/**
 * Pure types of the recap domain: brands, the accepted-recap record, the
 * provider request and result, and the digest entry a provider summarizes.
 * Host-side value imports (cordis service, schemastery, the LLM seam) stay in
 * `./index.ts`; client aggregates import the `./client` projection of this
 * module.
 *
 * @module @deepseek-ai/dsh-session-recap/types
 */

export {}

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

/** Identifies one session-recap provider registration. */
export type SessionRecapProviderId = Branded<'SessionRecapProviderId'>

/** Exact auxiliary model route that produced a recap. */
export interface SessionRecapModelIdentity {
  /** Registered LLM provider route. */
  readonly provider: string
  /** Provider model id. */
  readonly model: string
}

/** Durable ownership record for an accepted recap. */
export interface SessionRecapSource {
  /** The registered provider that generated the text. */
  readonly kind: 'provider'
  /** Provider identity recorded with the recap. */
  readonly provider: SessionRecapProviderId
  /** Model route used for the generation call, when it used a model. */
  readonly model?: SessionRecapModelIdentity
}

/** Inclusive first and last completed turn covered by one recap, in order. */
export interface SessionRecapTurnRange {
  /** Lowest covered turn number. */
  readonly first: number
  /** Highest covered turn number. */
  readonly last: number
}

/** Payload of the log-only `session/recap` event. */
export interface SessionRecapEventData {
  /** Normalized non-empty recap text. */
  readonly text: string
  /** Which provider produced the text. */
  readonly source: SessionRecapSource
  /** Exact digest entry seqs the generator was shown, in log order. */
  readonly sourceSeqs: SessionSeq[]
  /** Turns whose events the digest covered. */
  readonly turnRange: SessionRecapTurnRange
}

/** Latest folded recap plus the recap event's durable envelope facts. */
export interface SessionRecapSnapshot extends SessionRecapEventData {
  /** Seq of the accepted `session/recap` event. */
  readonly eventSeq: SessionSeq
  /** Timestamp of the accepted `session/recap` event. */
  readonly updatedAt: number
}

/**
 * What one digest entry records: a human prompt, an assistant message's text,
 * a tool call's result, or content another producer injected for the model.
 */
export type SessionRecapEntryKind = 'user' | 'assistant' | 'tool' | 'notice'

/** One bounded digest entry exposed to recap providers. */
export interface SessionRecapEntry {
  /** Source event seq, unique within one digest. */
  readonly seq: SessionSeq
  /** What produced the entry. */
  readonly kind: SessionRecapEntryKind
  /** Turn the source event belongs to. */
  readonly turn: number
  /** Tool name for a `tool` entry, absent otherwise. */
  readonly name?: string
  /** Entry text, already bounded to the configured per-entry limit. */
  readonly text: string
}
