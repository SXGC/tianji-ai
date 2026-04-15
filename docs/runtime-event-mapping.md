# 旧 RuntimeEvent → 新 DomainEvent 映射

| 旧 (events.ts) | 新 (events/*) | payload 字段差异 |
|---|---|---|
| `run.started` | `RunStarted` | 无 |
| `run.completed` | `RunCompleted` | 无 |
| `run.failed` | `RunFailed` | 无 |
| `run.cancelled` | `RunCancelled` | 新增 `reason: 'hitl' \| 'abort'` |
| `message.started` | `MessageStarted` | 无 |
| `message.delta` | `MessageDelta` | 无（`sequence` 字段仍为 Message 内片段序号，**不是** envelope.sequence） |
| `message.completed` | `MessageCompleted` | 无 |
| `tool.started` | `ToolStarted` | 无 |
| `tool.completed` | `ToolCompleted` | 无 |
| `tool.failed` | `ToolFailed` | 无 |
| `graph.started` | `GraphRunStarted` | 字段保持 `runId/graphId/graphVersion` |
| `graph.completed` | `GraphRunCompleted` | 同 |
| `graph.node.started` | `GraphNodeStarted` | 同 |
| `graph.node.completed` | `GraphNodeCompleted` | 同 |
| `graph.node.failed` | `GraphNodeFailed` | 同 |
| —（原仅日志） | `GraphRunFailed` | 新增，graph-runner catch 分支发射 |
| `task.*` | `Task*`（Started/Waiting/SessionAttached/Completed/Failed/Cancelled） | 按 spec 重命名 |
| —（原仅日志） | `TaskObservationLost` | cp 发射 |
| —（原仅日志） | `SessionCreated/Resumed/Closed` | 新增 |
| —（原仅日志） | `NodeRegistered/ReRegistered/MarkedOffline` | cp 发射 |
| `RunHitlInterrupted` | `RunCancelled(reason='hitl')` | 合并，payload 新增 reason |
