# 会话回顾

[English](session-recap.md) | 中文

由 [`@deepseek-ai/dsh-session-recap`](../../packages/session/session-recap) 拥有的持久回顾状态与可选的异步提供方词汇。共享的模型请求辅助包拥有精确的辅助请求记录，空闲节奏提供方负责自动调度。

来源：[`packages/session/session-recap/src/index.ts`](../../packages/session/session-recap/src/index.ts)、[`packages/session/session-recap/src/types.ts`](../../packages/session/session-recap/src/types.ts)

## 持久回顾状态

`SessionRecapProviderId` 标识一次提供方注册，`SessionRecapModelIdentity` 指出一次辅助调用实际使用的精确提供方路由。`SessionRecapSource` 记录产出该文本的已注册提供方，并在生成使用模型时一并记录该路由。

`session/recap` 仅写入日志：它永不进入模型表面或派生历史，也不扩展 `SurfaceEventType`。一条被接受的事件携带归一化后的文本、其来源、生成器实际看到的精确摘要条目 seq，以及这些条目覆盖的闭区间 `SessionRecapTurnRange`。`SessionRecapSnapshot` 补充该事件的 seq 与时间戳；`foldSessionRecap` 是对日志的纯折叠，`ctx.sessionRecap.get()` 从存活或回放的会话中读取最近一条被接受的快照。

## 被覆盖的摘要窗口

`generate()` 覆盖最近一条被接受 `session/recap` 事件之后的窗口，而不是整段历史。它按日志顺序把该窗口收集为有界的 `SessionRecapEntry` 值，并在窗口内没有任何条目时报告 `empty`，因此没有中间工作就不可能产生第二次回顾。

每个条目记录其来源事件 seq、所属回合，以及一种 `SessionRecapEntryKind`：人类 `user` 提示、`assistant` 消息的文本、`tool` 结果（日志仍保留其调用名时一并带上），或其他生产者为模型注入的 `notice`。条目文本被归一化为一行显示安全文本并由服务的 `maxEntryBytes` 约束，被接受的文本则由 `maxBytes` 约束。

## 辅助请求记录

模型提供方在派发前记录 `session/recap-llm-request`：提供方身份、所代表的精确摘要 seq、路由、系统提示、精确封装后的用户提示，以及输出 token 上限。该记录即使生成随后失败也固定了模型当时被要求的内容，而它所代表的摘要选择是日志与所配置输入预算的确定性函数。

## 提供方输入与输出

`ctx.sessionRecap` 接受一个可选的异步提供方。`SessionRecapProviderRequest` 提供存活会话、被覆盖的摘要、其回合范围、会话已记录的路由（存在时），以及用于取代或释放的取消信号。提供方返回提议的文本、它所使用的请求中的精确 seq，以及可选的模型路由；服务随后校验每个 seq 都来自该请求、归一化文本、强制字节上限，然后才追加事件。

更新的请求会取代进行中的请求，释放在替换提供方注册之前中止活动工作。预期失败是带 `unavailable`、`empty` 或 `generation` 码的 `SessionRecapError` 值；取消保持独立并抛出精确的中止原因。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxsessionrecap--sessionrecapservice"></a>

### `ctx.sessionRecap` — `SessionRecapService`

Log-backed recap fold plus asynchronous provider generation.

```ts cordis-catalog
/**
 * Read the latest accepted recap from one live or replayed session.
 * @param session - session whose log is the recap source of truth.
 * @returns latest recap snapshot, or `undefined` before the first recap.
 */
get(session: Session): SessionRecapSnapshot | undefined

/**
 * Generate and accept one recap of the window after the latest accepted
 * recap. A newer request supersedes an in-flight one, whose cancellation
 * stays separate from expected failures.
 * @param session - exact live session to recap.
 * @param signal - optional caller cancellation.
 * @returns the accepted recap snapshot.
 * @throws {SessionRecapError} with `unavailable` when no provider is registered or it is disposing, `empty` when
 * the window holds no digest entry, and `generation` when the provider produced nothing acceptable.
 * @throws {Error} when the session is not live or the service is disposed; an aborted request preserves its exact abort reason.
 */
async generate(session: Session, signal?: AbortSignal): Promise<SessionRecapSnapshot>

/**
 * Register the sole optional recap provider. Disposal aborts its in-flight
 * work before another provider may register.
 * @param provider - provider identity and generation function.
 * @returns exact Cordis effect disposer, which settles after active calls quiesce.
 */
register(provider: SessionRecapProvider): () => Promise<void>
```

Types: [Session](session.zh.md)

Source: [`packages/session/session-recap/src/index.ts`](../../packages/session/session-recap/src/index.ts)
<!-- END GENERATED cordis-surface -->
