# Agent Note: Session recap — a durable account of what happened while the user was away

Status: proposed

English | [中文](2026-10-07-session-recap.zh.md)

## Problem

A DSH session keeps working while its user is elsewhere. Turns complete, background jobs finish, subagents and workflows settle, and the transcript grows. When the user returns — to the session still open in the Web client, or to one resumed from the catalog — the only signals are a status dot and the scroll position, so reconstructing what happened costs a manual read whose length grows with the session.

Claude Code ships the terminal-scale version of this feature. Its session recap ([v2.1.114](https://code.claude.com/docs/en/whats-new/2026-w17), [`/recap`](https://code.claude.com/docs/en/interactive-mode)) shows one model-written line when the user switches back to an unattended terminal. It generates in the background after at least three minutes since the last completed turn while the terminal is unfocused, appears only once the session has at least three turns, never appears twice in a row, is capped at 400 characters, is on by default with a `/config` switch, never runs in non-interactive mode, and refuses a request that arrived from a relayed or automated prompt rather than the user's own input.

DSH owns every mechanism this needs but not the feature. [`dsh-session-title`](../../../packages/session/session-title/README.md) already runs an auxiliary model call over session history outside the agent loop, records the exact request, persists the accepted result as a log-only event, supersedes stale work, and exposes the value to clients through a session projection. `dsh-compaction` already summarizes history and renders the result as a transcript marker. Nothing produces a user-facing account of a completed stretch of work, and nothing schedules work at idle.

## Proposal

Add a session-recap capability family organized like the session-title family, plus one transcript row organized like the compaction marker.

### Event and seam

`@deepseek-ai/dsh-session-recap` defines `ctx.sessionRecap` and two log-only `SessionEventMap` members:

- `session/recap` — one accepted recap: the text, its source (`provider`, with the provider id and the model route used), the covered range (first and last covered surface seq, and the covered turn numbers), and the exact `user/message` and `assistant/message` seqs the generator was shown.
- `session/recap-llm-request` — the exact model-visible request recorded before one dispatch: route, system prompt, messages, output-token cap, and the source seqs, mirroring `session/title-llm-request`.

Neither event is a surface event and neither enters any model request; `SurfaceEventType` is not extended. The service owns acceptance: it verifies that a returned seq set comes from the request snapshot, normalizes the text, enforces the byte cap, and appends the event. `foldSessionRecap(events)` is the pure fold and `get(session)` returns the latest accepted snapshot. The service registers one client-visible `recap` projection unit carrying that snapshot, so catalog rows and cold sessions can read the latest recap without loading the window.

No deterministic fallback ships. A recap a program can compose from the log without a model is not a recap, and a turn counter is not an account of the work. A `/recap` with no registered provider reports that no recap generator is configured.

### Generation

`@deepseek-ai/dsh-session-recap-llm` holds the shared generation policy, mirroring [`dsh-session-title-llm`](../../../packages/session/session-title-llm/README.md): it validates config, measures the final JSON-framed prompt against `maxInputBytes` before logging or dispatch instead of truncating it, rechecks deadline and caller cancellation while consuming the stream and after it completes, rejects empty, malformed, or non-text output, and records the request before calling `ctx.llm.stream()`. Unless a `provider`/`model` pair overrides it, the route is the current session's logged `request/header` route.

The input is a bounded digest of the window since the last accepted recap rather than the whole history: human prompts in full, each turn's final assistant text, each tool call's name with a bounded result preview, and the completion notices of jobs, subagents, and workflows. The selector takes the tail-most events that fit `maxInputBytes` and always carries the window's first human prompt, so the digest is a deterministic function of the log and its cost is bounded by configuration rather than by session length. Output targets one line: `targetWords` for non-CJK text, `targetCjkCharacters` for CJK, capped by `maxBytes`.

### Trigger

`@deepseek-ai/dsh-session-recap-idle-llm` registers the provider and owns the automatic cadence. It arms a timer when a turn ends and clears it when a turn starts, then generates when the timer fires with the session idle (no running turn and no queued input), at least `minTurns` completed turns, and at least one completed turn since the last accepted recap. That last condition is the "never twice in a row" rule read from the log rather than kept as client state. Disposal clears the timer and aborts in-flight generation; a late completion cannot append over a newer one.

Explicit generation is `@deepseek-ai/dsh-command-recap`, a `/recap` command on `ctx.commands` that calls the service and reports the same expected failures `/compact` reports. Commands reach an agent only through the interactive adapter that invoked them, so a routine, webhook, scheduled prompt, or program-driven turn cannot request a recap, and the recap is deliberately not exposed as a model tool.

### Client presentation

`ui-chat` gains a `recap` conversation node and a `RecapItem` row following the compaction marker: the node definition derives from `session/recap` events, the renderer registers on `conversation.chat.node`, and a `/recap` command settlement folds into the row so one recap never renders twice. The row shows the generated sentence and the covered turn count, discloses the covered range, and takes every label from the locale dictionary.

The row is durable and sits after the turns it covers, rather than appearing as a transient overlay on return. DSH sessions are resumed from a catalog and several can run at once, so a row that survives reload, works for a session opened days later, and needs no client-local seen state is worth more than the transient form; position already carries the "this is what happened" reading.

### Persistence, routing, and cost

Both events are additive, log-only, and unneeded to replay or continue a session, so the implementation marks them with the envelope's `ignorable` flag where the append API exposes it; otherwise they follow the session-title precedent and ship required-on-read with the persistence-type change acknowledged. Either way the change regenerates the persistence catalog, updates the TypeScript and Python SDK expected outputs for the extended `SessionEventMap`, and adds an upgrade guide entry if older builds start refusing logs that contain a recap.

One automatic recap costs one bounded auxiliary call per idle period. The window is bounded, the output is short, generation supersedes rather than queues, and at least one completed turn must intervene, so a user who never returns pays one small call per idle stretch and nothing further.

### Packaging

| Package | Role | ctx key |
|---|---|---|
| `packages/session/session-recap` | durable recap state, acceptance, fold, projection | `ctx.sessionRecap` |
| `packages/session/session-recap-llm` | shared generation policy | — |
| `packages/session/session-recap-idle-llm` | idle-cadence provider over the shared policy | registers `ctx.sessionRecap` |
| `packages/session/command-recap` | on-demand `/recap` | registers on `ctx.commands` |
| `packages/client/ui-chat` | `recap` conversation node and row | `conversation.chat.node` |

The shipped `dsh` and `web` bundles mount the seam with explicit limits and the idle provider, so recap is on by default where a client can show it; `headless`, `sdk`, and `acp` profiles mount neither. Every limit is a validated `Config` field with no library default, in the pattern the session-title family already follows.

## Alternatives considered

**A transient overlay shown only on return.** This matches Claude Code's presentation, but it needs a client-local seen state, adds a new browser visibility path to the automatic trigger, and shows nothing for a session reopened from the catalog — the case DSH sessions make common. Reintroduce it if a durable row measurably clutters the transcript.

**Client-side generation on focus.** Cheaper to trigger, but it puts a model call on the critical path of the user's return (seconds of waiting after switching back), it cannot generate in the background at all, and the recap would exist only in one browser rather than in the session log. Rejected.

**Reuse `session/title`.** A title is a short label derived from human prompts for a list row; a recap accounts for assistant and tool work over a window and is read inside the session. Growing one service to hold both meanings merges two cadences, two length policies, and two review surfaces. Rejected.

**Reuse the compaction summary.** The compaction summary exists to replace history for the model, is sized in thousands of tokens, is coupled to surface replacement and prompt-cache accounting, and only exists after pressure. A recap is user-facing, short, never replaces anything, and must exist for sessions that never compact. Rejected.

**Expose the recap as a model tool.** The model could then request it, but the trust rule exists precisely so that automated or relayed input cannot produce one, and a model-visible recap would also enter the request prefix and its cache accounting. Rejected.

**A deterministic fallback recap.** Cheap, but it produces a turn counter rather than an account of the work, and a weak recap that always appears is worse than an honest absence. Rejected; `/recap` reports that no generator is configured.

**A projection unit only, with no session event.** The value could be folded host-side and shipped to clients without touching the log. But a recap must survive reload, be visible to detached readers, and be attributable to the exact input that produced it, all of which the log already provides. Rejected.

**Choosing the covered window by time rather than by the last recap.** Time-based windows need clock state in the log and produce overlaps and gaps; the since-last-recap window is exactly the question the user asks and is derivable from the log alone. Rejected.

Related work: [recallable compaction](2026-07-06-recallable-compaction.md) reorganizes what the model keeps, and its "amortized stub drafting at pre-step" follow-up is the model-side analogue of generating during idle. [Plugin-owned message projections](../../implemented/architecture/2026-09-11-plugin-owned-message-projections.md) governs content-changing events; a recap is log-only and needs no interpreter.

## Acceptance criteria

- A session that completes at least `minTurns` turns and then sits idle for `minIdleMs` gains exactly one `session/recap` event with the covered range and source seqs; a second idle period without an intervening completed turn adds none.
- `/recap` appends one accepted recap on demand, reports configured expected failures as human text, and leaves the log unchanged when no provider is registered.
- `session/recap-llm-request` reproduces the dispatched request, and a request that exceeds `maxInputBytes` is rejected rather than truncated; cancellation and deadline expiry fail without appending.
- The client renders exactly one row per accepted recap, with locale-owned labels, and folds the `/recap` settlement rather than doubling it.
- `foldSessionRecap` round-trips through replay; the `recap` projection equals the latest accepted snapshot; the persistence catalog, both SDK expected outputs, and the package READMEs (English and Chinese) are current.
- Per-file coverage is 100% on new source, disposal tests prove timer and listener removal, and a real-composition Loader test boots the idle provider and observes one appended recap.

## Risks

- **Recall of the wrong thing**: the digest may omit the detail the user cared about. The covered range and the request record make the omission inspectable after the fact, and the input selector is the single place to widen later.
- **Idle cost for unattended sessions**: a session left running by a routine keeps paying one small call per idle period. The output cap, the window bound, and one-call-per-idle-period bound the cost; if this proves wrong, gate the automatic cadence on a client being attached.
- **Durable-row noise**: an always-visible row changes the transcript for users who never wanted recaps. The config switch turns the feature off, and the transient-overlay alternative remains available.
- **Persistence-type growth**: two more event types widen the format, and a required-on-read choice would make older builds refuse recap-bearing logs; the upgrade-guide entry states that cost explicitly.
- **Trigger correctness under concurrency**: a timer that fires while a turn starts must not generate or append, and a superseded call must not land. Reusing the session-title supersession and cancellation pattern contains this, and the acceptance criteria pin it.
