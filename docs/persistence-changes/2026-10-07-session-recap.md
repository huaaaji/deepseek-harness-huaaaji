---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-07-session-recap

English | [中文](2026-10-07-session-recap.zh.md)

## Summary

Adds the log-only session/recap and session/recap-llm-request events for durable, user-facing session recaps.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-10-07-session-recap
baseline: false
changes:
  - root: "event:session/recap"
    previous: null
    after: "3f36f9c47ae269a7fa4fb0b01a52fa0aff717d7d8ba37de1c9f2eb80660016de"
    decision: same-version
  - root: "event:session/recap-llm-request"
    previous: null
    after: "836c023d000595c8d1c6da8b53863167cf3c3f4361a280216029ef615823c96f"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Both roots are additive and log-only: they never enter the model surface or derived history, and existing logs remain valid. A build that knows the roots folds the latest recap; a build that does not refuses a log containing them because neither event is marked ignorable, matching the session/title precedent.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/session/session-recap packages/session/session-recap-llm packages/session/session-recap-idle-llm: 39 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
