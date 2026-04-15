# tianji-ai 全量事件盘点（审计）

> 日期：2026-04-14
> 范围：`apps/{controlplane,node}` + `packages/{agent,observer,runtime,shared}`
> 目的：为"事件总线设计"提供现状基线。本文档为**只读快照**，不代表未来方向。

---

## 一、事件分层总览

| 层级 | 机制 | 核心类型 | 数量 |
|------|------|----------|------|
| 领域层（核心） | TS 联合类型 + 回调注入 | `RuntimeEvent` | 15 |
| 任务协议层 | NDJSON over HTTP POST | `TaskEvent`（lifecycle / agent wrapper） | 6 + 1 |
| Daemon SSE | EventSource | `chat.event / chat.done / chat.error` | 3 |
| ACP 协议层 | stdio NDJSON 子进程 | `SessionUpdate` 4 种 + `RuntimeEvent` 双向映射 | 4 |
| AG-UI 输出层 | CopilotKit SSE | `RUN_*` `STEP_*` `TEXT_MESSAGE_*` `TOOL_CALL_*` `REASONING_*` `STATE_*` | ~15 |
| OTel Tracing | OTLP spans | `session / run / tool / llm.call` | 4 |
| 审计日志 | ObserverLogger JSONL | 语义化 message | 50+ |

---

## 二、RuntimeEvent 完整清单

定义位置：`packages/shared/src/events.ts`

| 事件类型 | 接口 | 发射位置 | 说明 |
|----------|------|----------|------|
| `run.started` | `RunStartedEvent` | `packages/runtime/src/runtime.ts:552` | run 生命周期开始 |
| `run.completed` | `RunCompletedEvent` | `packages/runtime/src/runtime.ts:707` | 正常完成 |
| `run.failed` | `RunFailedEvent` | `packages/runtime/src/runtime.ts:781` | 异常终止 |
| `run.cancelled` | `RunCancelledEvent` | `packages/runtime/src/runtime.ts:649,745` | HITL 中断 / Abort 触发 |
| `message.started` | `MessageStartedEvent` | `packages/runtime/src/engines/deepagents-engine.ts:423` | 消息生成开始 |
| `message.delta` | `MessageDeltaEvent` | `packages/runtime/src/engines/deepagents-engine.ts:148,162` | 流式增量（text / thinking 双通道） |
| `message.completed` | `MessageCompletedEvent` | `packages/runtime/src/engines/deepagents-engine.ts:498` | 消息生成完毕 |
| `tool.started` | `ToolStartedEvent` | `packages/runtime/src/engines/deepagents-engine.ts:293,669` | 工具开始 |
| `tool.completed` | `ToolCompletedEvent` | `packages/runtime/src/engines/deepagents-engine.ts:336,722` | 工具完成 |
| `tool.failed` | `ToolFailedEvent` | `packages/runtime/src/engines/deepagents-engine.ts:770` | 工具失败 |
| `graph.started` | `GraphStartedEvent` | `packages/agent/src/orchestration/graph-runner.ts:98` | 编排图开始 |
| `graph.node.started` | `GraphNodeStartedEvent` | `packages/agent/src/orchestration/executors/deepagents-executor.ts:81`、`acp-executor.ts:72` | 节点开始（nodeKind：agent / acp-agent / human-gate / fork） |
| `graph.node.completed` | `GraphNodeCompletedEvent` | 同上两处 `:118, :100` | 节点完成 |
| `graph.node.failed` | `GraphNodeFailedEvent` | 同上两处 `:132, :112` | 节点失败 |
| `graph.completed` | `GraphCompletedEvent` | `packages/agent/src/orchestration/graph-runner.ts:120` | 编排图完成 |

---

## 三、TaskEvent（跨进程任务协议）

定义位置：`packages/shared/src/task-event.ts`

| 事件 | kind | 触发位置 | 说明 |
|------|------|----------|------|
| `task.started` | lifecycle | `apps/node/src/task/task-executor.ts:91` | runner.connect 后，sequence=1 |
| `task.waiting` | lifecycle | `TaskLifecycleType` 枚举 | HITL 挂起 |
| `task.completed` | lifecycle | `apps/node/src/task/task-executor.ts:137` | 成功结束 |
| `task.failed` | lifecycle | `apps/node/src/task/task-executor.ts:155` | 异常 |
| `task.cancelled` | lifecycle | `TaskLifecycleType` 枚举 | 取消 |
| `task.session.attached` | lifecycle | `TaskLifecycleType` 枚举 | agent 绑定 session |
| `agent`（wrapper） | agent | `apps/node/src/task/task-executor.ts:119` | 包装任意 RuntimeEvent |

---

## 四、ACP SessionUpdate 双向映射

映射位置：`packages/agent/src/acp/event-mapper.ts`、`apps/node/src/acp/event-adapter.ts`

| RuntimeEvent | ACP sessionUpdate | 说明 |
|--------------|-------------------|------|
| `message.delta` (text) | `agent_message_chunk` | 文本流 |
| `message.delta` (thinking) | `agent_thought_chunk` | 推理流 |
| `tool.started` | `tool_call` | 工具开始 |
| `tool.completed` | `tool_call_update(completed)` | 工具完成 |
| `tool.failed` | `tool_call_update(failed)` | 工具失败 |
| 其他（run/graph/message.started/completed） | 不映射 | 仅内部观测 |

---

## 五、AG-UI 映射（对 CopilotKit 兼容）

映射位置：`apps/controlplane/src/agents/event-mapper.ts`

| 输入事件 | 输出 AG-UI 事件 |
|----------|-----------------|
| `task.started` | `STATE_DELTA /taskStatus=running` |
| `task.completed` | `STATE_DELTA /taskStatus=completed` |
| `task.failed` | `STATE_DELTA` + `RUN_ERROR` |
| `task.cancelled` | `STATE_DELTA` + `RUN_ERROR` |
| `task.waiting` | `STATE_DELTA /taskStatus=waiting` |
| `task.session.attached` | `STATE_DELTA /sessionId` |
| `message.started` | `TEXT_MESSAGE_START` |
| `message.delta` (text) | `TEXT_MESSAGE_CONTENT` |
| `message.delta` (thinking) | `REASONING_START` + `REASONING_MESSAGE_START` + `REASONING_MESSAGE_CONTENT` |
| `message.completed` | `(REASONING_END+)TEXT_MESSAGE_END` |
| `tool.started` | `TOOL_CALL_START` |
| `tool.completed` | `TOOL_CALL_END` + `TOOL_CALL_RESULT` |
| `tool.failed` | `TOOL_CALL_END (含 error)` |
| `run.started` | `STEP_STARTED(stepKind=run)` |
| `run.completed/failed/cancelled` | `STEP_FINISHED(stepKind=run)` |
| `graph.started` | `STEP_STARTED(stepKind=graph)` |
| `graph.node.started` | `STEP_STARTED(stepKind=graph-node)` |
| `graph.node.completed/failed` | `STEP_FINISHED(stepKind=graph-node)` |
| `graph.completed` | `STEP_FINISHED(stepKind=graph)` |

---

## 六、OpenTelemetry Span

定义位置：`packages/observer/src/tracing/spans.ts`

| Span 名 | 属性 | 当前启用情况 |
|---------|------|--------------|
| `session` | `tianji.session.id` | 已定义，runtime 未实际调用 |
| `run` | `tianji.run.id, tianji.session.id` | 已定义，未实际调用 |
| `tool` | `tianji.tool.name, tianji.run.id` | **实际启用**（`packages/runtime/src/runtime.ts:850`） |
| `llm.call` | `provider, model` | 已定义，未实际调用 |

---

## 七、Daemon SSE（CLI 消费通道）

定义位置：`packages/agent/src/daemon-protocol.ts`

| 事件 | 说明 |
|------|------|
| `chat.event` | 包裹 RuntimeEvent 的 SSE 帧 |
| `chat.done` | 图运行完成 |
| `chat.error` | BUSY / INTERNAL 错误 |

---

## 八、HTTP 传输通道

| 端点 | 方向 | 载荷 | 用途 |
|------|------|------|------|
| `GET /api/nodes/:nodeId/commands/poll?timeout=N` | node → cp | `PollCommandResponse` | 长轮询取指令（60s 阻塞） |
| `POST /api/tasks/:taskId/events` | node → cp | NDJSON (`TaskEvent`) | 任务事件流式上报 |
| `POST /api/nodes/register` | node → cp | `NodeRegisterRequest/Response` | 启动注册 |
| `POST /api/nodes/:nodeId/heartbeat` | node → cp | `NodeHeartbeatRequest` | 30s 心跳 |
| `GET /api/ui/nodes` | browser → cp | `UiNode[]` | UI 查询在线节点 |
| `POST /api/copilot` | browser → cp | CopilotKit SSE 协议 | AG-UI 事件输出 |

---

## 九、疑似未建模领域事件

当前仅以日志形式存在，尚无独立类型。

| 概念 | 当前载体 | 潜在订阅者 | 建议处置（参见事件总线设计） |
|------|----------|------------|------------------------------|
| NodeRegistered | `logger.info('New node registered')` + DB | 仅 logger | L1 保持 |
| NodeReRegistered | `logger.info('Node re-registered')` | 仅 logger | L1 保持 |
| NodeMarkedOffline | `logger.info('Node marked offline')` + DB UPDATE | logger；UI 当前轮询 | L1 保持；有实时需求再升 L3 |
| TaskObservationLost | `logger.info` + DB UPDATE | logger | L1 保持 |
| RunHitlInterrupted | `runtime.ts:599/654` | 已被 `run.cancelled` 覆盖 | 合并到 `run.cancelled` |
| CommandLeased | DB `state='leased'` | DB | 不建模 |

---

## 十、端到端事件流拓扑

```
LangChain streamEvents(v2)
  ↓ 映射
deepagents-engine（emitEvent 回调）
  ↓
runtime.ReplayableEventStream  ← 全局唯一流式出口
  ↓
session.queryWithGraph (yield RuntimeEvent)
  ├─→ Daemon SSE (chat.event)     → CLI
  ├─→ ACP agent 模式（反向映射）    → 外部上游 runner
  └─→ 任务模式 TaskExecutor
         ↓ NDJSON POST
      ControlPlane /api/tasks/:id/events
         ↓ SQLite task_events
      TianjiAgent (rxjs) 轮询 500ms
         ↓ event-mapper（15 种 AG-UI）
      CopilotKit SSE → 浏览器
```

---

## 十一、前端事件现状

| 维度 | 结论 |
|------|------|
| CustomEvent / dispatchEvent | 0 处 |
| 快捷键系统（`DEFAULT_*_KEYBINDINGS`） | 未实现 |
| Zustand subscribe | 仅测试，生产无 |
| Hook `on*` 回调 | 无 |

前端位于 `apps/controlplane/src/web/`，12 个文件约 200 行，事件系统尚未铺开。

---

## 十二、事件总线设计相关的关键约束

1. **AG-UI 协议兼容不可破坏**：`event-mapper.ts`（RuntimeEvent/TaskEvent → AG-UI BaseEvent）必须继续存在，未来作为事件总线的订阅者。
2. **ACP 协议兼容不可破坏**：`acp/event-mapper.ts` 同上。
3. **多进程现状**：daemon 进程 + controlplane 进程各自独立，无共享内存。跨进程仍沿用 NDJSON + ACP。
4. **真实多订阅痛点集中在 RuntimeEvent + TaskEvent**（5+ 处消费、5 层透传链）。
