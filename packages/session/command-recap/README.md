---
description: "The on-demand /recap command for interactive compositions: what it does, what you see, and how to mount it."
kind: "package-reference"
---

# @deepseek-ai/dsh-command-recap

English | [中文](README.zh.md)

## Summary

`dsh-command-recap` adds a `/recap` command to chat UIs: type it and the session writes one short account of the work completed since the last accepted recap. The command works with any registered recap generator and does not consume a model turn; the generated text is recorded in the session log and shown directly to you. When no generator is mounted, when nothing new happened, or when generation fails, it reports that outcome instead of inventing a recap.

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

Type `/recap` in a chat UI to ask for an account of the work completed since the last accepted recap. The command requires a mounted recap generator; without one it reports that recap is unavailable rather than composing a fallback.

### Using the command

| Input | Result |
|---|---|
| `/recap` | Generate one recap of the window after the last accepted recap, then show its text. |
| `/recap` with nothing new | `Nothing new to recap yet.` — nothing changes. |
| `/recap <anything>` | `Usage: /recap (no arguments)` — the command takes no arguments. |

### What you see

The command turns each expected failure into a stable message you can show directly; the situation on the left is what produced the message on the right.

| Situation | Message you see |
|---|---|
| No recap generator is mounted | `Recap is unavailable because no recap generator is configured.` |
| The covered window holds no new work | `Nothing new to recap yet.` |
| The generator produced no acceptable recap | `The recap could not be generated.` |

Cancelling the command stops the wait: the provider finishes its required cleanup, and the command settles as `Recap cancelled.` while the UI stops waiting. Failures other than these expected cases surface as errors rather than being silently converted.

### Composing the command

Mount the command registry, the session-recap service with its required limits, one recap provider, and this plugin:

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: session-recap
  name: '@deepseek-ai/dsh-session-recap'
  config:
    maxBytes: 1200
    maxEntryBytes: 200
- id: command-recap
  name: '@deepseek-ai/dsh-command-recap'
```

Mount this plugin in the profiles that should expose `/recap`, beside the recap service and a provider. The Web client provides the command adapter; a profile that composes no command adapter keeps only whatever automatic recap cadence it mounts.

### What happens to the conversation

A successful `/recap` appends one `session/recap` event and returns its text to the dispatching UI; chat history, the session surface, and derived messages are unchanged. The command lifecycle and the recap event are recorded in the session log but never enter model history. A new invocation recaps only the window after the last accepted recap, so repeating the command never re-summarizes work you already saw.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the command; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The command is built on three commitments:

- **Generator-independent control.** The handler depends only on `ctx.sessionRecap.generate(session, signal)`, so it works with any registered `SessionRecapProvider`. The invoking agent's session is the exact target, and the dispatching UI's cancellation signal is forwarded through the seam.
- **The command lifecycle stays out of model history.** `command/run` and `command/done` are log-only events; `sourceEventSeq` correlates the successful result with the appended `session/recap` event without relying on text or row adjacency.
- **Quiescent teardown.** The lifecycle effect unregisters `/recap` before draining already-started handlers, so an aborted command's provider work settles before root disposal completes.

### Failure mapping

Only the seam's declared failure classes become user text. `unavailable` means no provider is registered or the registered one is disposing; `empty` means the covered window holds no digest entry; `generation` means the provider produced nothing acceptable. Cancellation stays separate: the handler reports `Recap cancelled.` when the caller's signal is aborted, and any other error propagates unchanged so a real defect is not disguised as an expected outcome.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: `/recap` registration, argument rejection, error-code mapping, lifecycle drain |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough; they move from the command to the registry, the recap design, and the surrounding session packages.

- [Commands package](../../interaction/commands/README.md) — the registry and dispatch contract behind chat commands.
- [Human commands subsystem](../../../docs/subsystems/commands.md) — the command definition, invocation, and result vocabulary.
- [Session recap design note](../../../.agents/notes/implemented/feature/2026-10-07-session-recap.md) — the recap capability, its providers, and its rejected alternatives.
- [Session package map](../README.md) — adjacent durable-session, projection, title, and telemetry packages.

-----

<a id="model-experience"></a>
## Model Experience

### Human `/recap` control

#### What the model sees

Nothing. The slash input, the generated recap, and the `session/recap` event are log-only: they never enter the session surface, `deriveMessages()`, the system prompt, or a request prefix. Only a mounted provider's own auxiliary call reaches a model, and that provider package owns its request.

#### Token effect

Zero direct token effect. The command, its result text, and the accepted event add no tokens to the main agent request. A provider's separate generation call is the only model spend the command can cause.

#### KV Cache effect

None for the main request. `/recap` changes no reconstructed request content, so an already-reusable request prefix stays valid.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the command is a poor fit; they are the current package constraints.

- **No registered generator, no recap** — the command deliberately ships no deterministic fallback, so a deployment without a recap provider reports the feature as unavailable.
- **Human initiators only** — commands reach an agent only through the interactive adapter that invoked them, so automated, relayed, or scheduled turns cannot request a recap.
- **Not a model tool** — the recap is human-facing only; the model can neither request one nor see an accepted one in its context.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers and is explicitly non-authoritative; shipped behavior lives in the sections above, the package code, and the linked Agent Notes.

- **Provider composition, external** — which provider generates recaps, and whether an automatic idle cadence also runs, belongs to the provider and bundle packages; this command only exposes the explicit path.

</details>
