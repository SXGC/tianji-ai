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
| `graph.completed` | `GraphRunCompleted` | 新增可选 `usage`，表示本次 graph run 的累计 usage，不是 session 累计 |
| `graph.node.started` | `GraphNodeStarted` | 同 |
| `graph.node.completed` | `GraphNodeCompleted` | 新增可选 `usage`，表示该节点本次执行的 node-level delta |
| `graph.node.failed` | `GraphNodeFailed` | 新增可选 `usage`，表示该节点失败前已拿到的 node-level delta |
| —（原仅日志） | `GraphRunFailed` | 新增，graph-runner catch 分支发射；payload 新增可选 `usage`，表示本次 graph run 已累计的 usage |
| —（原仅日志） | `GraphRunCancelled` | 新增；payload 新增可选 `usage`，表示本次 graph run 已累计的 usage |
| `task.*` | `Task*`（Started/Waiting/SessionAttached/Completed/Failed/Cancelled） | 按 spec 重命名 |
| —（原仅日志） | `TaskObservationLost` | cp 发射 |
| —（原仅日志） | `SessionCreated/Resumed/Closed` | 新增 |
| —（原仅日志） | `NodeRegistered/ReRegistered/MarkedOffline` | cp 发射 |
| `RunHitlInterrupted` | `RunCancelled(reason='hitl')` | 合并，payload 新增 reason |

## usage 口径

- `GraphNodeCompleted.usage` / `GraphNodeFailed.usage` 是单个节点终态事件自己的 usage delta。
- `GraphRunCompleted.usage` / `GraphRunFailed.usage` / `GraphRunCancelled.usage` 是本次 graph run 内节点终态 usage 的累计结果。
- graph usage 不是 session 累计 usage。未知 usage 保持 `undefined`，不估算，不写 0。
