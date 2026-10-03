---
description: "Web GUI 的 git 界面：侧边栏底部带工作区弹窗的分支摘要，以及包含提交图、逐文件差异、搜索、检出与新建分支的历史标签页。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-client-ui-git-status

[English](README.md) | 中文

## 概述

`dsh-client-ui-git-status` 把工作区与提交历史放进侧边栏底部。底栏显示当前分支和变更总数徽标，存在冲突时标红；点击打开弹窗，其「状态」标签页按冲突、已暂存、未暂存、未跟踪列出文件，「历史」标签页绘制提交图，带 ref 芯片、逐文件差异与搜索。小部件报告工作区所持有的仓库 —— 其自身或克隆在其中的仓库 —— 存在多个时提供选择器，并提供三个操作：检出分支、在某个提交处游离 HEAD、新建分支。所有失败都内联渲染。

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

把本插件与它所读取的 git Host 行一起挂载；浏览器半区在 `sidebar.footer.action` 插槽注册一个操作，node 半区提供空的 `apply` 使 Loader 行存在。

本包同时也是一个可安装的 profile layer：其 manifest 声明了 `dsh.bundle.patch`，因此 Web 的 Plugins 页（或 `dsh plugin --profile <name> add <spec>`）可以把它安装进 profile。profile 本地的副本优先于应用内置的那一份；该 layer 自身不声明任何行，因为随附该小部件的组合已经声明了它们。

### 小部件展示什么

工作区本身不是仓库时，它仍会报告克隆在其中的仓库，因为 Host 会去发现它们；当存在多个仓库时，标签页上方会出现一个选择器，用于切换小部件报告的仓库。「状态」标签页报告分支、上游、领先/落后计数、HEAD 提交、仓库根目录，以及每个展示分组一个区块 —— 同时有暂存与未暂存改动的文件列在已暂存下，与快照的计数一致。「历史」标签页始终以整个已加载窗口作为图形，只隐藏搜索未命中的行，因此可见提交保留完整窗口赋予它的车道与连线；详情面板随后显示提交说明、变更文件统计，以及基于共享代码块的差异。搜索以不区分大小写的方式匹配主题、哈希、作者与 ref 名。提交行与分支芯片可获得焦点并响应 Enter 与 Space，因此同样的选择与检出操作也可用键盘完成。

### Remote 失败

读取与变更都在用户正看着的位置报告各自的失败：历史读取失败会替换列表，加载更多失败显示在列表下方，提交详情或差异读取失败留在详情面板内，被拒绝或失败的变更会在操作按钮上方显示该操作与 git 的信息。刷新会在新快照到达前保持上一份快照在屏幕上，因此侧边栏不会在读取中途退回无数据文案。当工作区中没有任何仓库时，「状态」标签页会说明它搜索了哪个目录、向下检查了几层；而无法执行的仓库发现会报告自己的错误，而不会表现成工作区为空。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 —— 点击展开</summary>

node 半区不持有状态；每次读取都是通过生成的 `gitStatus` Remote 面进行的调用。每个异步读取都携带一个序号，序号已过期的回复会被丢弃，因此较早选择的较慢回复无法覆盖较新的结果。图形布局与摘要是 `src/client/graph.ts` 与 `src/client/model.ts` 中的纯函数，无需 React 即可单元测试；组件只持有视图状态。产品文案位于 `gitStatus` locale 命名空间，两种语言各一份，两个字典必须逐键一致。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [host-git-status](../../host/git-status/README.zh.md) —— 本小部件读取的工作区快照、历史、差异与变更 Remote。
- [Slots reference](../../../docs/subsystems/slots.zh.md) —— 侧边栏贡献如何注册并接收它的属性。

-----

<a id="model-experience"></a>
## 模型体验

None, as this browser-side widget registers no prompt, tool, message, or provider request.

#### KV Cache 影响

None; this package never assembles model input.

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了当前界面的边界。它们是当前包的约束，而不是任务清单。

- **即时读取** —— 视图在挂载、工作区切换、变更操作与手动刷新时更新；没有文件系统监听或轮询。
- **变更能力最小** —— 仅检出与新建分支；暂存、提交、stash、merge、rebase 以及其他 Git Graph 操作不在范围内。
- **仅搜索已加载窗口** —— 搜索框过滤的是已加载的分页，而不是整个仓库；要搜索更早的历史需要先加载更多分页。
- **发现范围限于工作区** —— 小部件报告当前会话所属工作区所持有的仓库 —— 其自身，或位于 Host 扫描深度之内的克隆仓库 —— 没有当前会话时回退到第一个注册的工作区；位于工作区之上的仓库按 git 本身的解析呈现，比扫描深度更深的仓库完全不会被列出。
- **仅文本差异** —— 差异以文本形式渲染文件的两侧；二进制文件只报告其为二进制而不展示字节，超出 Host 读取预算的一侧会渲染为截断。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文 —— 点击展开</summary>

| 文件 | 作用 |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | 插件入口：字典注册与侧边栏插槽贡献 |
| [`src/client/GitStatusAction.tsx`](src/client/GitStatusAction.tsx) | 侧边栏底部摘要、弹窗外壳与状态标签页 |
| [`src/client/GitGraphView.tsx`](src/client/GitGraphView.tsx) | 历史标签页：图形列表、详情面板、差异与操作 |
| [`src/client/graph.ts`](src/client/graph.ts) | 纯图形布局：分支配色、车道、连线路径与行压缩 |
| [`src/client/model.ts`](src/client/model.ts) | 纯状态模型：目标目录、摘要、分组与搜索 |
| — | 未发布不变量伴侣（invariant companion），因为小部件唯一可变的关系是它自己在浏览器进程内的加载状态，宿主不变量服务无法观测。 |

</details>
