# @deepseek-ai/dsh-host-file-viewer

[English](README.md) | 中文

面向 Web GUI 文件查看器的只读文件/目录 Remote。`FileViewerGateway` 注册 `fileViewer` 服务并发布两个生成的直接 Remote：

- `fileViewer/list` — 某个目录的直接子项（文件与目录，特殊条目被剔除），按后端名称排序，上限可配置 `maxEntries`（默认 1000），超限时置 `truncated`；
- `fileViewer/read` — 某个文件作为有界、带行号的文本窗口（1 起始偏移，可配置 `maxLines`/`maxLineLength`/`maxBytes`；默认 2000 行、单行 2000 字符、每窗口 50 KB），并返回 `totalLines`、`truncatedByBytes`、`binary` 以及用于语法高亮的文件扩展名 `language` 提示。

读取走注入的 `ctx.fs`（`resolve`/`stat`/`listDir`/`readText`/`streamText`），因此共享的文件系统沙箱与观察策略照常生效，读取穿透沙箱护栏。任何方法都不抛错：路径不存在、目标非目录/非普通文件、二进制文件（`FS_NOT_TEXT`）、超限或其它文件系统失败，都以结构化的 `failure` 字段伴随空默认状态返回，使 GUI 渲染稳定界面而非报错屏。二进制文件是成功的领域结果（`binary: true`、空窗口），而不是失败。

该服务仅作为 Remote，刻意不声明同进程 Cordis `Context` 合并。客户端包通过显式的 [`api-remotes`](../../api/remotes/README.md) 组装来消费它，而不是导入 Host 实现。

## Configuration

每个边界都是可在 `cordis.yml` 中修改的、经过校验的 `Config` 字段（正整数；非法值在加载时失败）。默认值：

| 键 | 默认值 | 含义 |
|---|---|---|
| `maxEntries` | 1000 | 一次 `list` 返回的目录子项数 |
| `maxLines` | 2000 | 一次 `read` 返回的行数 |
| `maxLineLength` | 2000 | 单行返回的字符数 |
| `maxBytes` | 51200 | 一个窗口各行的字节数 |
| `streamMinSize` | 10485760 | 达到或超过此大小即流式读取的文件大小 |

## Model Experience

None，因为此 Host 侧只读投影不注册任何 prompt、工具、消息或 provider 请求。

#### KV Cache effect

None；此包从不组装模型输入。

## Known Limitations and Deferred Work

- **仅瞬时读取** — 每次调用都是对 `ctx.fs` 的全新读取；调用之间没有订阅、缓存或监听。
- **不搜索、不写入** — 查看器严格只读；文件内搜索、跨文件搜索与任何修改都不在范围内。
- **窗口而非整文件** — `read` 返回有界窗口，因此超过字节上限的文件只显示头部并报告 `truncatedByBytes`，而不是完整内容。
