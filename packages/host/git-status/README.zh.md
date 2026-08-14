# @deepseek-ai/dsh-host-git-status

[English](README.md) | 中文

面向 Web GUI 的只读工作区快照 Remote。`GitStatusGateway` 注册 `gitStatus` 服务并发布一个生成的直接 Remote，即 `gitStatus/status`。每次调用在指定目录运行 git CLI，将 porcelain-v2 分支头信息、逐文件变更条目与 HEAD 摘要投影为一份不可变快照。

快照从不抛出异常：git 缺失、目录不是仓库、仓库卡死（强制 15 秒超时）或任何其他 git 失败都会以结构化的 `failure` 字段连同空默认状态返回，GUI 因此可以渲染稳定的控件而不是错误页。路径解析关闭了 `core.quotepath`，非 ASCII 与含空格路径按原样解析。公开载荷类型位于 `./types` 下，Typert 生成的 Host 与 Client Remote 产物由 `./typert` 与 `./remote` 暴露。

该服务仅 Remote 且刻意不声明同进程 Cordis `Context` 合并。Client 包通过显式的 [`api-remotes`](../../api/remotes/README.md) 装配使用它，而不是导入 Host 实现。

## Model Experience

None, as this Host-only status projection registers no prompt, tool, message, or provider request.

#### KV Cache effect

None; this package never assembles model input.

## Known Limitations and Deferred Work

- **仅即时状态** —— 每次调用都是全新的 CLI 读取；调用之间没有订阅、差异或缓存历史。
- **无变更能力** —— 该服务不能暂存、提交、stash 或以其他方式改变工作区。
- **依赖 CLI** —— 结果反映主机上可用的 git 二进制与仓库格式；仓库的特殊配置（如 `status.showUntrackedFiles` 覆盖）按 git 本身的报告呈现。
