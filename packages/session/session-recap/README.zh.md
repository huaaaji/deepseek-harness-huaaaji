---
description: "持久、日志支持的会话回顾：有界摘要收集、提供方注册表与服务方验收。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-recap

[English](README.md) | 中文

## 概述

使用 `dsh-session-recap` 为每个会话提供已完成工作的持久、面向用户的记录，同时不让该记录进入模型输入。服务从日志折叠出最新已接受的 `session/recap` 事件，收集其后的有界摘要窗口，并请求一个已注册提供方总结该窗口。已接受文本、来源 seq、轮次范围以及提供方与模型路由都能在回放与恢复后保留。较新的请求会取代进行中的请求，dispose（资源释放）会中止并排空活跃工作，调用方通过 `SessionRecapError.code` 缩小预期失败的范围。

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

把服务挂载在会话存储旁边，然后注册一个提供方插件来生成回顾。两个上限都是必填的正整数；该库不提供默认值。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-recap'
  config:
    maxBytes: 400
    maxEntryBytes: 120
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `maxBytes` | 必填 | 任何已接受回顾文本允许的最大 UTF-8 字节数 |
| `maxEntryBytes` | 必填 | 单条已收集摘要条目允许的最大 UTF-8 字节数 |

生成的[配置目录](../../../docs/config-catalog.zh.md)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 注册提供方

`ctx.sessionRecap.register(provider)` 只接受一个实现；第二次活跃注册会抛出，返回的 effect disposer 会把该注册标记为正在关闭、中止其进行中的调用、等待它们结算，然后才释放槽位。注册正在关闭期间，`generate()` 报告 `unavailable`。提供方暴露稳定的非空 `id` 与异步 `generate(request)`；请求携带活跃会话、按日志顺序排列的摘要条目、覆盖的轮次范围、当前已记录的主请求路由（若存在）以及取消信号。

### 生成与读取回顾

`generate(session, signal?)` 只回顾最新已接受回顾之后的窗口。它收集该事件 seq 之后符合条件的 `user/message`、`assistant/message` 与 `tool/result` 事件文本，把每条条目约束到 `maxEntryBytes`，并把条目及其轮次范围传给提供方。随后服务把提议文本规范到 `maxBytes`，要求文本非空且 `sourceSeqs` 是取自请求的唯一升序序列，然后追加已接受的 `session/recap` 事件。`get(session)` 与 `foldSessionRecap(events)` 从活跃或回放日志中读取最新已接受回顾；`truncateRecapUtf8` 在不切断码点的前提下约束文本。

### 失败与恢复

`SessionRecapError` 携带三种情况：未注册提供方或已注册提供方正在 dispose 时的 `unavailable`；覆盖窗口中没有符合条件的条目时的 `empty`；提供方失败或返回不可接受结果时的 `generation`。调用方取消、取代、会话 dispose 与服务 dispose 则改为原样抛出确切的 abort 原因。较新的 `generate()` 会中止较旧者，会话 dispose 中止该会话的工作，服务 dispose 中止并排空所有剩余工作后才完成卸载。该事件仅写入日志，因此绝不改变模型输入，其折叠在回放中保持稳定。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释回顾设计；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

回顾是持久的、仅写入日志的状态：每个已接受的修订都是 `session/recap` 事件，`foldSessionRecap()` 选择最新事件，因此回顾像任何其他会话事件一样在回放、恢复与分页中存活。服务拥有摘要收集、规范化、取代与接受；提供方负责生成。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 服务、配置、摘要收集器、提供方注册表、取代与接受 |
| [`src/normalize.ts`](src/normalize.ts) | 回顾文本与摘要条目的终端安全单行规范化及 UTF-8 截断 |
| [`src/types.ts`](src/types.ts) | 回顾类型与 `session/recap` 事件声明 |
| [`src/client.ts`](src/client.ts) | `./types` 的客户端命名空间类型再导出 |

### 生命周期与并发

每个会话的工作状态维护一个修订计数器与活跃生成。新请求以取代原因中止活跃生成并预留下一个修订；每次生成用自身的 controller、服务生命周期与可选调用方信号组合出信号，提供方、修订、会话或信号已陈旧的完成结果无法追加。提供方 dispose、会话 dispose 与服务 dispose 各自中止其拥有的工作，并在释放状态前排空它们。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当服务约定不够用时阅读以下页面。它们从此处插拔的提供方逐步进入可复用的共享策略与有界调用。

- [共享 LLM 回顾策略](../session-recap-llm/README.zh.md)——回顾提供方可复用的模型支持策略。
- [空闲回顾提供方](../session-recap-idle-llm/README.zh.md)——在空闲延迟后生成回顾的随附提供方。
- [有界辅助文本调用](../../llm/auxiliary-text-call/README.zh.md)——共享策略派发所经过的一次性请求辅助模块。
- [会话包映射](../README.zh.md)——相邻的持久化、投影、标题与遥测包。
- [LLM 流式子体系](../../../docs/subsystems/llm-streaming.zh.md)——辅助调用使用的请求与流词汇。

-----

<a id="model-experience"></a>
## 模型体验

### 会话回顾状态

#### 模型看到什么

无。`session/recap` 只写入日志：已接受文本、来源 seq 与轮次范围绝不会进入会话接口、`deriveMessages()`、系统提示词、工具 schema 或请求前缀。提供方的独立辅助请求由对应提供方包的文档说明。

#### Token 影响

服务不会向主 agent 请求增加 token。摘要收集与接受绝不会派发到 `ctx.llm`；模型支持的提供方拥有自己的辅助请求及其上限。

#### KV Cache 影响

不影响主请求；回顾事件不会改变其重建内容或缓存键。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明回顾服务不提供什么。它们是当前包约束。

- **至多一个提供方**——注册表只接受一个实现，因此部署若要组合相互竞争的回顾策略，必须编写一个自行负责优先级的提供方。
- **仅限窗口回顾，仅限文本**——生成始终覆盖最新已接受回顾之后保留的摘要条目，且服务只接受纯文本；逐条总结、对更早窗口的检索以及结构化回顾载荷都不属于此服务。
- **没有投影单元**——服务向调用方暴露 `get()` 与 `foldSessionRecap()`，而不注册 `ctx.sessionProjections` 单元，因此列出回顾的客户端需要自己拥有读模型。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
