---
description: "会话回顾提供方共享的模型请求策略：必填上限、路由解析、摘要框架与已记录的辅助请求。"
kind: "package-library"
---

# @deepseek-ai/dsh-session-recap-llm

[English](README.md) | 中文

## 概述

`dsh-session-recap-llm` 在统一的请求策略下通过 `ctx.llm` 生成单行会话回顾。提供方插件提供回顾 id 并委托生成；策略校验每个必填上限，从显式 provider 与 model 对或会话已记录的 `request/header` 解析路由，选择能装进 `maxInputBytes` 的摘要条目，记录确切请求，并流式执行一次辅助调用。它拒绝工具调用、非 stop 终止与空输出，保留调用方取消与配置的截止时间，并把已接受字节上限留给回顾服务。

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

作为部署，通过提供方插件（例如[空闲提供方](../session-recap-idle-llm/README.zh.md)）配置此策略。作为提供方作者，请通过 `registerSessionRecapLlmProvider(ctx, config, id)` 注册，而不要自行实现生成。

### 注册提供方

该辅助模块先校验共享配置，然后在 `ctx.sessionRecap` 上注册一个提供方，其 id 为 `SessionRecapProviderId(id)`，其生成完全通过 `generateSessionRecapWithLlm` 执行。在服务上第二次注册会抛出。随附的[空闲提供方](../session-recap-idle-llm/README.zh.md)以自己的插件名注册此策略。

### 配置

<a id="configuration"></a>

除成对的路由覆盖外，所有字段都是必填项；该库不提供默认值。

| 键 | 默认值 | 含义 |
|---|---|---|
| `targetCharacters` | 必填 | 单行回顾的目标字符数 |
| `maxInputBytes` | 必填 | 最终 JSON 框架用户提示词的 UTF-8 字节上限 |
| `maxOutputTokens` | 必填 | 辅助生成 token 上限 |
| `timeoutMs` | 必填 | 端到端截止时间，不得超过运行时定时器上限 |
| `provider`、`model` | 可选 | 显式路由；两者同时提供或同时省略 |

生成的[配置目录](../../../docs/config-catalog.zh.md)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 摘要选择与请求记录

覆盖窗口的第一条条目总会参与，因此回顾会保留开启该窗口的提示词；后续条目在 JSON 框架提示词不超过 `maxInputBytes` 的前提下从尾部加入。若仅第一条条目就超出预算，则抛出而不是截断。策略在度量之后、派发之前追加仅写入日志的 `session/recap-llm-request` 事件，携带回顾提供方、来源 seq、路由、确切系统提示词、消息与输出上限，因此之后的模型失败不会影响该记录。

### 失败与取消约定

既没有显式对也没有已记录路由时，生成会抛出。辅助调用会拒绝配置的截止时间、已取消的调用方、工具调用、`maxOutputTokens` 终止以及任何不受支持的终止原因，并用 `SESSION_RECAP_TIMEOUT_CODE` 标记该截止时间。策略拒绝规范化后为空的文本，且不自行施加字节上限，把 `maxBytes` 留给回顾服务。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释生成路径；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

一个共享策略，使提供方插件无法产生偏差：配置校验、路由解析、摘要框架、提示词构建、请求记录与输出校验都在这里，只以回顾提供方 id 作为参数。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 配置 schema 与校验、提供方注册、系统指令、摘要选择与辅助派发 |

### 请求流程

一次生成会选择摘要，通过 `resolveAuxiliaryTextRoute` 解析路由，把所选条目框架为一个 JSON 数组并置于一个固定前缀之后，度量该框架提示词，记录请求，并通过[有界辅助文本调用](../../llm/auxiliary-text-call/README.zh.md)派发一次 `purpose: 'session-recap'` 调用。该辅助模块返回纯文本，策略将其规范化并在为空时拒绝；结果携带确切的来源 seq 与实际使用的路由。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当生成策略不够用时阅读以下页面。它们从接受其输出的服务逐步进入构建于其上的提供方。

- [会话回顾服务](../session-recap/README.zh.md)——拥有摘要窗口与已接受字节上限的服务。
- [空闲回顾提供方](../session-recap-idle-llm/README.zh.md)——调度此策略的随附提供方。
- [有界辅助文本调用](../../llm/auxiliary-text-call/README.zh.md)——此策略派发所经过的一次性请求辅助模块。
- [会话包映射](../README.zh.md)——相邻的持久化、投影、标题与遥测包。
- [LLM 流式子体系](../../../docs/subsystems/llm-streaming.zh.md)——请求词汇与 `session-recap` 用途分类。

-----

<a id="model-experience"></a>
## 模型体验

### 辅助回顾请求

#### 模型看到什么

回顾模型收到一条系统指令和一条用户消息。指令要求以条目所用语言给出一行覆盖窗口的纯文本总结，不得包含引号、Markdown、代码或控制符，目标约为 `targetCharacters` 个字符。用户消息是固定前缀 `Summarize this session window:`，其后是所选条目的 JSON 数组，包含各自的 `seq`、`turn`、`kind`、可选工具名与文本。

#### Token 影响

辅助请求按所选摘要与配置的 `maxOutputTokens` 消耗 token；它是独立于主 agent 请求的一次请求，不会向 agent 历史增加任何内容。

#### KV Cache 影响

独立于主请求，因此绝不会使主请求的复用失效。其自身前缀只有在系统指令与所选条目重复时才稳定；JSON 数组会随每个覆盖窗口变化。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明可接受的生成形态。它们是当前包约束。

- **整段提示词字节上限**——当框架提示词超过 `maxInputBytes` 时，策略丢弃尾部条目，并拒绝仅第一条条目就装不下的窗口；它绝不裁剪或概括单条条目。
- **单一请求形态**——每个提供方都得到同一个固定指令前缀与同一条 JSON 用户消息；提示词变体、多轮框架与结构化输出都不对外暴露。
- **此处没有已接受字节上限**——策略在无字节预算的情况下规范化，并把 `maxBytes` 交给回顾服务，因此在该服务之外使用提供方时必须自行约束文本。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
