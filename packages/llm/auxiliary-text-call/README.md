---
description: "Bounded one-shot auxiliary text generation over the LLM seam, with shared limit validation, route resolution, and text-only assembly for feature plugins."
kind: "package-library"
---

# @deepseek-ai/dsh-auxiliary-text-call

English | [中文](README.zh.md)

## Summary

`dsh-auxiliary-text-call` runs one bounded, text-only auxiliary model request for a feature plugin that summarizes or labels a session outside the agent loop. A caller supplies the exact route, system prompt, framed user input, output cap, deadline, purpose, message source, cancellation, and a callback that records the request durably. The helper measures the framed input against its byte ceiling before it records or dispatches, rechecks cancellation while consuming the stream and after it completes, and accepts only a `stop` finish whose blocks are text. `assertAuxiliaryTextLimits` and `resolveAuxiliaryTextRoute` expose the same limit and route rules for earlier validation.

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

Reach for this library when a feature plugin needs a single auxiliary model call outside the agent loop and must share the harness's limit, route, deadline, and text-only rules. The shipped consumers are the session-recap and session-title LLM policies; a conversational turn or a tool-capable request does not belong here.

### Entry point

The caller validates its limits, resolves a route, then runs the call and records the exact request through the callback.

```text
import { assertAuxiliaryTextLimits, resolveAuxiliaryTextRoute, runAuxiliaryTextCall } from '@deepseek-ai/dsh-auxiliary-text-call'

assertAuxiliaryTextLimits('my-feature', limits)
const route = resolveAuxiliaryTextRoute('my-feature', limits, loggedRoute)
const text = await runAuxiliaryTextCall(ctx, {
  label: 'my-feature',
  session,
  route,
  system,
  framedInput,
  maxInputBytes: limits.maxInputBytes,
  maxTokens: limits.maxOutputTokens,
  timeoutMs: limits.timeoutMs,
  timeoutCode: 'MY_FEATURE_TIMEOUT',
  purpose,
  source,
  signal,
  record: request => session.append('session/my-feature-request', request),
})
```

Success resolves to the concatenated text blocks. Failure throws before dispatch, during the stream, or after it, and an accepted `stop` with no text blocks resolves to an empty string for the caller to judge.

### Validating limits and resolving a route

`assertAuxiliaryTextLimits(label, limits)` requires positive integers for `maxInputBytes`, `maxOutputTokens`, and `timeoutMs`, rejects a `timeoutMs` above the runtime timer limit, and requires the optional `provider` and `model` override as a non-empty pair or as neither. `resolveAuxiliaryTextRoute(label, limits, route?)` returns the explicit pair when present and otherwise the supplied logged route, throwing when neither is available. `AuxiliaryTextLimitsFields` exposes the matching schemastery fields so a plugin can compose them into its own statically walkable `Config`.

### Running one call

`runAuxiliaryTextCall(ctx, options)` throws before dispatch when the caller signal is already aborted or `framedInput` exceeds `maxInputBytes`. It builds one user message from `framedInput` and `source`, deep-freezes the generate options (`provider`, `model`, `messages`, `system`, `maxTokens`, `sessionId`, `purpose`, `signal`), invokes `record({ system, messages, maxTokens })`, and streams through `ctx.llm.stream` under a `deadline(signal, timeoutMs, timeoutCode)`. It rechecks the deadline before dispatch, on every chunk, and after the stream ends. Only a `stop` finish is accepted; `error` and `aborted` finishes rethrow the provider message and code, `max-tokens`, `tool-calls`, and unknown kinds raise labeled errors, and tool-call blocks are rejected before the text blocks are joined.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the helper's design; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

One helper keeps limit measurement, request recording, deadline fusion, and text-only assembly identical across auxiliary consumers. The caller keeps route choice, prompt content, the request purpose, the message source, and the durable record format, so the helper never invents a session event.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Limits and route validation, the `record`-then-dispatch call, deadline fusion, and finish-reason mapping |

### Stream and finish handling

The helper assembles chunks with `BlockAssembler`, so it reads the terminal finish reason and the final blocks from one accumulator. A text-free successful response is a valid empty result, while a response carrying any tool-call block is rejected because these callers own no tool loop. A late completion cannot succeed: the deadline signal is rechecked after the stream ends, so an adapter that ignored abort still fails the call.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the helper's contract is not enough. They move from the shipped consumers to the stream vocabulary it assembles.

- [Session recap LLM policy](../../session/session-recap-llm/README.md) — one shipped consumer with its own digest and record.
- [Session title LLM policy](../../session/session-title-llm/README.md) — the other shipped consumer of this helper.
- [LLM streaming subsystem](../../../docs/subsystems/llm-streaming.md) — the message, request, stream-chunk, and purpose vocabulary.
- [LLM package map](../README.md) — the group of provider adapters and request services this helper composes.

-----

<a id="model-experience"></a>
## Model Experience

### Caller-framed auxiliary request

#### What the model sees

Exactly what the caller supplies: the `system` prompt, one user message whose content is `framedInput`, and the message `source` the caller attaches. The helper adds no instruction, example, or tool schema of its own.

#### Token effect

One auxiliary request per call, bounded by the caller's `maxInputBytes` and `maxTokens`. It is separate from the main agent request and contributes nothing to agent history.

#### KV Cache effect

Independent of the main request, so it never invalidates main-request prefix reuse. Reuse across auxiliary calls is provider-specific and depends on whether the caller repeats the same system prompt and input prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the accepted auxiliary call shapes. They are current package constraints.

- **The `purpose` classification is closed** — `AuxiliaryTextCallOptions.purpose` accepts only the shipped `session-title` and `session-recap` values, so a new feature plugin cannot label its own purpose without extending the LLM seam.
- **Text-only, single-message requests** — the helper always sends one user message and rejects tool calls, so multi-message histories, tool use, and structured output are not supported.
- **No built-in record schema** — the caller owns the `record` callback and no event type ships here, so every consumer defines and declares its own durable request record.
- **An empty success is not an error** — a `stop` finish with no text blocks resolves to an empty string, leaving the caller to reject it.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
