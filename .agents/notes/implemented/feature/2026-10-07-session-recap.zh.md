# Agent Note: 会话回顾——用户离开期间发生了什么的一份持久记述

Status: implemented

[English](2026-10-07-session-recap.md) | 中文

## 问题

用户不在时，DSH 会话仍在继续工作：回合不断完成，后台作业结束，子代理与工作流结算，transcript 持续增长。当用户回来时——无论是回到 Web 客户端里仍然打开的会话，还是从会话目录恢复一个会话——能看到的只有状态点和滚动位置，因此要弄清发生了什么只能自己读一遍，而这段阅读的长度随会话增长。

Claude Code 已经提供了终端尺度的这一功能。它的 session recap（[v2.1.114](https://code.claude.com/docs/en/whats-new/2026-w17)、[`/recap`](https://code.claude.com/docs/en/interactive-mode)）会在用户切回一个无人看管的终端时显示一行模型写出的文字。终端失焦且距上一次回合完成至少三分钟后，它在后台生成；会话至少满三个回合后才可能出现；不会连续出现两次；长度上限 400 字符；来自转发消息或自动化提示的请求会被拒绝，只有用户自己发起的才执行。

这些机制 DSH 原本已经具备，缺的只是功能本身。[`dsh-session-title`](../../../../packages/session/session-title/README.zh.md) 已经在 agent 循环之外对会话历史发起辅助模型调用，记录精确的请求，把接受的结果持久化为仅写入日志的事件，并用新修订取代旧工作。`dsh-compaction` 已经会为历史生成摘要，并把结果显示为 transcript 标记。没有任何机制产出一份面向用户的、关于某一段已完成工作的记述，也没有任何机制在空闲时安排工作。

## 决策

新增一个按 session-title 家族组织的会话回顾能力家族，并按 compaction 标记的方式新增一行持久 transcript。

### 事件与能力缝

`@deepseek-ai/dsh-session-recap` 定义 `ctx.sessionRecap` 与仅写入日志的 `SessionEventMap` 成员 `session/recap`：归一化后的文本、带 provider id 与实际所用模型路由的 `provider` 来源、生成器实际看到的精确摘要条目 seq，以及这些条目覆盖的闭区间 `SessionRecapTurnRange`。该事件及其携带的任何内容都不是表面事件；不扩展 `SurfaceEventType`，也没有任何模型请求读取它。

服务本身负责接受。`generate(session, signal?)` 覆盖最近一条被接受回顾之后的窗口，把它收集为有界摘要，校验提供方返回的每个 seq 都来自该次请求，归一化文本，强制 `maxBytes`，然后才追加。`foldSessionRecap(events)` 是纯折叠函数，`get(session)` 从存活或回放的会话读取最近一条被接受的快照。更新的请求会取代进行中的请求，释放在替换提供方注册之前中止活动工作；预期失败是带 `unavailable`、`empty` 或 `generation` 码的 `SessionRecapError` 值；取消保持独立并抛出精确的中止原因。

不提供确定性兜底。程序不借助模型就能从日志拼出的回顾并不是回顾，回合计数也不是对工作的记述。

### 被覆盖的摘要窗口

`collectSessionRecapEntries` 读取最近一条 `session/recap` 事件之后的窗口，并按日志顺序为每个合格事件产出一个有界的 `SessionRecapEntry`：完整的人类 `user` 提示、`assistant` 消息的文本块、`tool` 结果（日志仍保留其调用名时一并带上），以及为其他生产者注入给模型的内容生成的 `notice`。条目文本被归一化为一行显示安全文本并由 `maxEntryBytes` 约束。窗口内没有任何条目会产生 `empty` 失败，因此自动路径与显式路径都不可能在没有中间工作的情况下产生第二次回顾。

### 生成

`@deepseek-ai/dsh-session-recap-llm` 注册模型提供方。其配置携带 `targetCharacters`、`maxInputBytes`、`maxOutputTokens`、`timeoutMs`，以及可选的成对 `provider`/`model` 覆盖；没有该对时，调用使用会话已记录的 `request/header` 路由。

`@deepseek-ai/dsh-auxiliary-text-call` 负责这一次有界的一次性调用本身：在记录或派发之前按 `maxInputBytes` 度量封装后的输入，在消费流期间与流结束后应用时限与调用方取消，映射终止结束原因，拒绝工具调用块，并冻结交给 `ctx.llm.stream()` 的请求。`@deepseek-ai/dsh-session-title-llm` 委托给同一个辅助包，因此两个辅助功能共享同一套请求策略。

摘要选择保留窗口的第一个条目，使回顾保留开启该窗口的那条提示，然后在输入预算内从尾部补充条目。提供方在派发前记录 `session/recap-llm-request`：提供方身份、它所代表的摘要 seq、路由、系统提示、精确封装后的用户提示，以及输出 token 上限。该记录即使生成随后失败也固定了模型当时被要求的内容。

辅助消息使用既有的 `user` 消息来源，且记录存储的是封装后的提示文本而不是 `Message[]`。新增 `MessageSourceMap` 变体会改变持久化在四个既有事件根内部的 `MessageSource` 联合，从而为一个任何模型请求都读不到的回顾强制提升 Session writer 版本。

### 触发

`@deepseek-ai/dsh-session-recap-idle-llm` 是一个函数插件，负责注册提供方并掌管自动节奏。它在 `turn/end` 报告 `completed` 时启动计时器，在 `turn/start` 或会话释放时清除计时器，并在计时器触发且已记录回合数不少于 `minTurns` 时生成。服务的 `empty` 与 `unavailable` 失败是静默的；其他失败记录为警告。释放会清除每个计时器。

按需生成由 `@deepseek-ai/dsh-command-recap` 提供：一个注册在 `ctx.commands` 上的 `/recap` 命令，把各类预期失败报告为人类文本。命令只能通过调用它的交互式适配器到达 agent，因此例程、webhook、定时提示或程序驱动的回合都无法请求回顾，回顾也刻意不作为模型工具暴露。

### 客户端呈现

`ui-chat` 注册 `recap` 会话节点与 `RecapItem` 行，跟随 compaction 标记的做法：每条被接受的 `session/recap` 事件一行独立记录，按 seq 作为键并锚定，显示生成的句子，并可展开查看覆盖的回合范围与 provider 或 provider+model 路由。每个标签与分隔符都由 locale 拥有；回顾文本是模型输出。该行是持久的，位于它所覆盖的回合之后，而不是在用户回来时短暂浮出，因此能在重新加载后保留、能用于几天后才打开的会话，且不需要客户端本地“已读”状态。

### 信任、成本与共享原语

一次自动回顾在每个空闲时段只需一次有界的辅助调用：窗口由 `maxInputBytes` 限定、输出很短、生成以取代而非排队的方式处理，且第二次回顾无法覆盖空窗口。在 DeepSeek 适配器中，共享调用会为 `session-recap` 关闭推理，正如它对 `session-title` 所做的那样。

这个家族本会复制的两种写法改为被抽取而非重复，重复检测门也未再发现克隆：显示安全文本的清洗与 UTF-8 字节约束移到 [`@deepseek-ai/dsh-display-text`](../../../../packages/util/display-text/README.zh.md)，由 `dsh-session-title` 与 `dsh-session-recap` 共用；注销前先排空的命令生命周期成为 [`registerDrainedCommand`](../../../../packages/interaction/commands/README.zh.md)，由 `command-compact` 与 `command-recap` 共同调用。

### 持久化与打包

`session/recap` 与 `session/recap-llm-request` 都是增量的仅写入日志的根。它们按 required-on-read 处理而非 `ignorable`，与 `session/title` 的先例一致，因此不了解它们的构建会拒绝含回顾的日志；该变更记录在 [`docs/persistence-changes/2026-10-07-session-recap.md`](../../../../docs/persistence-changes/2026-10-07-session-recap.zh.md) 中，且不需要提升 writer 版本。生成的持久化目录、配置目录、Cordis 目录、`known-event-types.ts` 与持久化 schema 均已重新生成。

随附的 `dsh` base 以显式上限挂载回顾服务，且只有 `web` bundle 挂载空闲 provider 与 `/recap` 命令，因此 headless、SDK 与 ACP profile 不付出任何成本，也不暴露任何命令。

## 考虑过的替代方案

**只在回来时短暂浮出的浮层。** 这与 Claude Code 的呈现一致，但它需要客户端本地的“已读”状态、为自动触发新增一条浏览器可见性路径，而且对从目录重新打开的会话什么都显示不出来——而那恰恰是 DSH 会话的常见情形。如果持久行被实测证明会污染 transcript，再重新引入。

**聚焦时在客户端生成。** 触发更简单，但会把模型调用放到用户回来的关键路径上，完全无法在后台生成，而且只会存在于某个浏览器里而不是会话日志里。否决。

**复用 `session/title`。** 标题是从人类提示派生、用于列表行的短标签；回顾记述的是一个窗口内助手与工具的工作，且在会话内部被阅读。让一个服务承载两种含义会合并两套节奏、两套长度策略与两套评审面。否决。

**复用 compaction 摘要。** compaction 摘要的存在意义是为模型替换历史，以数千 token 计，与表面替换和提示词缓存记账耦合，且只在出现压力后才存在。回顾面向用户、很短、从不替换任何东西，且必须在从不压缩的会话中也存在。否决。

**把回顾暴露为模型工具。** 模型因此可以请求回顾，但信任规则的存在正是为了不让自动化或转发的输入触发它，而且模型可见的回顾还会进入请求前缀与其缓存记账。否决。

**确定性兜底回顾。** 便宜，但它产出的是回合计数而不是对工作的记述；一条总是出现但很弱的回顾比诚实的缺席更糟。否决；`/recap` 报告未配置生成器。

**为冷会话提供投射单元。** 初版设计注册一个 `recap` 投射，使目录行无需加载窗口即可读取最近回顾。v1 没有任何消费者需要它——transcript 行从事件流派生——因此没有以投机方式交付，日后出现消费者时再补理由。

**按时间而非按上次回顾选择覆盖窗口。** 基于时间的窗口需要在日志里保存时钟状态，并会产生重叠与空档；自上次回顾以来的窗口恰好就是用户要问的问题，且仅凭日志即可推出。否决。

**扩展 `MessageSourceMap` 并提升 Session writer 版本。** 否决：回顾对每个模型请求都不可见，为一个没有任何消费者可见收益的功能去改动持久化在四个既有事件根中的联合并强制格式版本，代价不成比例。

相关工作：[可回溯压缩](../../proposed/feature/2026-07-06-recallable-compaction.zh.md)重新组织模型保留什么，其摊销草拟是空闲期生成的模型侧对应物。[插件拥有的消息投射](../architecture/2026-09-11-plugin-owned-message-projections.zh.md)管辖会改变内容的事件；回顾仅写入日志，不需要解释器。

## 后果

- 回到会话的用户会得到一句持久的话，覆盖他错过的那些工作；`/recap` 请求按需产出同一种产物。
- 格式中新增两个仅写入日志的事件根。早于它们的构建会拒绝含回顾的日志，直到升级为止；这是沿用 `session/title` 先例、而不是为一个功能事件发明 `ignorable` 策略所接受的代价。
- 自动生成在满足 `minTurns` 且有新工作的会话中，每个空闲时段只付一次小调用；没有客户端表面的 profile 既挂载提供方也不挂载命令。
- 摘要选择器是日后放宽覆盖范围的唯一位置；它会略去归一化后为空的注入内容，并约束每个条目，因此一条回顾不会被单个工具结果主导。
- 共享的 `dsh-display-text`、`dsh-auxiliary-text-call` 与 `registerDrainedCommand` 现在承载了两个功能各自都需要的行为，因此第三个标注类功能可以复用而不是再次复制。
- 测试把能力缝钉在逐文件 100% 覆盖上，用假计时器钉住空闲节奏与取消，钉住命令的预期失败映射与真实 Loader 组合，并钉住客户端行的单回合、范围、仅 provider 与带模型路由四种呈现。

## 暂缓事项

- `recap` 投射单元以及目录行或侧栏呈现，待出现消费者后再说。
- 把 `/recap` 的命令结算折叠进它产出的那一行；当前命令结算与行都会渲染，若实测证明嘈杂，验收评审应重新考虑。
- 若无人值守会话的成本超出当前“每空闲时段一次调用”的界，就把自动节奏限定在有客户端连接但未聚焦时。
- 录制一个包含 `session/recap` 事件的无密钥会话快照；目前还没有录制夹具在装配后的 Web 输出中覆盖该行。
