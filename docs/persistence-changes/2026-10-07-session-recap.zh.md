---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-07-session-recap

[English](2026-10-07-session-recap.md) | 中文

## 概述

新增仅写入日志的 session/recap 与 session/recap-llm-request 事件，用于持久化的、面向用户的会话回顾。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

两个根都是增量且仅写入日志的：它们永不进入模型表面或派生历史，已有日志仍然有效。了解这两个根的构建会折叠出最近一次回顾；不了解的构建会拒绝包含它们的事件日志，因为两者都未标记 ignorable，这与 session/title 的先例一致。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/session/session-recap packages/session/session-recap-llm packages/session/session-recap-idle-llm：39 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
