---
description: "面向交互式组合的按需 /recap 命令：它做什么、你会看到什么，以及如何挂载。"
kind: "package-reference"
---

# @deepseek-ai/dsh-command-recap

[English](README.md) | 中文

## 概述

`dsh-command-recap` 为聊天 UI 添加 `/recap` 命令：输入它，会话就会写下一条简短记录，说明自上次已接受回顾以来完成的工作。该命令适用于任何已注册的回顾生成器，且不消耗模型轮次；生成的文本记录在会话日志中，并直接展示给你。当没有挂载生成器、没有新工作，或生成失败时，它会报告相应结果，而不会凭空编造一条回顾。

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

在聊天 UI 中输入 `/recap`，即可请求一份自上次已接受回顾以来已完成工作的说明。该命令需要已挂载的回顾生成器；没有生成器时，它会报告回顾不可用，而不会自行组合一份兜底文本。

### 使用命令

| 输入 | 结果 |
|---|---|
| `/recap` | 针对上次已接受回顾之后的窗口生成一条回顾，然后展示其文本。 |
| `/recap`，但没有新工作 | `Nothing new to recap yet.`——不会有任何改变。 |
| `/recap <anything>` | `Usage: /recap (no arguments)`——该命令不接受参数。 |

### 你会看到什么

命令会把每个预期失败转换为可直接展示的稳定消息；左列的情形产生右列的消息。

| 情形 | 你看到的消息 |
|---|---|
| 未挂载回顾生成器 | `Recap is unavailable because no recap generator is configured.` |
| 覆盖窗口内没有新工作 | `Nothing new to recap yet.` |
| 生成器未产出可接受的回顾 | `The recap could not be generated.` |

取消命令会停止等待：提供方完成必需的清理，命令以 `Recap cancelled.` 结算，UI 停止等待。除这些预期情形外的失败会以错误形式呈现，而不会被静默转换。

### 组合命令

挂载命令注册表、带必需限制的会话回顾服务、一个回顾提供方，以及本插件：

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

在需要暴露 `/recap` 的 profile 中，把本插件挂载在回顾服务与提供方旁。Web 客户端提供命令适配器；未组合命令适配器的 profile 只保留其挂载的自动回顾节奏。

### 对话会发生什么

成功的 `/recap` 会追加一个 `session/recap` 事件，并把其文本返回给发起分发的 UI；聊天历史、会话 surface 与派生消息均不变。命令生命周期与回顾事件记录在会话日志中，但绝不进入模型历史。新的调用只回顾上次已接受回顾之后的窗口，因此重复执行该命令不会重复总结你已经看过的内容。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释命令背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

该命令建立在三项承诺之上：

- **与生成器无关的控制。** 处理器只依赖 `ctx.sessionRecap.generate(session, signal)`，因此可与任何已注册的 `SessionRecapProvider` 协作。调用该命令的 agent 的会话就是操作的确切目标，发起分发的 UI 会通过 seam 转发取消信号。
- **命令生命周期不进入模型历史。** `command/run` 与 `command/done` 都是仅日志事件；`sourceEventSeq` 将成功结果与所追加的 `session/recap` 事件关联，不依赖文本或行相邻关系。
- **资源销毁必须完全停稳。** 生命周期 effect 会先注销 `/recap`，再等待已开始处理器结算，因此已中止命令的提供方工作会在根级资源释放完成前结算完毕。

### 失败映射

只有 seam 声明的失败类别会转换为用户文本。`unavailable` 表示未注册提供方，或已注册的提供方正在销毁；`empty` 表示覆盖窗口内没有摘要条目；`generation` 表示提供方未产出可接受结果。取消保持独立：当调用方信号被中止时，处理器报告 `Recap cancelled.`；其他任何错误都会原样向上传播，因此真实缺陷不会被伪装成预期结果。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`/recap` 注册、参数拒绝、错误码映射、生命周期排空 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面；它们从命令逐步进入注册表、回顾设计与周边会话包。

- [命令包](../../interaction/commands/README.zh.md)——聊天命令背后的注册表与分发约定。
- [人类命令子系统](../../../docs/subsystems/commands.zh.md)——命令定义、调用与结果词汇。
- [会话回顾设计说明](../../../.agents/notes/implemented/feature/2026-10-07-session-recap.zh.md)——回顾能力、其提供方，以及被否决的备选方案。
- [会话包地图](../README.zh.md)——相邻的持久会话、投影、标题与遥测包。

-----

<a id="model-experience"></a>
## 模型体验

### 用户 `/recap` 控制

#### 模型看到的内容

没有任何内容。斜杠输入、生成的回顾与 `session/recap` 事件都是仅日志的：它们绝不会进入会话 surface、`deriveMessages()`、系统提示词或任何请求前缀。只有已挂载提供方自己的辅助调用会到达模型，且该调用由提供方包自行负责。

#### Token 影响

没有直接影响。命令、其结果文本与已接受事件都不会为主 agent 请求增加 token。提供方单独的生成调用是该命令唯一可能产生的模型开销。

#### KV Cache 影响

对主请求没有影响。`/recap` 不改变任何重建后的请求内容，因此已可复用的请求前缀保持有效。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明该命令何时不合适；它们是当前包约束。

- **没有生成器就没有回顾**——该命令有意不提供确定性兜底，因此未挂载回顾提供方的部署会把该功能报告为不可用。
- **仅限人类发起者**——命令只会通过调用它的交互式适配器到达 agent，因此自动化、转发或定时的轮次无法请求回顾。
- **不是模型工具**——回顾仅面向人类；模型既不能请求回顾，也无法在其上下文中看到已接受的回顾。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性；已交付行为以上文、包代码与所链接的 Agent Note 为准。

- **提供方组合在外部**——由哪个提供方生成回顾、是否同时运行自动空闲节奏，属于提供方与 bundle 包；本命令只暴露显式路径。

</details>
