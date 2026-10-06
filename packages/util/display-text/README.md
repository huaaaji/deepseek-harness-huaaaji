---
description: "Display-safe text primitives for client-rendered surfaces: terminal-escape and invisible-control removal plus UTF-8 byte-bounded truncation."
kind: "package-library"
---

# @deepseek-ai/dsh-display-text

English | [中文](README.zh.md)

## Summary

`dsh-display-text` turns untrusted text into one terminal-safe display line. It removes OSC, CSI, and short ESC sequences, C0/C1 controls, and invisible or directional controls, collapses whitespace, and bounds the result to a UTF-8 byte budget without splitting a Unicode code point. It is a **library, not a service**: no `ctx`, no registration, no state. Callers keep their own semantics — a session title still applies its word cap, and a recap entry still decides which text is worth showing.

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

### When to use it

Use this package when text authored outside the process reaches a human-readable surface that renders a single line: generated titles, recap rows, or any other client-rendered label. Do not use it to change business meaning; it only removes invisible or control content and enforces a byte budget.

### Entry point

Import the primitive that matches the work and pass a positive integer byte budget:

```ts
import {
  normalizeDisplayText,
  sanitizeDisplayText,
  truncateDisplayTextUtf8,
} from '@deepseek-ai/dsh-display-text'

const line = normalizeDisplayText('\u001B[31m  Build failed  \u001B[0m', 80)
const cleaned = sanitizeDisplayText('one\ttwo\nthree')
const bounded = truncateDisplayTextUtf8('你好世界', 7)
```

`truncateDisplayTextUtf8` throws when the budget is not a positive integer; `sanitizeDisplayText` and `normalizeDisplayText` never throw on text content. See [`src/index.ts`](src/index.ts) for the exact TypeScript contract.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Sanitization applies five ordered regular expressions: OSC sequences (including unterminated tails), CSI sequences, remaining two-byte ESC sequences, non-whitespace C0/C1 controls, and directional/invisible controls. Whitespace then collapses to single spaces and the result is trimmed.

Truncation walks code points, adds each one only while the running `Buffer.byteLength` total stays within the budget, and stops at the first code point that would cross it. The returned prefix therefore never splits a code point, and a budget smaller than the first code point yields the empty string.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Sanitization regexes, byte-bounded truncation, and the composed normalizer |
| [`tests/display-text.spec.ts`](tests/display-text.spec.ts) | Escape, control, whitespace, and byte-budget coverage |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Utility package map](../README.md) — the other zero-dependency primitives shared across package groups.
- [Session title](../../session/session-title/README.md) — the word-capped title consumer.

-----

<a id="model-experience"></a>
## Model Experience

None, as the library only removes terminal controls and bounds display text for the title and recap owners.

#### KV Cache effect

No model request is assembled here, so provider KV-cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Grapheme clusters are not measured** — the byte budget counts UTF-8 bytes per code point, so combining sequences, flags, and ZWJ emoji truncate at the code-point boundary rather than the user-perceived character.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
