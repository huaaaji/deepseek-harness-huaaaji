---
description: "面向客户端渲染界面的显示安全文本原语：移除终端转义与不可见控制字符，并按 UTF-8 字节预算截断。"
kind: "package-library"
---

# @deepseek-ai/dsh-display-text

[English](README.md) | 中文

## 概述

`dsh-display-text` 把不可信文本变成一行终端安全的显示文本。它会移除 OSC、CSI 与短 ESC 序列、C0/C1 控制字符，以及不可见或方向性控制字符，折叠空白，并按 UTF-8 字节预算截断结果，且不会切断 Unicode 码点。它是一个**库，而非服务**：不使用 `ctx`，不注册任何内容，也不持有状态。语义仍归调用方所有——会话标题继续施加自己的词数上限，回顾条目继续决定哪些文本值得展示。

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

### 何时使用

当进程之外产生的文本到达人类可读界面、且该界面只渲染一行时，使用本包：生成的标题、回顾行，或任何其他客户端渲染的标签。不要用它改变业务含义；它只移除不可见或控制内容，并施加字节预算。

### 入口

导入与任务匹配的原语，并传入正整数字节预算：

```ts
import {
  normalizeDisplayText,
  sanitizeDisplayText,
  truncateDisplayTextUtf8,
} from '@deepseek-ai/dsh-display-text'

const line = normalizeDisplayText('\u001B[31m  Build failed  \u001B[0m', 80)
const cleaned = sanitizeDisplayText('one\ttwo\nthree')
const bounded = truncateDisplayTextUtf8('你好世界', 7)
```

预算不是正整数时，`truncateDisplayTextUtf8` 抛出异常；`sanitizeDisplayText` 与 `normalizeDisplayText` 不会因文本内容抛出异常。准确的 TypeScript 约定见 [`src/index.ts`](src/index.ts)。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

清洗依次应用五个有序正则表达式：OSC 序列（包括未终止的尾部）、CSI 序列、其余两字节 ESC 序列、非空白 C0/C1 控制字符，以及方向性/不可见控制字符。随后空白折叠为单个空格，并去除首尾空白。

截断逐码点遍历，只在累计 `Buffer.byteLength` 仍处于预算内时加入该码点，并在第一个会越界的码点处停止。因此返回的前缀绝不会切断码点，而小于首码点的预算会得到空字符串。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 清洗正则、按字节截断，以及组合后的规范化函数 |
| [`tests/display-text.spec.ts`](tests/display-text.spec.ts) | 转义、控制字符、空白与字节预算覆盖 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工具包映射](../README.zh.md)——跨包组共享的其他零依赖原语。
- [会话标题](../../session/session-title/README.zh.md)——施加词数上限的标题消费方。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本库只负责移除终端控制字符，并为标题与回顾的消费方限制显示文本。

#### KV Cache 影响

这里不组装任何模型请求，因此不影响提供方缓存复用。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **不按字素簇计量**——字节预算按码点统计 UTF-8 字节，因此组合序列、旗帜与 ZWJ 表情会在码点边界处截断，而不是在用户感知的字符边界处。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
