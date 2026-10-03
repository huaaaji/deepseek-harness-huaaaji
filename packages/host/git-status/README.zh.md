---
description: "Web GUI git 小部件背后的 Host git Remote：基于主机自带 git CLI 的工作区快照、分页历史、提交详情、文件差异、分支检出与新建，并提供可配置的读取上限。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-host-git-status

[English](README.md) | 中文

## 概述

`dsh-host-git-status` 用主机自带的 git CLI 回答 Web GUI 的 git 读取：它先发现工作区所持有的仓库 —— 工作区自身，或克隆在其中的仓库 —— 再提供该仓库的工作区快照、分页历史、提交元数据与逐文件统计、文件两侧内容，以及小部件的两个变更操作。每次读取都是全新调用；缺少 git、目录不是仓库、超时或参数被拒都会返回结构化 `failure` 而非 RPC 错误，因此小部件始终保有稳定的摘要。可配置读取上限、发现深度，以及发现过程跳过的目录。

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

在 Web 组合中挂载该行；浏览器半区（[ui-git-status](../../extensions/ui-git-status/README.zh.md)）通过显式的 [`api-remotes`](../../api/remotes/README.zh.md) 装配消费这六个生成的 Remote，而不是导入本实现。

本包同时也是一个可安装的 profile layer：其 manifest 声明了 `dsh.bundle.patch`，因此 Web 的 Plugins 页（或 `dsh plugin --profile <name> add <spec>`）可以把它安装进 profile。profile 本地的副本优先于应用内置的那一份，部署因此无需重新打包应用即可用上本插件的新构建；该 layer 本身不声明任何行，因为随附该插件的组合已经声明了它们。

### 最小配置

```yaml
- id: git-status
  name: '@deepseek-ai/dsh-host-git-status'
  config:
    timeoutMs: 15000
    historyLimit: 500
    diffBytesLimit: 65536
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `timeoutMs` | `15000` | 单次 git 调用的强杀时限，单位毫秒 |
| `historyLimit` | `500` | Remote 接受的最大历史分页；更大的请求会被收敛到该值 |
| `diffBytesLimit` | `65536` | 单次文件差异读取中每一侧的字符预算 |
| `scanDepth` | `1` | 工作区之下发现过程搜索的目录层级数；`0` 跳过发现，`-1` 遍历整棵子树 |
| `scanIgnoredFolders` | `['node_modules']` | 发现过程永不进入的子目录名，按名称精确匹配 |

省略 `config` 即保留这些默认值。

### Remote 列表

- `gitStatus/status` —— porcelain-v2 工作区快照：分支头、逐文件条目与 HEAD 摘要。
- `gitStatus/repositories` —— 某个目录处及其之下的仓库：先是外层仓库，随后是 `scanDepth` 范围内的子目录仓库，并按根去重。
- `gitStatus/history` —— 分页提交窗口（新提交在前），带父提交哈希与供图形使用的 `%D` ref 装饰。
- `gitStatus/commitDetails` —— 单个提交的元数据、提交说明正文、变更文件统计，以及包含该提交的本地与远端分支。
- `gitStatus/fileDiff` —— 某个文件在提交处与在首个父提交处的内容；重命名时按旧路径读取父侧。
- `gitStatus/checkout` —— 按名检出分支，或在某个提交处游离 HEAD。
- `gitStatus/createBranch` —— 在某个提交处新建分支但不检出。

### 线上参数校验

每个会进入 git 参数列表的线上字符串都会先被校验：提交标识必须是 7 到 40 位十六进制数字，分支名必须通过 `validBranchName` 中的 ref 格式子集，路径必须非空、相对且不含 NUL。被拒的值会在运行 git 之前返回 `invalid-revision`、`invalid-name` 或 `invalid-path`。若直接透传，git 自己的选项解析就会读到它：`--output=<file>` 会让一次 `fileDiff` 调用写主机文件，`-f` 会让一次 `checkout` 调用丢弃未提交的工作。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 —— 点击展开</summary>

一次快照是两次 `git` 调用（`rev-parse --show-toplevel`，随后 `status --porcelain=v2 --branch`）外加一次 HEAD 摘要读取；提交详情运行四次，文件差异运行两次。同一次请求中相互独立的读取会并发执行。每次调用都在 `LC_ALL=C` 下运行，因为本包会读取 git 的诊断文本以区分路径不存在与对象不可读，并把 git 的第一行 stderr 作为失败信息展示。路径在关闭 `core.quotepath` 的情况下读取，因此非 ASCII 名称按原样到达；git 仍会 C 引号转义的路径保留其转义。stdout 在流上解码，因此跨两个管道分块的多字节字符保持完整；文件差异的一侧在达到 `diffBytesLimit` 时通过杀死子进程停止，而不是把整个 blob 缓冲下来。仓库发现会下探请求目录的子目录 `scanDepth` 层，跳过 `.git` 目录与被配置的名称，并用 `git rev-parse --show-toplevel` 确认每个带 `.git` 条目的候选；外层仓库排在最前，重复的根会合并为一项。已不存在的目录会以 `not-a-repo` 报告并指明该工作目录，因为 git 对缺少二进制与缺少目录返回同一个 errno。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [ui-git-status](../../extensions/ui-git-status/README.zh.md) —— 本 Remote 服务的侧边栏小部件、状态弹窗、历史图形与差异界面。
- [api-remotes](../../api/remotes/README.zh.md) —— 把这些方法带到浏览器的 Client 装配。

-----

<a id="model-experience"></a>
## 模型体验

None, as this Host-only status projection registers no prompt, tool, message, or provider request.

#### KV Cache 影响

None; this package never assembles model input.

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明了本 Remote 在哪些情况下并不合适。它们是当前包的约束，而不是任务清单。

- **仅即时状态** —— 每次调用都是全新的 CLI 读取；调用之间没有订阅、差异或缓存历史。
- **变更能力最小** —— 仅检出与新建分支；暂存、提交、stash、merge、rebase 以及其他 Git Graph 操作不在范围内。
- **以首个父提交为基准的差异** —— 合并提交的文件差异以首个父提交为基准，与 Git Graph 的默认行为一致，因此合并冲突的解决只会显示相对该父提交的改动。
- **依赖 CLI** —— 结果反映主机上可用的 git 二进制与仓库格式；仓库的特殊配置按 git 本身的报告呈现。
- **被引号转义的路径保持转义** —— porcelain 读取未使用 `-z`，因此名称中含引号、反斜杠或控制字符的路径会带着 git 的 C 引号转义到达小部件；文件行会按该转义拼写渲染，但打开其差异时找不到该路径，两侧都没有文本。
- **历史按拓扑序排列** —— 窗口保证父提交出现在子提交之后，并让每条分支保持在自己的行上；因此单页内的顺序不一定按提交日期排列。
- **发现受深度与名称精确匹配限制** —— 遍历只下探 `scanDepth` 层，并按名称精确跳过被忽略的目录，因此比配置深度更深的仓库，或位于忽略列表未写出的名称之下的仓库不会被发现；裸仓库目录没有可供 `--show-toplevel` 报告的工作树。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>面向维护者的工作上下文 —— 点击展开</summary>

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`Config` 模式、Remote 服务、线上参数校验与各读取投影 |
| [`src/git.ts`](src/git.ts) | git 运行器（超时、输出预算、区域设置、流解码）与 porcelain-v2 解析器 |
| [`src/discover.ts`](src/discover.ts) | 产生候选仓库目录的有界子目录遍历 |
| [`src/history.ts`](src/history.ts) | 日志/numstat/分支解析，以及分支名、提交标识与路径校验器 |
| [`src/types.ts`](src/types.ts) | 通过 `./types` 导出的公开线上类型 |
| — | 未发布不变量伴侣（invariant companion），因为每份快照都直接由 git 输出投影而来，本包不持有可关联的运行时状态。 |

</details>
