# @deepseek-ai/dsh-client-ui-file-viewer

[English](README.md) | 中文

Web GUI 文件查看器的浏览器侧。它贡献一个侧栏脚部动作（`sidebar.footer.action` 的 `file-viewer` 条目），打开注册在 `shell.overlay` 下的右对齐抽屉。抽屉通过 `fileViewer` Host Remote 浏览工作区目录并就地渲染文件：

- 代码与文本文件渲染为带行号、语法高亮的视图（[`ReadBlock`](../../client/ui-primitives/README.md)），复用共享的 Shiki 高亮器；
- Markdown（`md`/`markdown`/`mdx`）通过 [`MarkdownText`](../../client/ui-primitives/README.md) 渲染。

抽屉与脚部动作共享一个 store 句柄（在 `apply` 中创建），因此动作的 open 写入与抽屉的读取指向同一实例。浏览器初始目录依次取当前会话的工作区、最近工作区、第一个已注册工作区；每次目录读取与文件读取都是全新的 `fileViewer` Remote 调用，读取失败渲染稳定的状态提示而非报错屏。

## Model Experience

None，因为此浏览器侧抽屉在 Web GUI 中渲染文件内容，不注册任何面向模型的内容。

#### KV Cache effect

None；此包从不组装模型输入。

## Known Limitations and Deferred Work

- **尚未接入对话内打开** — 点击工具结果或 turn tail 中的文件路径仍会调用宿主机系统应用打开；把这些 `openFile` 调用路由进本抽屉是跨 `ui-conversation` 的后续工作。
- **单栏浏览** — 抽屉一次只列出一个目录；没有分栏树，也没有文件内搜索。
- **无焦点陷阱** — 抽屉是互补区域而非模态对话框；打开时不捕获键盘焦点。
