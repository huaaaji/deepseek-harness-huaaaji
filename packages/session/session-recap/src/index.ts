/**
 * Log-backed session recap service: durable, user-facing accounts of what
 * happened over a window of completed work, plus the provider contract that
 * generates them.
 * @module @deepseek-ai/dsh-session-recap
 */

import { Context, FiberState, Service, type Fiber } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Branded } from '@deepseek-ai/dsh-brand'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionSeq } from '@deepseek-ai/dsh-session'
export type {
  SessionRecapEntry,
  SessionRecapEntryKind,
  SessionRecapEventData,
  SessionRecapModelIdentity,
  SessionRecapSnapshot,
  SessionRecapSource,
  SessionRecapTurnRange,
} from './types.ts'
import { normalizeRecapEntry, normalizeSessionRecap } from './normalize.ts'
import type {
  SessionRecapEntry,
  SessionRecapEventData,
  SessionRecapModelIdentity,
  SessionRecapSnapshot,
  SessionRecapSource,
  SessionRecapTurnRange,
} from './types.ts'

/** Identifies one session-recap provider registration. */
export type SessionRecapProviderId = Branded<'SessionRecapProviderId'>

/**
 * Brand a raw provider id.
 * @param id - stable non-empty provider identifier supplied by a plugin.
 * @returns the same string with the session-recap provider brand.
 */
export function SessionRecapProviderId(id: string): SessionRecapProviderId {
  return id as SessionRecapProviderId
}

export { normalizeRecapEntry, normalizeSessionRecap, truncateRecapUtf8 } from './normalize.ts'

/** Required accepted-text and digest-entry limits. */
export interface Config {
  /** Maximum UTF-8 bytes in any accepted recap text. */
  readonly maxBytes: number
  /** Maximum UTF-8 bytes in one digest entry. */
  readonly maxEntryBytes: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionRecap: SessionRecapService
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * One accepted recap of a completed stretch of work. Log-only: it never
     * enters the model surface or derived history.
     */
    'session/recap': SessionRecapEventData
  }
}

/** Expected failure classes of an explicit recap request. */
export type SessionRecapErrorCode =
  /** No provider is registered, or the registered one is disposing. */
  | 'unavailable'
  /** The covered window holds no digest entry, so there is nothing to recap. */
  | 'empty'
  /** The provider failed to produce an acceptable recap. */
  | 'generation'

/**
 * Expected recap-request failure. Callers translating the outcome onto a
 * human message narrow on {@link SessionRecapError.code}; cancellation stays
 * separate and throws the exact abort reason.
 */
export class SessionRecapError extends Error {
  override readonly name = 'SessionRecapError'

  /**
   * @param code - which expected failure class this is.
   * @param message - the provider-facing failure detail.
   */
  constructor(readonly code: SessionRecapErrorCode, message: string) {
    super(message)
  }
}

/** Immutable input supplied to one recap-provider call. */
export interface SessionRecapProviderRequest {
  /** Live session being recapped. */
  readonly session: Session
  /** Bounded digest entries of the covered window, in log order. */
  readonly entries: readonly SessionRecapEntry[]
  /** Turns the covered digest spans. */
  readonly turnRange: SessionRecapTurnRange
  /** Exact current logged main-request route, when one has been recorded. */
  readonly route?: SessionRecapModelIdentity
  /** Cancellation for supersession, disposal, or the explicit caller. */
  readonly signal: AbortSignal
}

/** Provider output before service-owned normalization and log acceptance. */
export interface SessionRecapProviderResult {
  /** Proposed recap text. */
  readonly text: string
  /** Exact seqs from `request.entries` used by this result. */
  readonly sourceSeqs: readonly SessionSeq[]
  /** Auxiliary LLM route, when generation used a model. */
  readonly model?: SessionRecapModelIdentity
}

/** One optional recap implementation registered with the service. */
export interface SessionRecapProvider {
  /** Stable id of the provider recorded with the recap. */
  readonly id: SessionRecapProviderId
  /**
   * Produce one recap revision.
   * @param request - digest entries, turn range, current route, session, and cancellation.
   * @returns proposed text plus exact source seqs and the optional model route used.
   */
  generate(request: SessionRecapProviderRequest): Promise<SessionRecapProviderResult>
}

/** Service-owned resolved limits. */
interface ResolvedConfig {
  readonly maxBytes: number
  readonly maxEntryBytes: number
}

/** One exact provider registration generation. */
interface ProviderRegistration {
  readonly provider: SessionRecapProvider
  readonly active: Set<Promise<unknown>>
  closing: boolean
}

/** Provider call currently allowed to commit for one session. */
interface ActiveGeneration {
  readonly registration: ProviderRegistration
  readonly revision: number
  readonly controller: AbortController
  readonly signal: AbortSignal
}

/** Mutable concurrency state scoped to one live session. */
interface SessionRecapWorkState {
  revision: number
  active?: ActiveGeneration
}

/** Validate one positive integer configuration field. */
function assertPositiveInteger(name: keyof Config, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`session-recap: ${name} must be a positive integer`)
  }
}

/** Defensive copy of a logged recap source (a snapshot must not alias log-owned objects). */
function copySessionRecapSource(source: SessionRecapSource): SessionRecapSource {
  return {
    kind: 'provider',
    provider: source.provider,
    ...(source.model === undefined ? {} : { model: { ...source.model } }),
  }
}

/**
 * Project one `session/recap` event into an immutable snapshot.
 * @param event - the logged recap event to project.
 * @returns the immutable snapshot.
 */
function recapSnapshotOf(event: SessionEvent<'session/recap'>): SessionRecapSnapshot {
  return deepFreeze({
    text: event.data.text,
    source: copySessionRecapSource(event.data.source),
    sourceSeqs: [...event.data.sourceSeqs],
    turnRange: { ...event.data.turnRange },
    eventSeq: event.seq,
    updatedAt: event.time,
  })
}

/** Join the text blocks of one message's content. */
function textOfContent(content: readonly { readonly type: string }[]): string {
  return content
    .filter((block): block is { readonly type: 'text'; readonly text: string } => block.type === 'text')
    .map(block => block.text)
    .join('\n')
}

/** Extract one eligible digest entry from a covered event. */
function recapEntryOf(
  event: SessionEvent,
  turn: number,
  toolNames: ReadonlyMap<string, string>,
  maxEntryBytes: number,
): SessionRecapEntry | undefined {
  switch (event.type) {
    case 'user/message': {
      const text = normalizeRecapEntry(textOfContent(event.data.content), maxEntryBytes)
      if (text.length === 0) return undefined
      return { seq: event.seq, kind: event.data.source.kind === 'user' ? 'user' : 'notice', turn, text }
    }
    case 'assistant/message': {
      const text = normalizeRecapEntry(textOfContent(event.data.message.content), maxEntryBytes)
      if (text.length === 0) return undefined
      return { seq: event.seq, kind: 'assistant', turn, text }
    }
    case 'tool/result': {
      const text = normalizeRecapEntry(textOfContent(event.data.message.content), maxEntryBytes)
      if (text.length === 0) return undefined
      const name = toolNames.get(event.data.message.toolCallId)
      return {
        seq: event.seq,
        kind: 'tool',
        turn,
        ...(name === undefined ? {} : { name }),
        text,
      }
    }
    default:
      return undefined
  }
}

/**
 * Collect the covered window into bounded digest entries, in log order.
 * @param events - the full session log.
 * @param afterSeq - exclusive lower bound; the accepted recap being extended.
 * @param maxEntryBytes - per-entry UTF-8 byte budget.
 * @returns eligible entries after `afterSeq` with the turns they span.
 */
function collectSessionRecapEntries(
  events: readonly SessionEvent[],
  afterSeq: SessionSeq | undefined,
  maxEntryBytes: number,
): { entries: SessionRecapEntry[]; turnRange: SessionRecapTurnRange } {
  const entries: SessionRecapEntry[] = []
  const toolNames = new Map<string, string>()
  let turn = 0
  let first = 0
  let last = 0
  for (const event of events) {
    if (event.type === 'turn/start') turn = event.data.turn
    if (event.type === 'tool/call') toolNames.set(event.data.callId, event.data.name)
    if (afterSeq !== undefined && event.seq <= afterSeq) continue
    const entry = recapEntryOf(event, turn, toolNames, maxEntryBytes)
    if (entry === undefined) continue
    first = entries.length === 0 ? entry.turn : Math.min(first, entry.turn)
    last = entries.length === 0 ? entry.turn : Math.max(last, entry.turn)
    entries.push(entry)
  }
  return { entries, turnRange: { first, last } }
}

/** Validate an optional provider-reported model route. */
function validateModel(candidate: unknown): SessionRecapModelIdentity | undefined {
  if (candidate === undefined) return undefined
  const record = candidate !== null && typeof candidate === 'object'
    ? candidate as Record<string, unknown>
    : undefined
  if (record === undefined
    || typeof record.provider !== 'string' || record.provider.length === 0
    || typeof record.model !== 'string' || record.model.length === 0) {
    throw new SessionRecapError(
      'generation',
      'session-recap provider result model must contain non-empty provider and model strings',
    )
  }
  return { provider: record.provider, model: record.model }
}

/**
 * Fold the latest accepted recap without consulting mutable metadata.
 * @param events - live or persisted session log.
 * @returns the latest immutable recap snapshot, or `undefined`.
 */
export function foldSessionRecap(events: readonly SessionEvent[]): SessionRecapSnapshot | undefined {
  const event = events.findLast((item): item is SessionEvent<'session/recap'> => item.type === 'session/recap')
  return event === undefined ? undefined : recapSnapshotOf(event)
}

/** Log-backed recap fold plus asynchronous provider generation. */
export class SessionRecapService extends Service {
  static inject = ['sessions']
  static Config: z<Config> = z.object({
    maxBytes: z.number().step(1).min(1).required(),
    maxEntryBytes: z.number().step(1).min(1).required(),
  })

  private readonly config: ResolvedConfig
  private readonly ownerFiber: Fiber
  private registration: ProviderRegistration | undefined
  private readonly work = new Map<Session, SessionRecapWorkState>()
  private readonly lifetime = new AbortController()
  private readonly inFlight = new Set<Promise<unknown>>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'sessionRecap')
    this.ownerFiber = ctx.fiber
    const candidate: unknown = config
    if (candidate === null || typeof candidate !== 'object') {
      throw new Error('session-recap: configuration is required')
    }
    const value = candidate as Config
    assertPositiveInteger('maxBytes', value.maxBytes)
    assertPositiveInteger('maxEntryBytes', value.maxEntryBytes)
    this.config = deepFreeze({ ...value })

    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('session-recap service disposed'))
      if (this.registration !== undefined) this.registration.closing = true
      this.registration = undefined
      for (const state of this.work.values()) {
        state.active?.controller.abort(new Error('session-recap service disposed'))
      }
      await this.drain(this.inFlight)
      this.work.clear()
    }, 'sessionRecap lifecycle')

    ctx.on('session/disposed', (session) => {
      this.work.get(session)?.active?.controller.abort(new Error('session disposed during recap generation'))
      this.work.delete(session)
    })
  }

  /**
   * Read the latest accepted recap from one live or replayed session.
   * @param session - session whose log is the recap source of truth.
   * @returns latest recap snapshot, or `undefined` before the first recap.
   */
  get(session: Session): SessionRecapSnapshot | undefined {
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    return foldSessionRecap(session.snapshotEvents())
  }

  /**
   * Generate and accept one recap of the window after the latest accepted
   * recap. A newer request supersedes an in-flight one, whose cancellation
   * stays separate from expected failures.
   * @param session - exact live session to recap.
   * @param signal - optional caller cancellation.
   * @returns the accepted recap snapshot.
   * @throws {SessionRecapError} with `unavailable` when no provider is registered or it is disposing, `empty` when
   * the window holds no digest entry, and `generation` when the provider produced nothing acceptable.
   * @throws {Error} when the session is not live or the service is disposed; an aborted request preserves its exact abort reason.
   */
  async generate(session: Session, signal?: AbortSignal): Promise<SessionRecapSnapshot> {
    signal?.throwIfAborted()
    this.assertServiceActive()
    if (this.ctx.sessions.get(session.id) !== session) {
      throw new Error(`session "${session.id}" is not live in this store`)
    }
    const registration = this.registration
    if (registration === undefined || registration.closing) {
      throw new SessionRecapError('unavailable', 'session-recap: no recap provider is registered')
    }
    // oxlint-disable-next-line typescript/no-deprecated -- Existing Session history read; migration deferred.
    const events = session.snapshotEvents()
    const { entries, turnRange } = collectSessionRecapEntries(
      events,
      foldSessionRecap(events)?.eventSeq,
      this.config.maxEntryBytes,
    )
    if (entries.length === 0) {
      throw new SessionRecapError('empty', 'session-recap: no new work to recap')
    }
    const header = session.requestHeader()?.config
    const route = header === undefined ? undefined : { provider: header.provider, model: header.model }
    const state = this.stateFor(session)
    const work = this.activate(registration, this.supersede(state), signal)
    state.active = work
    const run = Promise.resolve().then(async () => {
      try {
        this.assertCurrent(session, work)
        const result = await registration.provider.generate({
          session,
          entries,
          turnRange,
          ...route === undefined ? {} : { route },
          signal: work.signal,
        })
        this.assertCurrent(session, work)
        const accepted = this.validateResult(result, entries)
        session.append('session/recap', {
          text: accepted.text,
          source: {
            kind: 'provider',
            provider: registration.provider.id,
            ...accepted.model === undefined ? {} : { model: accepted.model },
          },
          sourceSeqs: [...accepted.sourceSeqs],
          turnRange,
        })
        const snapshot = this.get(session)
        /* v8 ignore next -- unreachable: the append above just committed a session/recap event. */
        if (snapshot === undefined) throw new Error('accepted recap failed to fold')
        return snapshot
      } catch (error: unknown) {
        if (error instanceof SessionRecapError) throw error
        if (work.signal.aborted) throw work.signal.reason
        throw new SessionRecapError('generation', `session-recap: ${String(error)}`)
      } finally {
        const current = this.work.get(session)
        if (current?.active === work) delete current.active
      }
    })
    return this.track(run, registration)
  }

  /**
   * Register the sole optional recap provider. Disposal aborts its in-flight
   * work before another provider may register.
   * @param provider - provider identity and generation function.
   * @returns exact Cordis effect disposer, which settles after active calls quiesce.
   */
  register(provider: SessionRecapProvider): () => Promise<void> {
    this.validateProvider(provider)
    if (this.registration !== undefined) {
      throw new Error(`session-recap provider "${this.registration.provider.id}" is already registered`)
    }
    const registration: ProviderRegistration = { provider, active: new Set(), closing: false }
    return this.ctx.effect(function* (this: SessionRecapService) {
      this.registration = registration
      yield async () => {
        registration.closing = true
        for (const state of this.work.values()) {
          if (state.active?.registration === registration) {
            state.active.controller.abort(new Error(`session-recap provider "${provider.id}" was disposed`))
          }
        }
        await this.drain(registration.active)
        this.registration = undefined
      }
    }.bind(this), 'sessionRecap.register()')
  }

  /** Validate and normalize provider output against the supplied digest. */
  private validateResult(result: unknown, entries: readonly SessionRecapEntry[]): SessionRecapProviderResult {
    if (result === null || typeof result !== 'object') {
      throw new SessionRecapError('generation', 'session-recap provider returned an invalid result')
    }
    const candidate = result as Record<string, unknown>
    if (typeof candidate.text !== 'string') {
      throw new SessionRecapError('generation', 'session-recap provider text must be a string')
    }
    const text = normalizeSessionRecap(candidate.text, this.config.maxBytes)
    if (text.length === 0) {
      throw new SessionRecapError('generation', 'session-recap provider returned empty text')
    }
    if (!Array.isArray(candidate.sourceSeqs) || candidate.sourceSeqs.length === 0) {
      throw new SessionRecapError('generation', 'session-recap provider must identify at least one source seq')
    }
    const order = new Map(entries.map((entry, index) => [entry.seq, index]))
    const sourceSeqs: SessionSeq[] = []
    let previous = -1
    for (const seq of candidate.sourceSeqs as unknown[]) {
      const index = typeof seq === 'number' && Number.isSafeInteger(seq) ? order.get(SessionSeq(seq)) : undefined
      if (index === undefined || index <= previous) {
        throw new SessionRecapError(
          'generation',
          'session-recap provider sourceSeqs must be unique, ordered seqs from the request',
        )
      }
      sourceSeqs.push(SessionSeq(seq as number))
      previous = index
    }
    const model = validateModel(candidate.model)
    return { text, sourceSeqs, ...(model === undefined ? {} : { model }) }
  }

  /** Fail a completion whose provider, revision, session, or signal is stale. */
  private assertCurrent(session: Session, work: ActiveGeneration): void {
    this.assertServiceActive()
    work.signal.throwIfAborted()
    const state = this.work.get(session)
    /* v8 ignore next -- every supported supersession and disposal aborts the work signal before changing this state. */
    if (this.registration !== work.registration || state?.active !== work) {
      throw new Error('session recap generation state changed without cancellation')
    }
  }

  /** Create one active generation from a fixed revision. */
  private activate(
    registration: ProviderRegistration,
    revision: number,
    upstream?: AbortSignal,
  ): ActiveGeneration {
    const controller = new AbortController()
    const signals = [controller.signal, this.lifetime.signal]
    if (upstream !== undefined) signals.push(upstream)
    return { registration, revision, controller, signal: AbortSignal.any(signals) }
  }

  /** Abort older active work and reserve the next session-local revision. */
  private supersede(state: SessionRecapWorkState): number {
    state.active?.controller.abort(new Error('newer recap request superseded older generation'))
    state.revision += 1
    return state.revision
  }

  /** Return mutable work state for one session. */
  private stateFor(session: Session): SessionRecapWorkState {
    let state = this.work.get(session)
    if (state === undefined) {
      state = { revision: 0 }
      this.work.set(session, state)
    }
    return state
  }

  /** Retain one promise until settlement for service and provider teardown. */
  private track<T>(run: Promise<T>, registration: ProviderRegistration): Promise<T> {
    this.inFlight.add(run)
    registration.active.add(run)
    const settled = (): void => {
      this.inFlight.delete(run)
      registration.active.delete(run)
    }
    void run.then(settled, settled)
    return run
  }

  /** Await every current and settling promise in one lifecycle registry. */
  private async drain(active: Set<Promise<unknown>>): Promise<void> {
    while (active.size > 0) await Promise.allSettled([...active])
  }

  /** Whether the owning plugin fiber can still start or commit recap work. */
  private serviceActive(): boolean {
    return !this.lifetime.signal.aborted
      && this.ownerFiber.uid !== null
      && this.ownerFiber.state === FiberState.ACTIVE
  }

  /** Reject work once the owning plugin fiber has begun unloading. */
  private assertServiceActive(): void {
    if (!this.serviceActive()) throw new Error('session-recap service disposed')
  }

  /** Reject malformed provider registrations before publishing an effect. */
  private validateProvider(provider: unknown): asserts provider is SessionRecapProvider {
    if (provider === null || typeof provider !== 'object') {
      throw new Error('session-recap provider must be an object')
    }
    const candidate = provider as Record<string, unknown>
    if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
      throw new Error('session-recap provider id must be a non-empty string')
    }
    if (typeof candidate.generate !== 'function') {
      throw new Error(`session-recap provider "${candidate.id}" requires generate()`)
    }
  }
}

export default SessionRecapService
