# @deepseek-ai/dsh-client-ui-git-status

[English](README.md) | 中文

基于 [`gitStatus` Host Remote](../../host/git-status/README.md) 的 Web GUI Git 工作区控件。浏览器半区在 `sidebar.footer.action` 插槽注册一个操作：侧边栏底部的紧凑分支摘要 —— 分支名加变更总数徽标（有冲突时标红）—— 点击打开完整状态弹窗：分支、上游、领先/落后、HEAD 提交、仓库根目录，以及按冲突、已暂存、未暂存、未跟踪分组展示的文件列表。

控件跟随当前工作区：优先使用当前会话所属工作区，其次是最新工作区，最后是第一个注册的工作区。快照在挂载与工作区切换时读取，也可通过弹窗的刷新按钮重新读取；所有失败（git 缺失、非仓库、超时）都会渲染为稳定的内联状态，而不会破坏侧边栏。

浏览器半区是纯界面贡献：node 半区提供空的 `apply` 使 Loader 行存在，所有状态都位于浏览器进程内。文案键位于 `gitStatus` locale 命名空间下。

## Model Experience

None, as this browser-side widget registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **仅即时读取** —— 摘要仅在挂载、工作区切换与手动刷新时更新；没有文件系统监听或轮询。
- **只读界面** —— 控件从不暂存、提交或修改工作区。
- **单一目录目标** —— 控件只报告当前工作区目录；嵌套或上层的仓库按 git 本身的解析呈现。
