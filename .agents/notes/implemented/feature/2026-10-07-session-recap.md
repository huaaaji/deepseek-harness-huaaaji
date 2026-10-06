# Agent Note: Session recap — a durable account of what happened while the user was away

Status: implemented

English | [中文](2026-10-07-session-recap.zh.md)

## Problem

A DSH session keeps working while its user is elsewhere. Turns complete, background jobs finish, subagents and workflows settle, and the transcript grows. When the user returns — to the session still open in the Web client, or to one resumed from the catalog — the only signals are a status dot and the scroll position, so reconstructing what happened costs a manual read whose length grows with the session.

Claude Code ships the terminal-scale version of this feature. Its session recap ([v2.1.114](https://code.claude.com/docs/en/whats-new/2026-w17), [`/recap`](https://code.claude.com/docs/en/interactive-mode)) shows one model-written line when the user switches back to an unattended terminal. It generates in the background once at least three minutes have passed since the last completed turn while the terminal is unfocused, appears only after at least three turns, never appears twice in a row, is capped at 400 characters, and refuses a request that arrived from a relayed or automated prompt rather than the user's own input.

DSH already owned every mechanism this needs but not the feature. [`dsh-session-title`](../../../../packages/session/session-title/README.md) ran an auxiliary model call over session history outside the agent loop, recorded the exact request, persisted the accepted result as a log-only event, and superseded stale work. `dsh-compaction` summarized history and rendered the result as a transcript marker. Nothing produced a user-facing account of a completed stretch of work, and nothing scheduled work at idle.

## Decision

A session-recap capability family organized like the session-title family, plus one durable transcript row organized like the compaction marker.

### Event and seam

`@deepseek-ai/dsh-session-recap` defines `ctx.sessionRecap` and the log-only `SessionEventMap` member `session/recap`: the normalized text, its `provider` source with the provider id and the model route used, the exact digest entry seqs the generator was shown, and the inclusive `SessionRecapTurnRange` those entries spanned. Neither the event nor anything it carries is a surface event; `SurfaceEventType` is not extended and no model request reads it.

The service owns acceptance. `generate(session, signal?)` covers the window after the latest accepted recap, collects it into a bounded digest, verifies every seq a provider returns came from that request, normalizes the text, enforces `maxBytes`, and only then appends. `foldSessionRecap(events)` is the pure fold and `get(session)` reads the latest accepted snapshot from a live or replayed session. A newer request supersedes an in-flight one, disposal aborts active work before a replacement provider may register, and expected failures are `SessionRecapError` values coded `unavailable`, `empty`, or `generation`; cancellation stays separate and throws the exact abort reason.

No deterministic fallback ships. A recap a program composes from the log without a model is not a recap, and a turn counter is not an account of the work.

### The covered digest

`collectSessionRecapEntries` reads the window after the latest `session/recap` event and emits one bounded `SessionRecapEntry` per eligible event, in log order: a human `user` prompt in full, an `assistant` message's text blocks, a `tool` result with its call's name when the log still holds it, and a `notice` for content another producer injected for the model. Entry text is sanitized to one display-safe line and bounded by `maxEntryBytes`. A window with no entry yields the `empty` failure, which makes a second recap without intervening work impossible for both the automatic and the explicit path.

### Generation

`@deepseek-ai/dsh-session-recap-llm` registers the model-backed provider. Its config carries `targetCharacters`, `maxInputBytes`, `maxOutputTokens`, `timeoutMs`, and an optional paired `provider`/`model` override; without the pair the call uses the session's logged `request/header` route.

`@deepseek-ai/dsh-auxiliary-text-call` owns the bounded one-shot call itself: it measures the framed input against `maxInputBytes` before recording or dispatching, applies the deadline and caller cancellation while consuming the stream and after it completes, maps terminal finish reasons, rejects tool-call blocks, and freezes the request it hands to `ctx.llm.stream()`. `@deepseek-ai/dsh-session-title-llm` delegates to the same helper, so the two auxiliary features share one request policy.

Digest selection keeps the window's first entry so the recap retains the prompt that started the window, then adds tail entries while they fit the input budget. The provider records `session/recap-llm-request` before dispatch with the provider identity, the digest seqs it represents, the route, the system prompt, the exact framed user prompt, and the output-token cap. The record pins what the model was asked even when generation later fails.

The auxiliary message uses the existing `user` message source, and the record stores the framed prompt text rather than a `Message[]`. Adding a `MessageSourceMap` variant would have changed the `MessageSource` union persisted inside four existing event roots and forced a Session writer-version bump for a recap that no model request reads.

### Trigger

`@deepseek-ai/dsh-session-recap-idle-llm` is a function plugin that registers the provider and owns the automatic cadence. It arms a timer when a `turn/end` reports `completed`, clears it on `turn/start` or session disposal, and generates when the timer fires with at least `minTurns` recorded turns. The service's `empty` and `unavailable` failures are silent; any other failure is logged as a warning. Disposal clears every timer.

Explicit generation is `@deepseek-ai/dsh-command-recap`, a `/recap` command on `ctx.commands` that reports the same expected failures as human text. Commands reach an agent only through the interactive adapter that invoked them, so a routine, webhook, scheduled prompt, or program-driven turn cannot request a recap, and the recap is deliberately not exposed as a model tool.

### Client presentation

`ui-chat` registers a `recap` conversation node and a `RecapItem` row following the compaction marker: one independent row per accepted `session/recap` event, keyed and anchored by its seq, showing the generated sentence with a disclosure for the covered turn range and the provider or provider-and-model route. Every label and separator is locale-owned; the recap text is model output. The row is durable and sits after the turns it covers rather than appearing as a transient overlay on return, so it survives reload, works for a session opened days later, and needs no client-local seen state.

### Trust, cost, and shared primitives

One automatic recap costs one bounded auxiliary call per idle period: the window is bounded by `maxInputBytes`, the output is short, generation supersedes rather than queues, and no second recap can cover an empty window. The shared call forces reasoning off for `session-recap` in the DeepSeek adapter, as it already did for `session-title`.

Two idioms this family would otherwise have copied were extracted instead of duplicated, and the duplication gate found no remaining clone: display-safe text sanitization and UTF-8 byte bounding moved to [`@deepseek-ai/dsh-display-text`](../../../../packages/util/display-text/README.md), which `dsh-session-title` and `dsh-session-recap` both use; and the drain-before-unregistration command lifecycle became [`registerDrainedCommand`](../../../../packages/interaction/commands/README.md), which `command-compact` and `command-recap` both call.

### Persistence and packaging

Both `session/recap` and `session/recap-llm-request` are additive log-only roots. They are required-on-read rather than `ignorable`, matching the `session/title` precedent, so a build that does not know them refuses a recap-bearing log; the change is recorded in [`docs/persistence-changes/2026-10-07-session-recap.md`](../../../../docs/persistence-changes/2026-10-07-session-recap.md) and needs no writer-version bump. The generated persistence catalog, config catalog, Cordis catalog, `known-event-types.ts`, and the persistence schema are regenerated.

The shipped `dsh` base mounts the recap service with explicit limits, and only the `web` bundle mounts the idle provider and the `/recap` command, so headless, SDK, and ACP profiles pay nothing and expose no command.

## Alternatives considered

**A transient overlay shown only on return.** This matches Claude Code's presentation, but it needs a client-local seen state, adds a browser visibility path to the automatic trigger, and shows nothing for a session reopened from the catalog — the case DSH sessions make common. Reintroduce it if a durable row measurably clutters the transcript.

**Client-side generation on focus.** Cheaper to trigger, but it puts a model call on the critical path of the user's return, cannot generate in the background at all, and would exist only in one browser rather than in the session log. Rejected.

**Reuse `session/title`.** A title is a short label derived from human prompts for a list row; a recap accounts for assistant and tool work over a window and is read inside the session. Growing one service to hold both meanings merges two cadences, two length policies, and two review surfaces. Rejected.

**Reuse the compaction summary.** The compaction summary exists to replace history for the model, is sized in thousands of tokens, is coupled to surface replacement and prompt-cache accounting, and only exists after pressure. A recap is user-facing, short, never replaces anything, and must exist for sessions that never compact. Rejected.

**Expose the recap as a model tool.** The model could then request one, but the trust rule exists precisely so that automated or relayed input cannot produce one, and a model-visible recap would also enter the request prefix and its cache accounting. Rejected.

**A deterministic fallback recap.** Cheap, but it produces a turn counter rather than an account of the work, and a weak recap that always appears is worse than an honest absence. Rejected; `/recap` reports that no generator is configured.

**A projection unit for cold sessions.** The first design registered a `recap` projection so catalog rows could read the latest recap without loading the window. No v1 consumer needs it — the transcript row derives from the event stream — so it was dropped rather than shipped speculative, and a consumer would justify it later.

**Choosing the covered window by time rather than by the last recap.** Time-based windows need clock state in the log and produce overlaps and gaps; the since-last-recap window is exactly the question the user asks and is derivable from the log alone. Rejected.

**Extending `MessageSourceMap` and bumping the Session writer version.** Rejected: a recap is invisible to every model request, so changing a persisted union used by four existing event roots would force a format version for no consumer-visible benefit.

Related work: [recallable compaction](../../proposed/feature/2026-07-06-recallable-compaction.md) reorganizes what the model keeps, and its amortized stub drafting is the model-side analogue of generating during idle. [Plugin-owned message projections](../architecture/2026-09-11-plugin-owned-message-projections.md) governs content-changing events; a recap is log-only and needs no interpreter.

## Consequences

- A user returning to a session gets one durable sentence covering the work they missed, and a `/recap` request produces the same artifact on demand.
- Two log-only event roots join the format. A build that predates them refuses a log containing a recap until it is upgraded, which is the accepted cost of following the `session/title` precedent rather than inventing an `ignorable` policy for a feature event.
- Automatic generation costs one small call per idle period in sessions that meet `minTurns` and add new work; profiles without a client surface mount neither provider nor command.
- The digest selector is the single place to widen coverage; it omits injected content whose text normalizes to nothing and bounds every entry, so a recap cannot be dominated by one tool result.
- The shared `dsh-display-text` and `dsh-auxiliary-text-call` packages and `registerDrainedCommand` now carry behavior that two features each needed, so a third annotation feature can reuse them rather than copy them again.
- Tests pin the seam at 100% per-file coverage, the idle cadence and cancellation through fake timers, the command's expected-failure mapping and real Loader composition, and the client row's single-turn, range, provider-only, and model-route renderings.

## Deferred

- A `recap` projection unit and a catalog-row or sidebar presentation, once a consumer exists.
- Folding a `/recap` settlement into the row it produced; the command settlement and the row currently both render, which the acceptance review should revisit if it proves noisy.
- Gating the automatic cadence on an attached but unfocused client, if unattended sessions prove to cost more than the current one-call-per-idle-period bound.
- Recording a keyless session snapshot that contains a `session/recap` event; no recorded fixture exercises the row in the assembled Web output yet.
