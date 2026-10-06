---
description: "空闲节奏的会话回顾提供方：在已完成轮次空闲后安排一次自动回顾。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-recap-idle-llm

[English](README.md) | 中文

## 概述

把 `dsh-session-recap-idle-llm` 挂载在回顾服务与 LLM 运行时旁边，就能在已完成轮次空闲 `minIdleMs` 后自动回顾会话。插件注册共享的模型支持提供方，在已完成的 `turn/end` 后为每个会话装载一个定时器，在新轮次开始或会话 dispose 时取消它，并且只在日志中至少存在 `minTurns` 个已完成轮次后才生成。`empty` 与 `unavailable` 结果保持静默；其他任何自动失败都会发出警告并保留已接受回顾，dispose 会释放所有待处理定时器。

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

当会话应在用户离开后自我总结时挂载此插件。它需要完整的[共享 LLM 配置](../session-recap-llm/README.zh.md#configuration)以及空闲节奏，且没有默认值。

### 何时生成回顾

只有原因为 `completed` 的 `turn/end` 会装载定时器；`turn/start` 与其他任何 `turn/end` 原因都会清除它而不装载。定时器触发时，插件只在日志中至少存在 `minTurns` 个已完成轮次时才回顾，否则直接停止而不生成。由于延迟先于生成，后续活动会在待处理回顾开始前取消它，且每个会话至多保留一个待处理定时器。

### 配置

除成对的路由覆盖外，所有字段都是必填项。

| 键 | 默认值 | 含义 |
|---|---|---|
| `minIdleMs` | 必填 | 已完成轮次后自动回顾前的空闲延迟 |
| `minTurns` | 必填 | 自动回顾所需的最少已完成轮次数 |
| `targetCharacters` | 必填 | 单行回顾的目标字符数 |
| `maxInputBytes` | 必填 | 摘要框架提示词的 UTF-8 字节上限 |
| `maxOutputTokens` | 必填 | 辅助生成 token 上限 |
| `timeoutMs` | 必填 | 辅助调用的端到端截止时间 |
| `provider`、`model` | 可选 | 显式路由；两者同时提供或同时省略，省略两者则使用会话已记录的路由 |

生成的[配置目录](../../../docs/config-catalog.zh.md)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 失败与恢复

`empty`（没有新工作可回顾）与 `unavailable`（没有可用提供方）保持静默，因此没有新工作的空闲会话是正常的。其他任何失败都会通过插件日志发出警告并保留上一条已接受回顾；下一个已完成轮次可以再次尝试。插件 dispose 会清除所有待处理定时器而不生成。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释插件的形态；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

一个轻量函数插件：它校验空闲节奏，把生成策略委托给共享辅助模块，只拥有决定何时调用回顾服务的按会话调度。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件标识、配置校验、定时器调度与提供方注册 |

### 调度

插件注入 `sessionRecap`、`llm` 与 `sessions`。其 `session/event` 监听器在 `turn/start` 时清除待处理定时器，并在已完成的 `turn/end` 时装载一个；定时器触发时它统计 `turn/end` 事件以判断 `minTurns`，并调用 `ctx.sessionRecap.generate(session)`。`session/disposed` 清除该会话的定时器，插件 effect 在 dispose 时清除所有剩余定时器。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当插件约定不够用时阅读以下页面。它们从它驱动的服务逐步进入请求背后的策略与辅助模块。

- [会话回顾服务](../session-recap/README.zh.md)——接受自动回顾的服务。
- [共享 LLM 回顾策略](../session-recap-llm/README.zh.md)——此插件注册的生成策略。
- [有界辅助文本调用](../../llm/auxiliary-text-call/README.zh.md)——策略派发所经过的一次性请求辅助模块。
- [会话包映射](../README.zh.md)——相邻的持久化、投影、标题与遥测包。

-----

<a id="model-experience"></a>
## 模型体验

### 自动空闲回顾请求

#### 模型看到什么

插件本身不会向模型请求贡献任何内容；它触发的回顾通过共享策略到达模型，后者发送配置的系统指令与一条 JSON 用户消息，其中包含所选摘要条目。

#### Token 影响

每个空闲时段至多派发一次辅助回顾请求，且发生在定时器触发并满足 `minTurns` 之后；其大小受 `maxInputBytes` 与 `maxOutputTokens` 约束。主 agent 请求不增加 token，空闲延迟也不会给它带来延迟。

#### KV Cache 影响

不影响主请求。辅助请求是独立的，因此其摘要绝不会改变主请求的前缀复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明此提供方何时停止回顾。它们是当前包约束。

- **每个会话只有一个待处理回顾**——新的已完成轮次会替换待处理定时器，且插件不保留队列，因此若干次快速完成的轮次至多在最后一次之后产生一次回顾。
- **轮次数是唯一门槛**——`minTurns` 统计所有以 `completed` 为原因记录的 `turn/end`，因此插件没有“实质工作”的概念，也会回顾很短的已完成轮次。
- **空闲时间无法跨重启保留**——该延迟是进程本地主机定时器，因此重启后的会话需要等待下一个已完成轮次才能自动回顾。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
