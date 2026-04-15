# Runtime 文件拆分计划

worktree: `.worktrees/event-bus`（branch=dev）

## 背景

CLAUDE.md 明确规定 **单文件不得超过 800 行**。事件总线重构后，下列两个文件严重超限：

| 文件 | 当前行数 | 上限 | 超限 | 重构前 baseline |
|---|---|---|---|---|
| `packages/runtime/src/runtime.ts` | 1331 | 800 | +531 | 1024（本次 +307） |
| `packages/runtime/src/engines/deepagents-engine.ts` | 1474 | 800 | +674 | 1054（本次 +420） |

本计划仅做**物理拆分**，不改公共 API、不重写实现、不加新功能。

---

## §1 现状分析

### 1.1 runtime.ts 职责分布

| 区间 | 行数 | 主题 | 关键符号 |
|---|---|---|---|
| 14–48 | 35 | import | - |
| 50–119 | 70 | 公共类型定义 | `CreateSessionOptions` / `RunTurnOptions` / `ResumeRunOptions` / `SessionRuntime` / `SessionRuntimeOptions` / `SessionRuntimeMetadata` / `RunRuntimeMetadata` / `DeepagentsRunWorkflowState` |
| 121–165 | 45 | 内部类型 | `ActiveRun` / `ExecuteRunInput` / `RunExecutionContext` / `AbortSignalScope` / `RunLineageFields` |
| 166–268 | 103 | 工厂 + metadata 读取 | `createSessionRuntime` / `normalizeSessionRuntimeOptions` / `resolveDeepagentsModel` / `readSessionRuntimeMetadata` / `readRunRuntimeMetadata` / `readDeepagentsRunWorkflowState` |
| 270–486 | 217 | `SessionRuntimeImpl` 构造 + 公共方法 | `constructor` / `createSession` / `closeSession` / `getSessionSnapshot` / `getRunSnapshot` / `runTurn` / `resumeRun` / `streamEvents` / `cancelRun` |
| 488–793 | 306 | `SessionRuntimeImpl` 运行生命周期 | `startRun` / `executeRun` / `handleRunSuccess` / `handleHitlInterrupt` / `handleRunCompletion` / `handleRunCancellation` / `handleRunFailure` |
| 795–989 | 195 | `SessionRuntimeImpl` 辅助（turn + 日志 + 必读快照） | `executeDeepagentsTurn` / `requireSessionSnapshot` / `requireRunSnapshot` / `logRunLifecycle` / `logToolEvent` / `logMessageEvent` |
| 992–1081 | 90 | 通用工具函数 | `createRunLineageFields` / `normalizeToolCatalog` / `isToolCatalog` / `isRecord` / `isDeepagentsInterruptRecord` / `createAbortSignalScope` |
| 1083–1118 | 36 | 错误归一化 + 副作用判断 | `toError` / `toTianjiError` / `isAbortError` / `isCancellationError` / `hasSideEffect` |
| 1120–1253 | 134 | metadata 读写 | `mergeMetadata` / `cloneMetadata` / `ensureSessionOpen` / `ensureSessionEngineMatches` / `ensureRunEngineMatches` / `readRuntimeMetadataRecord` / `readRuntimeEngine` / `readRequestedEngine` / `writeSessionRuntimeMetadata` / `writeRunRuntimeMetadata` / `writeDeepagentsRunWorkflowState` / `readStoredSystemPrompt` / `readStoredGenerationConfig` |
| 1267–1331 | 65 | deepagents 配置守卫 + usage 读取 | `hasConfiguredDeepagentsModel` / `hasInterruptConfiguration` / `hasConfiguredDeepagentsCheckpointer` / `readTokenUsage` |

### 1.2 deepagents-engine.ts 职责分布

| 区间 | 行数 | 主题 | 关键符号 |
|---|---|---|---|
| 13–43 | 31 | import | - |
| 45–121 | 77 | 类型定义 | `DeepagentsPendingToolCall` / `ExecuteDeepagentsRunOptions` / `DeepAgentFactory` / `DeepagentsAgentEvent` / `DeepagentsAgentInstance` / `DeepagentsInterruptRecord` / `DeepagentsRunResult` / `AbortSignalScope` / `StreamLoopState` |
| 123–174 | 52 | 流事件处理（stream） | `isLangGraphChainEnd` / `processChatModelStreamEvent` |
| 176–275 | 100 | 流事件处理（end / chain） | `readUsageMetadata` / `processChatModelEndEvent` / `processChainEndEvent` |
| 277–380 | 104 | 流事件处理（tool / dispatch） | `processToolStartEvent` / `processToolEndEvent` / `dispatchStreamEvent` |
| 382–513 | 132 | 主入口 | `executeDeepagentsRun` |
| 515–608 | 94 | 输入 / 状态快照读取 | `readDeepagentsInput` / `maybeReadDeepagentsStateSnapshot` / `readDeepagentsStateMetadata` / `readConfigurableState` / `isDeepagentsInterruptRecord` |
| 610–780 | 171 | 工具调用适配 | `createDeepagentsTools` / `executeDeepagentsToolCall` |
| 782–830 | 49 | 模型观测到的 tool call 合并 | `registerObservedToolCalls` / `resolveToolCallId` |
| 832–897 | 66 | 消息序列化 | `convertAppMessageToDeepagentsMessage` / `serializeDeepagentsMessagePart` / `readDataUriMimeType` |
| 899–976 | 78 | 消息构建 / chunk 解析 | `buildAssistantMessageFromDeepagentsOutput` / `buildAssistantMessage` / `readChunkText` / `readContentBlocks` / `readChunkThinking` |
| 978–1090 | 113 | tool-call chunk 解析 | `readToolCallChunks` / `readToolCalls` / `readObservedToolCalls` / `readChunkKwargs` / `readFinalOutputText` / `parseToolArgs` |
| 1092–1169 | 78 | 通用序列化 / 工具 | `stableSerialize` / `sortJsonKeys` / `isRecord` / `nextSequence` |
| 1171–1268 | 98 | 超时 + 错误 | `executeWithTimeout` / `isCancellationError` / `isAbortError` / `toError` / `resolveToolError` |
| 1270–1315 | 46 | AbortSignal 合成 | `createAbortSignalScope` |
| 1317–1474 | 158 | deepagents 配置解析 + LLM raw 持久化 | `resolveDeepagentsCheckpointer` / `resolveOptionalArray` / `resolveDeepagentsMiddleware` / `buildMiddlewareList` / `persistLlmRaw` / `resolveDeepagentsSubagents` / `resolveDeepagentsStore` / `resolveDeepagentsBackend` / `resolveDeepagentsInterruptOn` / `isPlaceholderConfig` / `hasDeepagentsModel` / `hasConfiguredDeepagentsCheckpointer` |

### 1.3 外部使用面（必须保持 byte-level 兼容）

`packages/runtime/src/index.ts` 从 `runtime.ts` 再导出的符号是外部**唯一**合法接口：

| 符号 | 类别 | 外部使用方（抽样） |
|---|---|---|
| `createSessionRuntime` | 函数 | apps/node, apps/controlplane, packages/agent, 多个测试 |
| `SessionRuntime` | 类型 | packages/agent/session.ts, 测试 |
| `SessionRuntimeOptions` | 类型 | packages/agent |
| `SessionRuntimeDeepagentsConfig` | 类型 | packages/agent |
| `SessionRuntimeEngine` / `SessionRuntimeMetadata` / `RunRuntimeMetadata` | 类型 | 部分测试 |
| `CreateSessionOptions` / `RunTurnOptions` / `ResumeRunOptions` | 类型 | 部分测试 |
| `DeepagentsInterruptRecord` / `DeepagentsRunWorkflowState` | 类型 | 运行时内部 + 测试 |
| `RuntimeProviderConfig` | 类型 re-export | apps |
| `ObserverLogger` | 类型 re-export | packages/agent |
| `readDeepagentsRunWorkflowState` / `readRunRuntimeMetadata` / `readSessionRuntimeMetadata` | 函数 | `__tests__` 内部（未跨包） |

`deepagents-engine.ts` **不通过 index.ts 对外导出**，只被 `runtime.ts` 使用。其外部可见符号仅有：`executeDeepagentsRun`、`DeepagentsRunResult`。

`__tests__` 下会对 `../runtime.js` 做深路径 import（见 `legacy-snapshot-compat.test.ts`、`runtime-engine-selection.test.ts`、`runtime-deepagents-bootstrap.test.ts` 等），这些路径必须保留，因此 `runtime.ts` 必须作为 re-export barrel 保留。

---

## §2 拆分方案

### 2.1 runtime.ts 切分（按关注点拆分，保留 barrel）

| 新文件 | 职责 | 预估行数 | 迁出符号 |
|---|---|---|---|
| `src/runtime/types.ts` | 所有公共 + 内部类型定义 | 约 120 | 表 1.1 区间 50–165 的全部类型 |
| `src/runtime/metadata.ts` | session/run metadata 读写 + engine 守卫 + usage 读取 | 约 220 | 1120–1253 + 1267–1331 + 211–268（metadata 读函数）+ `readRequestedEngine` |
| `src/runtime/helpers.ts` | abort signal / 错误归一化 / lineage / toolCatalog 归一化 / 副作用判断 / isRecord / isDeepagentsInterruptRecord | 约 180 | 992–1118 段 |
| `src/runtime/session-runtime.ts` | `SessionRuntimeImpl` 类 + `createSessionRuntime` + `normalizeSessionRuntimeOptions` + `resolveDeepagentsModel` | 约 550（仍超 800? 见下） | 166–209 + 270–989 |
| `src/runtime.ts`（保留） | **barrel**：`export * from './runtime/*'`，维持 `../runtime.js` 深路径 import 兼容 | 约 40 | 仅 re-export |

**关于 session-runtime.ts ≈ 550 行**：类本身 700+ 行，扣掉已迁走的类型/helpers/日志函数后接近 520。为确保 <800，将生命周期处理器单独抽一层：

| 追加文件 | 职责 | 预估行数 | 迁出符号 |
|---|---|---|---|
| `src/runtime/run-lifecycle.ts` | `handleRunSuccess` / `handleHitlInterrupt` / `handleRunCompletion` / `handleRunCancellation` / `handleRunFailure` / `logRunLifecycle` / `logToolEvent` / `logMessageEvent` 作为纯函数，接收 `{ snapshotStore, logger, engine }` 依赖 | 约 310 | 575–793 + 891–989 |

最终 `session-runtime.ts` 只保留类的公共方法 + `startRun` + `executeRun` + `executeDeepagentsTurn` + 私有 require*，预估 ≈ 360 行。

### 2.2 deepagents-engine.ts 切分（按执行阶段拆分）

| 新文件 | 职责 | 预估行数 | 迁出符号 |
|---|---|---|---|
| `src/engines/deepagents/types.ts` | 所有内部类型 | 约 90 | 45–121 |
| `src/engines/deepagents/stream-handlers.ts` | 流事件分发 + 各 processXxxEvent + usage 解析 | 约 280 | 123–380 |
| `src/engines/deepagents/tool-adapter.ts` | createDeepagentsTools + executeDeepagentsToolCall + registerObservedToolCalls + resolveToolCallId + executeWithTimeout + resolveToolError | 约 380 | 610–830 + 1171–1268 |
| `src/engines/deepagents/message-serialization.ts` | AppMessage 互转 + chunk 解析 + assistant 消息构建 | 约 260 | 832–1090 |
| `src/engines/deepagents/state-readers.ts` | readDeepagentsInput + maybeReadDeepagentsStateSnapshot + readDeepagentsStateMetadata + readConfigurableState + isDeepagentsInterruptRecord | 约 100 | 515–608 |
| `src/engines/deepagents/config-resolvers.ts` | 所有 resolveDeepagentsXxx + buildMiddlewareList + isPlaceholderConfig + hasDeepagentsModel + hasConfiguredDeepagentsCheckpointer + persistLlmRaw | 约 180 | 1317–1474 |
| `src/engines/deepagents/helpers.ts` | stableSerialize / sortJsonKeys / isRecord / nextSequence / createAbortSignalScope / isCancellationError / isAbortError / toError | 约 170 | 1092–1169 + 1270–1315 |
| `src/engines/deepagents-engine.ts`（保留） | **barrel + 主入口 `executeDeepagentsRun`**。只包含 382–513 的主函数以及 re-export `DeepagentsRunResult` | 约 160 | 382–513 |

### 2.3 公共类型与内部 helper 归属原则

| 类型 | 是否 export 出 index.ts | 归属 |
|---|---|---|
| 任何被 `index.ts` re-export 的类型 | 是 | `runtime/types.ts`，并被 `runtime.ts` barrel 转发 |
| `ActiveRun` / `ExecuteRunInput` / `RunExecutionContext` / `RunLineageFields` | 否 | `runtime/types.ts` 但只对 runtime 子模块可见 |
| `DeepagentsPendingToolCall` / `StreamLoopState` / `DeepagentsAgentEvent` 等 | 否 | `engines/deepagents/types.ts` |
| 同名重复的 helper（两个文件都有 `isRecord` / `createAbortSignalScope` / `toError` / `isAbortError` / `isCancellationError` / `isDeepagentsInterruptRecord`） | 否 | 保持各自子目录独立副本，**不做跨目录抽共享**（避免因"顺带改"扩大改动面）；可在后续独立 PR 统一 |

---

## §3 风险与边界

### 3.1 跨模块状态所有者

| 状态 | 所有者 | 拆分后仍由谁持有 |
|---|---|---|
| `activeRuns` / `eventStreams` Map | `SessionRuntimeImpl` | 不变 |
| `snapshotStore` | `SessionRuntimeImpl` | 不变；`run-lifecycle.ts` 通过入参传入而非持有 |
| `toolCatalog` | `SessionRuntimeImpl` | 不变 |
| `pendingOperations` / `destructiveOperationIds` | `RunExecutionContext`（per-run） | 不变 |
| `observedToolCalls` / `turnMessages` / `StreamLoopState` | `executeDeepagentsRun` 闭包 | 不变，拆分后仍在 `executeDeepagentsRun` 主函数中构造并通过参数传递 |

### 3.2 循环依赖风险

| 风险点 | 缓解 |
|---|---|
| `runtime/session-runtime.ts` → `runtime/run-lifecycle.ts` → 又回到 session impl？ | run-lifecycle 只接收 `ActiveRun` + `RunSnapshot` + 依赖对象，**不反向 import session-runtime** |
| `runtime/metadata.ts` 被 `session-runtime.ts` 和 `run-lifecycle.ts` 同时引用 | 无循环：metadata 是叶子 |
| `engines/deepagents/stream-handlers.ts` 需要调用 `message-serialization.ts` 的 `buildAssistantMessageFromDeepagentsOutput` | 单向依赖，允许 |
| `tool-adapter.ts` 依赖 `helpers.ts` 的 `createAbortSignalScope` / `isCancellationError` | 单向依赖，允许 |

### 3.3 现有测试影响

`packages/runtime/src/__tests__/` 中的深路径 import：

| 测试文件 | import 路径 | 拆分后 |
|---|---|---|
| `legacy-snapshot-compat.test.ts` | `../runtime.js` | barrel 保留，不受影响 |
| `runtime-cancel-resume.test.ts` | `../runtime.js` | 同上 |
| `runtime-engine-selection.test.ts` | `../runtime.js` | 同上 |
| `runtime-deepagents-bootstrap.test.ts` | `../runtime.js` | 同上 |
| `suite/checkpoint-resume.test.ts` | `../../runtime.js` | 同上 |
| `helpers/runtime-test-utils.ts` | `../../runtime.js` | 同上 |
| `runtime-public-api.test.ts` | 断言 re-export 列表 | 必须 100% 一致 |

**结论**：只要 barrel `runtime.ts` 和 `engines/deepagents-engine.ts` 保留原路径 + 原全部符号 re-export，**测试不需要任何修改**。

---

## §4 执行步骤（subagent-driven）

共 2 个 subagent 任务，分别拆 runtime.ts 和 deepagents-engine.ts。每个任务内部按顺序操作，**不并行**（因为要反复搬同一个文件的代码）。

### Task A：拆分 `runtime.ts`

| 步骤 | 动作 | 验证 | commit |
|---|---|---|---|
| A1 | 新建 `src/runtime/` 目录，创建 `types.ts`，搬移表 2.1 指定类型 | `pnpm --filter @tianji/runtime typecheck` | `refactor(runtime): 抽取 runtime 公共/内部类型到 runtime/types.ts` |
| A2 | 创建 `src/runtime/metadata.ts`，搬移 metadata 读写 + engine 守卫 + usage 读取 | `pnpm --filter @tianji/runtime typecheck` | `refactor(runtime): 抽取 metadata 读写到 runtime/metadata.ts` |
| A3 | 创建 `src/runtime/helpers.ts`，搬移通用工具 + 错误归一化 + abort signal | `pnpm --filter @tianji/runtime typecheck` | `refactor(runtime): 抽取通用 helpers 到 runtime/helpers.ts` |
| A4 | 创建 `src/runtime/run-lifecycle.ts`，搬移 handleRunXxx + 日志函数 | `pnpm --filter @tianji/runtime typecheck` | `refactor(runtime): 抽取 run 生命周期处理器到 runtime/run-lifecycle.ts` |
| A5 | 创建 `src/runtime/session-runtime.ts`，搬移 `SessionRuntimeImpl` + 工厂函数 | `pnpm --filter @tianji/runtime typecheck` | `refactor(runtime): 抽取 SessionRuntimeImpl 到 runtime/session-runtime.ts` |
| A6 | 将 `src/runtime.ts` 改为纯 barrel（只保留 `export ... from './runtime/*.js'`），确保与 `index.ts` re-export 列表一一对应 | `pnpm --filter @tianji/runtime test` + `pnpm check` | `refactor(runtime): runtime.ts 转为 barrel re-export 子模块` |

### Task B：拆分 `deepagents-engine.ts`

| 步骤 | 动作 | 验证 | commit |
|---|---|---|---|
| B1 | 新建 `src/engines/deepagents/` 目录，创建 `types.ts` | `pnpm --filter @tianji/runtime typecheck` | `refactor(runtime): 抽取 deepagents 引擎类型到 engines/deepagents/types.ts` |
| B2 | 创建 `helpers.ts`（stableSerialize / abort / 错误等） | typecheck | `refactor(runtime): 抽取 deepagents helpers` |
| B3 | 创建 `message-serialization.ts` | typecheck | `refactor(runtime): 抽取 deepagents 消息序列化` |
| B4 | 创建 `stream-handlers.ts`（流事件 dispatch + process*） | typecheck | `refactor(runtime): 抽取 deepagents 流事件处理` |
| B5 | 创建 `state-readers.ts` | typecheck | `refactor(runtime): 抽取 deepagents 状态读取` |
| B6 | 创建 `config-resolvers.ts` | typecheck | `refactor(runtime): 抽取 deepagents 配置解析` |
| B7 | 创建 `tool-adapter.ts`（createDeepagentsTools + executeDeepagentsToolCall + executeWithTimeout） | typecheck | `refactor(runtime): 抽取 deepagents 工具适配层` |
| B8 | `deepagents-engine.ts` 精简为只含 `executeDeepagentsRun` 主函数 + re-export `DeepagentsRunResult` | `pnpm --filter @tianji/runtime test` + `pnpm check` | `refactor(runtime): deepagents-engine.ts 精简为主入口` |

### 整体收尾

| 命令 | 目的 |
|---|---|
| `pnpm --filter @tianji/runtime test` | 全量测试通过 |
| `pnpm check` | lint + typecheck + build 零错误零警告 |
| `wc -l packages/runtime/src/runtime.ts packages/runtime/src/engines/deepagents-engine.ts packages/runtime/src/runtime/*.ts packages/runtime/src/engines/deepagents/*.ts` | 确认每个文件 < 800 |

---

## §5 不做什么

以下事项本次 PR **明确不做**：

| 不做项 | 原因 |
|---|---|
| 重命名任何 export 符号 | 公共 API 必须 byte-level 兼容 |
| 合并两个文件中重复的 helper（`isRecord` / `createAbortSignalScope` / `toError` / `isCancellationError` / `isAbortError` / `isDeepagentsInterruptRecord`） | 跨边界抽共享超出拆分范围，留独立 PR |
| 修改 `index.ts` 的 export 列表 | 外部消费者直接受影响 |
| 修改 `SessionRuntimeImpl` 的方法签名或字段可见性 | 属于重写 |
| 调整任何业务行为（事件时序、错误码、快照字段） | 非拆分目标 |
| 新增测试 | 纯搬运，旧测试即回归保护 |
| 修改 `__tests__/` 中任何文件 | 同上 |
| 把 `executeDeepagentsRun` 暴露到 `index.ts` | 原本就是内部符号 |
| 触碰 `packages/runtime` 之外的任何包 | 物理拆分边界 |

拆分必须保证：

1. `packages/runtime/src/index.ts` 的 export 列表与**拆分前完全一致**（符号名、类型参数、顺序不强求）。
2. `packages/runtime/src/runtime.ts` 和 `packages/runtime/src/engines/deepagents-engine.ts` **路径保留**，作为 barrel 继续可被 `__tests__/` 深路径 import。
3. 外部快照、事件时序、错误语义零变化。
