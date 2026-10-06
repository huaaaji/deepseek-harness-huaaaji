---
description: "LLM 接缝上的有界一次性辅助文本生成，为功能插件提供共享的上限校验、路由解析与纯文本装配。"
kind: "package-library"
---

# @deepseek-ai/dsh-auxiliary-text-call

[English](README.md) | 中文

## 概述

`dsh-auxiliary-text-call` 为在 agent 循环之外总结或标注会话的功能插件执行一次有界、纯文本的辅助模型请求。调用方提供确切路由、系统提示词、框架化用户输入、输出上限、截止时间、用途、消息来源、取消，以及一个把请求持久记录下来的回调。辅助模块在记录或派发之前度量框架化输入的字节数，在消费流期间与流结束后再次检查取消，并且只接受块为文本的 `stop` 终止。`assertAuxiliaryTextLimits` 与 `resolveAuxiliaryTextRoute` 提前暴露同样的上限与路由规则，供更早的校验使用。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当功能插件需要在 agent 循环之外执行一次辅助模型调用，并且必须共享 harness 的上限、路由、截止时间与纯文本规则时，请使用此库。随附的使用方是会话回顾与会话标题的 LLM 策略；对话轮次或具备工具能力的请求不属于这里。

### 入口点

调用方校验自己的上限、解析路由，然后执行调用并通过回调记录确切请求。

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

成功时解析为拼接后的文本块。失败会在派发前、流进行中或流结束后抛出；被接受的 `stop` 若不含文本块，则解析为空字符串，交由调用方判断。

### 校验上限与解析路由

`assertAuxiliaryTextLimits(label, limits)` 要求 `maxInputBytes`、`maxOutputTokens` 与 `timeoutMs` 为正整数，拒绝超过运行时定时器上限的 `timeoutMs`，并要求可选的 `provider` 与 `model` 覆盖为非空的一对或同时缺省。`resolveAuxiliaryTextRoute(label, limits, route?)` 在存在显式对时返回它，否则返回传入的已记录路由，两者都没有时抛出。`AuxiliaryTextLimitsFields` 暴露对应的 schemastery 字段，使插件能把它们组合进自己可静态遍历的 `Config`。

### 执行一次调用

当调用方信号已被取消或 `framedInput` 超过 `maxInputBytes` 时，`runAuxiliaryTextCall(ctx, options)` 会在派发前抛出。它用 `framedInput` 与 `source` 构建一条用户消息，深度冻结生成选项（`provider`、`model`、`messages`、`system`、`maxTokens`、`sessionId`、`purpose`、`signal`），调用 `record({ system, messages, maxTokens })`，并在 `deadline(signal, timeoutMs, timeoutCode)` 下通过 `ctx.llm.stream` 流式执行。它在派发前、每个分块时以及流结束后都重新检查截止时间。只接受 `stop` 终止；`error` 与 `aborted` 会原样重新抛出提供方的消息与代码，`max-tokens`、`tool-calls` 与未知种类会抛出具名错误，工具调用块会在拼接文本块之前被拒绝。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释辅助模块的设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

一个辅助模块让各辅助使用方共享完全一致的上限度量、请求记录、截止时间融合与纯文本装配。调用方保留路由选择、提示词内容、请求用途、消息来源与持久记录格式，因此辅助模块绝不自行创造会话事件。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 上限与路由校验、先记录后派发的调用、截止时间融合与终止原因映射 |

### 流与终止处理

辅助模块用 `BlockAssembler` 装配分块，因此从同一个累加器读取终止原因与最终块。无文本的成功响应是合法的空结果，而携带任何工具调用块的响应会被拒绝，因为这些调用方不拥有工具循环。迟到的完成无法成功：流结束后会重新检查截止时间信号，因此忽略 abort 的适配器仍会让调用失败。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当辅助模块约定不够用时阅读以下页面。它们从随附使用方逐步进入它所装配的流词汇。

- [会话回顾 LLM 策略](../../session/session-recap-llm/README.zh.md)——拥有自己摘要与记录的一个随附使用方。
- [会话标题 LLM 策略](../../session/session-title-llm/README.zh.md)——此辅助模块的另一个随附使用方。
- [LLM 流式子体系](../../../docs/subsystems/llm-streaming.zh.md)——消息、请求、流分块与用途词汇。
- [LLM 包映射](../README.zh.md)——此辅助模块所组合的提供方适配器与请求服务所在的组。

-----

<a id="model-experience"></a>
## 模型体验

### 调用方框架化的辅助请求

#### 模型看到什么

恰好是调用方提供的内容：`system` 提示词、一条内容为 `framedInput` 的用户消息，以及调用方附加的消息 `source`。辅助模块不添加任何自己的指令、示例或工具 schema。

#### Token 影响

每次调用一次辅助请求，受调用方的 `maxInputBytes` 与 `maxTokens` 约束。它独立于主 agent 请求，不会向 agent 历史贡献任何内容。

#### KV Cache 影响

独立于主请求，因此绝不会使主请求的前缀复用失效。辅助调用之间的复用取决于提供方，并取决于调用方是否重复相同的系统提示词与输入前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明可接受的辅助调用形态。它们是当前包约束。

- **`purpose` 分类是封闭的**——`AuxiliaryTextCallOptions.purpose` 只接受随附的 `session-title` 与 `session-recap` 值，因此新的功能插件若想标注自己的用途，就必须扩展 LLM 接缝。
- **仅限纯文本、单条消息**——辅助模块始终只发送一条用户消息并拒绝工具调用，因此不支持多消息历史、工具使用与结构化输出。
- **没有内置记录 schema**——调用方拥有 `record` 回调，且此处不随附任何事件类型，因此每个使用方都要定义并声明自己的持久请求记录。
- **空成功不是错误**——不含文本块的 `stop` 终止解析为空字符串，交由调用方拒绝。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
