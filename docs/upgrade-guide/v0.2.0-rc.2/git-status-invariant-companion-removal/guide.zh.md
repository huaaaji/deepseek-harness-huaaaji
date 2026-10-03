---
kind: upgrade-guide
description: "两个 git-status 插件不再发布 ./invariant 入口，导入该入口的消费者必须删除该导入。"
---

# git-status 包移除其不变量伴侣

[English](guide.md) | 中文

## 变更

在 v0.2.0-rc.2 中，`@deepseek-ai/dsh-host-git-status` 与 `@deepseek-ai/dsh-client-ui-git-status` 各自发布了一个 `./invariant` 入口。其伴侣向宿主不变量服务登记包归属，但没有任何检查：每份快照都直接由 git 输出投影而来，小部件的可变状态位于浏览器进程内。

下一个版本会从这两个包中移除 `./invariant`、其 `src/invariant.ts`、已发布的 `lib/invariant.js`，以及对 `@deepseek-ai/dsh-invariants` 的依赖。任何导入 `@deepseek-ai/dsh-host-git-status/invariant` 或 `@deepseek-ai/dsh-client-ui-git-status/invariant` 的代码将无法解析该说明符。把这两个包作为插件加载不受影响：两者保留各自的入口，`gitStatus` 服务保留其六个 Remote，侧边栏小部件保留其插槽。

同一版本不再把这些包的浏览器与类型关系声明为 `peerDependencies`；这些关系现在只存在于 `devDependencies`。消费者不再需要满足诸如 `@deepseek-ai/dsh-api-remotes` 或 `react` 之类的 peer，强制 peer 范围的包管理器也不再报告其缺失。

## 迁移

1. 删除所有对 `@deepseek-ai/dsh-host-git-status/invariant` 与 `@deepseek-ai/dsh-client-ui-git-status/invariant` 的导入。该伴侣没有断言任何内容，因此不会损失覆盖。
2. 删除任何挂载这些伴侣的组合行；宿主不变量服务不再列出这两个包名。
3. 保留这两个包本身：没有包被重命名，没有源文件被移动，也没有配置键发生变化。
4. 确认：导入任一 `/invariant` 说明符会以模块未找到错误失败，导入包根仍然可解析，并且 Web profile 仍能渲染 git 小部件。
