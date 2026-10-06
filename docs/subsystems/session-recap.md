# Session Recaps

English | [中文](session-recap.zh.md)

Durable recap state and the optional asynchronous provider vocabulary owned by [`@deepseek-ai/dsh-session-recap`](../../packages/session/session-recap). The shared model-request helper owns the exact auxiliary request record, and the idle-cadence provider owns automatic scheduling.

Sources: [`packages/session/session-recap/src/index.ts`](../../packages/session/session-recap/src/index.ts), [`packages/session/session-recap/src/types.ts`](../../packages/session/session-recap/src/types.ts)

## Durable recap state

`SessionRecapProviderId` identifies one provider registration, and `SessionRecapModelIdentity` names the exact provider route an auxiliary call used. `SessionRecapSource` records the registered provider that produced the text plus that route when generation used a model.

`session/recap` is log-only: it never enters the model surface or derived history, and `SurfaceEventType` is not extended. One accepted event carries the normalized text, its source, the exact digest entry seqs the generator was shown, and the inclusive `SessionRecapTurnRange` those entries spanned. `SessionRecapSnapshot` adds the event's seq and timestamp; `foldSessionRecap` is the pure fold over a log and `ctx.sessionRecap.get()` reads the latest accepted snapshot from a live or replayed session.

## The covered digest

`generate()` covers the window after the latest accepted `session/recap` event rather than the whole history. It collects that window into bounded `SessionRecapEntry` values in log order and reports `empty` when the window holds none, which makes a second recap without intervening work impossible.

Each entry names its source event seq, the turn it belongs to, and one `SessionRecapEntryKind`: a human `user` prompt, the text of an `assistant` message, a `tool` result with its call's name when the log still holds it, or a `notice` another producer injected for the model. Entry text is normalized to one display-safe line and bounded by the service's `maxEntryBytes`, and the accepted text is bounded by `maxBytes`.

## Auxiliary request record

A model-backed provider records `session/recap-llm-request` before dispatch: the provider identity, the exact digest seqs represented, the route, the system prompt, the exact framed user prompt, and the output-token cap. The record pins what the model was asked even when generation later fails, and the digest selection it represents is a deterministic function of the log and the configured input budget.

## Provider input and output

`ctx.sessionRecap` accepts one optional asynchronous provider. A `SessionRecapProviderRequest` supplies the live session, the covered digest, its turn range, the session's logged route when one exists, and cancellation for supersession or disposal. A provider returns proposed text, the exact seqs from the request it used, and the optional model route; the service verifies that every seq came from the request, normalizes the text, enforces the byte cap, and only then appends the event.

A newer request supersedes an in-flight one and disposal aborts active work before a replacement provider may register. Expected failures are `SessionRecapError` values with an `unavailable`, `empty`, or `generation` code; cancellation stays separate and throws the exact abort reason.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsessionrecap--sessionrecapservice"></a>

### `ctx.sessionRecap` — `SessionRecapService`

Log-backed recap fold plus asynchronous provider generation.

```ts cordis-catalog
/**
 * Read the latest accepted recap from one live or replayed session.
 * @param session - session whose log is the recap source of truth.
 * @returns latest recap snapshot, or `undefined` before the first recap.
 */
get(session: Session): SessionRecapSnapshot | undefined

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
async generate(session: Session, signal?: AbortSignal): Promise<SessionRecapSnapshot>

/**
 * Register the sole optional recap provider. Disposal aborts its in-flight
 * work before another provider may register.
 * @param provider - provider identity and generation function.
 * @returns exact Cordis effect disposer, which settles after active calls quiesce.
 */
register(provider: SessionRecapProvider): () => Promise<void>
```

Types: [Session](session.md)

Source: [`packages/session/session-recap/src/index.ts`](../../packages/session/session-recap/src/index.ts)
<!-- END GENERATED cordis-surface -->
