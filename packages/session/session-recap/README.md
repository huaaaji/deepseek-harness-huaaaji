---
description: "Durable, log-backed session recaps with bounded digest collection, a provider registry, and service-owned acceptance."
kind: "package-reference"
---

# @deepseek-ai/dsh-session-recap

English | [中文](README.zh.md)

## Summary

Use `dsh-session-recap` to give each session a durable, user-facing account of completed work without putting that account into model input. The service folds the latest accepted `session/recap` event from the log, collects the bounded digest window after it, and asks one registered provider to summarize that window. Accepted text, source seqs, turn range, and the provider and model route survive replay and resume. A newer request supersedes an in-flight one, disposal aborts and drains active work, and callers narrow expected failures by `SessionRecapError.code`.

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

Mount the service beside the session store, then register one provider plugin to generate recaps. Both limits are required positive integers; the library supplies no defaults.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-recap'
  config:
    maxBytes: 400
    maxEntryBytes: 120
```

| Field | Default | Meaning |
|---|---|---|
| `maxBytes` | required | Maximum UTF-8 bytes in any accepted recap text |
| `maxEntryBytes` | required | Maximum UTF-8 bytes in one collected digest entry |

The generated [configuration catalog](../../../docs/config-catalog.md) is the exhaustive source for every accepted field and its JSDoc.

### Registering a provider

`ctx.sessionRecap.register(provider)` accepts one implementation; a second live registration throws, and the returned effect disposer marks that registration closing, aborts its in-flight calls, waits for them to settle, and only then releases the slot. While a registration is closing, `generate()` reports `unavailable`. A provider exposes a stable non-empty `id` and an async `generate(request)`; the request carries the live session, the digest entries in log order, the covered turn range, the current logged main-request route when one exists, and the cancellation signal.

### Generating and reading recaps

`generate(session, signal?)` recaps only the window after the latest accepted recap. It collects the text of eligible `user/message`, `assistant/message`, and `tool/result` events after that event's seq, bounds each entry to `maxEntryBytes`, and passes the entries and their turn range to the provider. The service then normalizes the proposed text to `maxBytes`, requires non-empty text and unique ascending `sourceSeqs` drawn from the request, and appends the accepted `session/recap` event. `get(session)` and `foldSessionRecap(events)` read the latest accepted recap from a live or replayed log; `truncateRecapUtf8` bounds text without splitting a code point.

### Failures and recovery

`SessionRecapError` carries `unavailable` when no provider is registered or the registered one is disposing, `empty` when the covered window holds no eligible entry, and `generation` when the provider failed or returned an unacceptable result. Caller cancellation, supersession, session disposal, and service disposal rethrow the exact abort reason instead. A newer `generate()` aborts the older one, session disposal aborts that session's work, and service disposal aborts and drains all remaining work before unloading completes. The event is log-only, so it never changes model input and its fold is replay-stable.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the recap design; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

Recaps are durable, log-only state: every accepted revision is a `session/recap` event, and `foldSessionRecap()` selects the latest, so a recap survives replay, resume, and paging exactly like any other session event. The service owns digest collection, normalization, supersession, and acceptance; the provider owns generation.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Service, config, digest collector, provider registry, supersession, and acceptance |
| [`src/normalize.ts`](src/normalize.ts) | Terminal-safe single-line normalization and UTF-8 truncation for recap text and digest entries |
| [`src/types.ts`](src/types.ts) | Recap types and the `session/recap` event declaration |
| [`src/client.ts`](src/client.ts) | Client-namespace type re-export of `./types` |

### Lifecycle and concurrency

Per-session work state tracks a revision counter and the active generation. A new request aborts the active one with a supersession reason and reserves the next revision; each generation composes its signal from its own controller, the service lifetime, and the optional caller signal, and a completion whose provider, revision, session, or signal is stale cannot append. Provider disposal, session disposal, and service disposal each abort the work they own and drain it before releasing state.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the service contract is not enough. They move from the provider that plugs in here to the shared policy and bounded call it can build on.

- [Shared LLM recap policy](../session-recap-llm/README.md) — the model-backed policy a recap provider can reuse.
- [Idle recap provider](../session-recap-idle-llm/README.md) — the shipped provider that recaps after an idle delay.
- [Bounded auxiliary text call](../../llm/auxiliary-text-call/README.md) — the one-shot request helper the shared policy dispatches through.
- [Session package map](../README.md) — adjacent persistence, projection, title, and telemetry packages.
- [LLM streaming subsystem](../../../docs/subsystems/llm-streaming.md) — the request and stream vocabulary the auxiliary call uses.

-----

<a id="model-experience"></a>
## Model Experience

### Session recap state

#### What the model sees

Nothing. `session/recap` is log-only: the accepted text, source seqs, and turn range never enter the model surface, `deriveMessages()`, the system prompt, tool schemas, or a request prefix. A provider's separate auxiliary request is documented by the provider package.

#### Token effect

The service adds zero tokens to the main agent request. Digest collection and acceptance never dispatch to `ctx.llm`; a model-backed provider owns its own auxiliary request and its limits.

#### KV Cache effect

None for the main request; recap events do not change its reconstructed content or cache key.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what the recap service does not provide. They are current package constraints.

- **At most one provider** — the registry accepts a single implementation, so a deployment cannot compose competing recap strategies without writing one provider that owns their precedence.
- **Window recaps only, text only** — generation always covers the retained digest entries after the latest accepted recap, and the service accepts plain text; per-entry summaries, retrieval over older windows, and structured recap payloads are outside the service.
- **No projection unit** — the service exposes `get()` and `foldSessionRecap()` to callers instead of registering a `ctx.sessionProjections` unit, so a client that lists recaps owns its own read model.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
