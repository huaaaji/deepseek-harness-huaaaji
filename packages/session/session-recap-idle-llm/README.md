---
description: "Idle-cadence session-recap provider that schedules one automatic recap after a completed turn has sat idle."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-recap-idle-llm

English | [中文](README.zh.md)

## Summary

Mount `dsh-session-recap-idle-llm` beside the recap service and the LLM runtime to recap a session automatically once a completed turn has sat idle for `minIdleMs`. The plugin registers the shared model-backed provider, arms one timer per session after a completed `turn/end`, cancels it when a new turn starts or the session is disposed, and generates only after the log holds at least `minTurns` completed turns. `empty` and `unavailable` outcomes stay silent; any other automatic failure warns and leaves the accepted recap unchanged, and disposal releases every pending timer.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when a session should summarize itself after the user walks away. It requires the complete [shared LLM configuration](../session-recap-llm/README.md#configuration) plus the idle cadence, with no defaults.

### When recaps are generated

Only a `turn/end` whose reason is `completed` arms the timer; `turn/start` and any other `turn/end` reason clear it without arming. When the timer fires, the plugin recaps only if the log holds at least `minTurns` completed turns, and otherwise stops without generating. Because the delay precedes generation, later activity cancels a pending recap before it starts, and each session keeps at most one pending timer.

### Configuration

Every field is required except the paired route override.

| Key | Default | Meaning |
|---|---|---|
| `minIdleMs` | required | Idle delay after a completed turn before an automatic recap |
| `minTurns` | required | Completed turns required before an automatic recap |
| `targetCharacters` | required | Target character count for the one-line recap |
| `maxInputBytes` | required | UTF-8 byte ceiling for the framed digest prompt |
| `maxOutputTokens` | required | Auxiliary generation token cap |
| `timeoutMs` | required | End-to-end deadline for the auxiliary call |
| `provider`, `model` | optional | Explicit route; supply both or neither, or omit both to use the session's logged route |

The generated [configuration catalog](../../../docs/config-catalog.md) is the exhaustive source for every accepted field and its JSDoc.

### Failures and recovery

`empty` (nothing new to recap) and `unavailable` (no available provider) stay silent, so an idle session with no new work is normal. Any other failure warns through the plugin logger and leaves the last accepted recap in place; the next completed turn can try again. Disposal of the plugin clears every pending timer without generating.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the plugin's shape; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

A thin function plugin: it validates the idle cadence, delegates the generation policy to the shared helper, and owns only the per-session scheduling that decides when to call the recap service.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin identity, config validation, timer scheduling, and provider registration |

### Scheduling

The plugin injects `sessionRecap`, `llm`, and `sessions`. Its `session/event` listener clears a pending timer on `turn/start` and arms one on a completed `turn/end`; when the timer fires it counts `turn/end` events for `minTurns` and calls `ctx.sessionRecap.generate(session)`. `session/disposed` clears that session's timer, and the plugin effect clears all remaining timers on disposal.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the plugin contract is not enough. They move from the service it drives to the policy and helper behind the request.

- [Session recap service](../session-recap/README.md) — the service that accepts the automatic recap.
- [Shared LLM recap policy](../session-recap-llm/README.md) — the generation policy this plugin registers.
- [Bounded auxiliary text call](../../llm/auxiliary-text-call/README.md) — the one-shot request helper the policy dispatches through.
- [Session package map](../README.md) — adjacent persistence, projection, title, and telemetry packages.

-----

<a id="model-experience"></a>
## Model Experience

### Automatic idle recap request

#### What the model sees

The plugin contributes nothing to a model request of its own; the recap it triggers reaches the model through the shared policy, which sends the configured system instruction and one JSON user message holding the selected digest entries.

#### Token effect

At most one auxiliary recap request is dispatched per idle period, after the timer fires and `minTurns` is satisfied, and its size is bounded by `maxInputBytes` and `maxOutputTokens`. The main agent request gains zero tokens, and the idle delay adds no latency to it.

#### KV Cache effect

None for the main request. The auxiliary request is independent, so its digests never change main-request prefix reuse.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when this provider stops recapping. They are current package constraints.

- **One pending recap per session** — a new completed turn replaces the pending timer and the plugin keeps no queue, so several quick completed turns produce at most one recap after the last one.
- **Turn count is the only gate** — `minTurns` counts every `turn/end` recorded with a `completed` reason, so the plugin has no notion of substantive work and will recap short completed turns too.
- **Idle time does not survive restart** — the delay is a process-local host timer, so a restarted session waits for another completed turn before it can recap automatically.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
