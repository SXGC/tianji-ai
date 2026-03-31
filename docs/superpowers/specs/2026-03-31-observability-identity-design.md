# Tianji Observability Identity Design

> **For agentic workers:** 本文档定义 `sessionId`、`runId`、`parentRunId` 的语义与规则。后续日志埋点与事件协议以本文为准。

## 现状

仓库已经有可用的标识基础：

- `@tianji/shared` 中有 `SessionId`、`RunId` 等类型。
- `@tianji/runtime` 以 `runId` 为核心管理执行、事件流、快照与恢复。
- `@tianji/observer` 已提供结构化日志。
- CLI 日志已经落盘 JSONL。

当前真正缺失的只有一件事：**resume/retry 时没有 `parentRunId`，无法区分原始执行和恢复执行。**

其余标识已经存在且工作正常。本文不发明新概念，只收口现有语义并补上缺失的一环。

## 不做什么

- **不引入 `traceId`。** 当前只有 CLI 一个入口，单进程，没有跨服务链路。`runId` 就是日志 grep 的主键。等真的有了第二个服务、真的遇到了跨进程关联的痛点，再来加 `traceId`——到那时才知道需要什么形状的 trace。
- 不设计 metrics 系统。
- 不设计 tracing exporter。
- 不修改现有 JSONL 顶层字段结构。

## 标识模型

两个主标识，一个父子关系字段。够了。

### `sessionId`

业务会话标识。聚合同一会话下的多次执行。

- 新建会话时生成。
- 恢复会话时复用。
- 初始化点：`packages/runtime` 中的 `createSession()`。

### `runId`

单次执行实例标识。排障主键。

- 每次 `runTurn` 生成新的 `runId`。
- 每次 `resumeRun` 生成新的 `runId`，**不复用旧的**。
- 每次 `retry` 生成新的 `runId`，**不复用旧的**。
- 初始化点：`packages/runtime/src/runtime.ts`。

不复用旧 `runId` 的原因很简单：复用了你就分不清"最初的失败"和"恢复后的成功"。日志、事件、工具调用全混在一起，排障时只会骂人。

### `parentRunId`

**这是当前唯一需要新增的字段。**

当 resume/retry/replay 创建新 run 时，记录来源 run 的 ID。这样你可以：

- 从一个失败的 run 追溯到它的恢复 run。
- 从一个恢复 run 找到它的原始 run。
- 查看一个 session 下的 run 链条。

### 关系

```text
sessionId
├─ runId (initial)
├─ runId (retry, parentRunId → initial)
└─ runId (resume, parentRunId → retry)
```

`sessionId` 和 `runId` 是正交的两个维度：session 管聚合，run 管单次执行。不存在谁包含谁的树形层级。

### 补充标识（已有，不改动）

这些字段已存在于各自的层，维持现状：

- `messageId`：消息实体标识。
- `toolCallId`：单次工具调用实例标识。
- `checkpointId`：恢复点标识。
- `threadId`：运行时内部字段，不作为仓库级查询键。

## 日志约束

run 相关的日志记录必须在 `data` 中至少带上：

- `sessionId`
- `runId`

resume/retry/replay 场景额外带上：

- `parentRunId`
- `triggerType`（值为 `'new' | 'resume' | 'retry' | 'replay'`）

验收标准：**任意一条 run 级错误日志的 `data` 中都能直接 grep 出 `sessionId + runId`。**

### run 状态枚举

排障需要可读状态，不能纯靠 message 文本猜。统一使用：

```ts
type RunStatus =
  | 'started'
  | 'streaming'
  | 'waiting_tool'
  | 'interrupted'
  | 'resumed'
  | 'completed'
  | 'failed'
  | 'cancelled'
```

## 查询方式

两个入口，不多不少：

**按 `runId` 查**：这次执行为什么失败？失败前最后一个 tool call 是什么？这次 resume 对应的父 run 是哪个？

**按 `sessionId` 查**：这个会话最近几次运行是否连续失败？这次 run 属于哪个会话上下文？

## 实施

只有一步，因为只缺一个东西：

**在 runtime 中补充 `parentRunId` 与 `triggerType`。**

具体：

1. `packages/runtime/src/runtime.ts` 中 `resumeRun`、`retry`、`replay` 路径生成新 `runId` 时，同时记录 `parentRunId` 指向原 run。
2. 在对应的 runtime event 中携带 `parentRunId` 和 `triggerType`。
3. observer 日志在 resume/retry 场景下把这两个字段写入 `data`。

验收：**跑一次 resume，日志里能看到新 `runId`、`parentRunId` 指向旧 run、`triggerType: 'resume'`。**

## 未来扩展预留

当仓库真的出现第二个服务入口（HTTP server、worker 等）并且遇到跨进程日志关联的实际痛点时，再引入 `traceId`。届时的设计原则：

- `traceId` 在最外层入口初始化，runtime 只透传。
- `traceId` 和 `sessionId` 是正交关系，不是父子关系。
- 格式兼容 W3C Trace Context（32 位小写 hex）。

现在不做，因为没有这个问题。

## 决策摘要

- 主标识两个：`sessionId`（会话聚合）、`runId`（单次执行排障）。
- 新增 `parentRunId` 字段，resume/retry/replay 时记录来源 run。
- resume/retry/replay 必须生成新 `runId`，禁止复用。
- 关键日志必须带 `sessionId + runId`。
- 不引入 `traceId`，等有了真实的跨服务痛点再说。
