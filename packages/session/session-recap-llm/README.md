---
description: "Shared model-request policy for session-recap providers: required limits, route resolution, digest framing, and the recorded auxiliary request."
kind: "package-library"
---

# @deepseek-ai/dsh-session-recap-llm

English | [中文](README.zh.md)

## Summary

`dsh-session-recap-llm` generates a one-line session recap through `ctx.llm` under one shared request policy. A provider plugin supplies the recap id and delegates generation; the policy validates every required limit, resolves the route from an explicit provider and model pair or the session's logged `request/header`, selects the digest entries that fit `maxInputBytes`, records the exact request, and streams one auxiliary call. It rejects tool calls, non-stop finishes, and empty output, preserves caller cancellation and the configured deadline, and leaves the accepted byte cap to the recap service.

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

As a deployment, configure this policy through a provider plugin such as the [idle provider](../session-recap-idle-llm/README.md). As a provider author, register through `registerSessionRecapLlmProvider(ctx, config, id)` instead of hand-rolling generation.

### Registering a provider

The helper validates the shared config, then registers a provider on `ctx.sessionRecap` whose id is `SessionRecapProviderId(id)` and whose generation runs entirely through `generateSessionRecapWithLlm`. A second registration on the service throws. The shipped [idle provider](../session-recap-idle-llm/README.md) registers this policy under its own plugin name.

### Configuration

<a id="configuration"></a>

Every field is required except the paired route override; there are no library defaults.

| Key | Default | Meaning |
|---|---|---|
| `targetCharacters` | required | Target character count for the one-line recap |
| `maxInputBytes` | required | UTF-8 byte ceiling for the final JSON-framed user prompt |
| `maxOutputTokens` | required | Auxiliary generation token cap |
| `timeoutMs` | required | End-to-end deadline, at most the runtime timer limit |
| `provider`, `model` | optional | Explicit route; supply both or neither |

The generated [configuration catalog](../../../docs/config-catalog.md) is the exhaustive source for every accepted field and its JSDoc.

### Digest selection and request recording

The covered window's first entry always contributes, so the recap keeps the prompt that started it; later entries join from the tail while the JSON-framed prompt stays within `maxInputBytes`. A window whose first entry alone exceeds the budget throws instead of truncating. The policy appends the log-only `session/recap-llm-request` event, carrying the recap provider, source seqs, route, exact system prompt, messages, and output cap, after measurement and before dispatch, so a later model failure leaves that record intact.

### Failure and cancellation contract

Without an explicit pair or a logged route, generation throws. The auxiliary call rejects the configured deadline, an aborted caller, tool calls, a `maxOutputTokens` finish, and any unsupported finish reason, and it stamps the deadline with `SESSION_RECAP_TIMEOUT_CODE`. The policy rejects text that is empty after normalization and applies no byte cap of its own, leaving `maxBytes` to the recap service.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the generation path; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design concept

One shared policy so provider plugins cannot drift: config validation, route resolution, digest framing, prompt construction, the request record, and output validation all live here, parameterized only by the recap provider id.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Config schema and validation, provider registration, system instruction, digest selection, and auxiliary dispatch |

### Request flow

A generation selects the digest, resolves the route through `resolveAuxiliaryTextRoute`, frames the selected entries as a JSON array behind one fixed prefix, measures the framed prompt, records the request, and dispatches one `purpose: 'session-recap'` call through the [bounded auxiliary text call](../../llm/auxiliary-text-call/README.md). The helper returns plain text, which the policy normalizes and rejects when empty; the result carries the exact source seqs and the route actually used.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the generation policy is not enough. They move from the service that accepts its output to the provider built on it.

- [Session recap service](../session-recap/README.md) — the service that owns the digest window and the accepted byte cap.
- [Idle recap provider](../session-recap-idle-llm/README.md) — the shipped provider that schedules this policy.
- [Bounded auxiliary text call](../../llm/auxiliary-text-call/README.md) — the one-shot request helper this policy dispatches through.
- [Session package map](../README.md) — adjacent persistence, projection, title, and telemetry packages.
- [LLM streaming subsystem](../../../docs/subsystems/llm-streaming.md) — the request vocabulary and the `session-recap` purpose classification.

-----

<a id="model-experience"></a>
## Model Experience

### Auxiliary recap request

#### What the model sees

The recap model receives one system instruction and one user message. The instruction asks for a one-line plain-text summary of the covered window, in the language of the entries, with no quotes, Markdown, code, or control codes, targeting about `targetCharacters` characters. The user message is the fixed prefix `Summarize this session window:` followed by a JSON array of the selected entries with their `seq`, `turn`, `kind`, optional tool name, and text.

#### Token effect

The auxiliary request consumes tokens for the selected digest and the configured `maxOutputTokens`; it is a separate request from the main agent request and adds nothing to agent history.

#### KV Cache effect

Independent of the main request, so it never invalidates main-request reuse. Its own prefix is stable only while the system instruction and the selected entries repeat; the JSON array changes with each covered window.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the accepted generation shapes. They are current package constraints.

- **Whole-prompt byte ceiling** — the policy drops tail entries when the framed prompt exceeds `maxInputBytes` and rejects a window whose first entry alone does not fit; it never clips or summarizes individual entries.
- **One request shape** — every provider gets one fixed instruction prefix and one JSON user message; prompt variants, multi-turn framing, and structured output are not exposed.
- **No accepted byte cap here** — the policy normalizes without a byte budget and defers `maxBytes` to the recap service, so a provider used outside that service must bound the text itself.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
