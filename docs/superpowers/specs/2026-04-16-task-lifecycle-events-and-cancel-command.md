# Task 生命周期事件对齐与取消命令通路

> **日期**：2026-04-16
> **状态**：Draft（待 review）
> **作者**：brainstorming 对齐产出
> **范围**：`packages/shared`、`packages/agent`、`packages/runtime`、`apps/node`、`apps/controlplane`

---

## 1. 背景

### 1.1 触发问题

用户在 observer 日志中看到如下 graph 级失败事件：

```
event-bus GraphRunFailed {"correlationId":"87f08ef0-14d2-445c-be89-fc70127b1ec0","causationId":"01KPAHG0FB0526B4VCX0AK4R78","sequence":4,"aggregateType":"GraphRun","aggregateId":"run_graph_1776322776711","payload":{"type":"GraphRunFailed","runId":"run_graph_1776322776711","graphId":"default","graphVersion":1,"error":{"name":"ProviderError","message":"500 empty_stream: upstream stream closed before first payload"},"timestamp":1776322871787}}
```

**前端对该失败完全无感知**。调查后发现这不是一个独立 bug，而是三层聚合（GraphRun / Run / Task）在三条路径（成功 / 失败 / 取消）上的事件契约都存在缺陷，同时 "用户主动取消任务" 的命令通路也未打通。

### 1.2 现状缺陷清单

| # | 缺陷 | 影响 |
|---|---|---|
| 1 | `task-executor` 的 for-await 循环结束后无条件发 `TaskCompleted`，不管 Run 终端是 `RunCompleted` / `RunFailed` / `RunCancelled` | 失败和取消路径会被误报为 "成功" |
| 2 | error 被重包装三次（`ProviderError` → `RunFailed.error` → `TianjiError('internal', 'TASK_EXECUTION_FAILED', message)`），原始 `name` 和 `code` 丢失 | 前端无法区分 provider 错误、网络错误等真实原因 |
| 3 | `GraphRunCancelled` 事件根本不存在于 `packages/shared`；`graph-runner` 的 catch 把 `AbortError` 当作 `GraphRunFailed` | 取消和失败无法区分 |
| 4 | `TaskCancelled` 事件虽然定义，但**从未被发射过** | 取消在 Task 聚合层是不可观测的 |
| 5 | controlplane 的 `event-mapper` 对 `GraphRunFailed` / `TaskCancelled` 都没有 AG-UI 映射 | 前端感知链路断裂 |
| 6 | 不存在 `CancelTaskCommand`；前端、CP、Node 三端都没有"取消任务"的代码路径 | 用户无法主动取消运行中的任务 |

---

## 2. 目标

| # | 目标 | 达成后的状态 |
|---|---|---|
| G1 | **事件契约完整** | 三条路径 × 三层聚合的生命周期都满足"收到 Started 后必须在有限时间内收到**恰好一个** Completed / Failed / Cancelled" |
| G2 | **错误信息不失真** | 底层 error 的 `name` / `code` / `message` 从 `GraphRunFailed` 一路透传到 `TaskFailed`，再到前端 AG-UI |
| G3 | **前端能感知失败** | 贴出的 `ProviderError 500 empty_stream` 场景中，前端能看到带原始 error 语义的失败提示 |
| G4 | **用户能主动取消** | 前端取消按钮 → CP 下发 `task.cancel` 命令 → Node 中止运行中 task，< 3 秒生效 |
| G5 | **不破坏现有基础设施** | 复用 `commands` 表 + `command_poll` 长轮询通路；不新建 SSE / WebSocket |

---

## 3. 非目标

| 项 | 原因 |
|---|---|
| 不新增 SSE / WebSocket 等实时传输通道 | 现有 `command_poll` 服务端 1 秒扫描间隔足够支撑 < 2 秒取消延迟 |
| 不扩展 `RunCancelled.reason` 细分（保留 `'hitl'` / `'abort'` 两种） | 当前场景只需区分 HITL 和外部 abort；超时、父任务取消等未来需要再加 |
| 不修改 GraphRun / Run 聚合的 `aggregateId` 生成规则 | 不在问题范围内 |
| 不设计 "取消超时兜底" 机制 | Let it crash：取消信号发出后如果 graph 不响应，应该让问题暴露为 bug |
| 不为 `GraphRun*` 事件做 AG-UI 映射 | 前端只看 Task 聚合；GraphRun 是内部实现，保持聚合边界清晰 |
| 不重构 `TaskFailed.error` 的外壳结构 | 保留 `TianjiError` 外壳，只在 `code` 字段透传原始 error name，避免前端适配面扩大 |

---

## 4. 总架构

```
┌──────────────────────────────────────────────┐
│              前端 (CopilotKit)               │
│      取消按钮 → CopilotKit SDK cancel 能力   │
└───────────────────┬──────────────────────────┘
                    │ HTTP (cancel action)
                    ▼
┌──────────────────────────────────────────────┐
│              Controlplane                    │
│  POST /api/copilot (路由)                    │
│  → TianjiAgent.cancelTask(taskId)            │
│  → INSERT commands (type='task.cancel', ...) │
└───────────────────┬──────────────────────────┘
                    │ long-polling (< 2s 延迟)
                    ▼
┌──────────────────────────────────────────────┐
│             Node Daemon                      │
│  command-consumer 按 type 分发:              │
│   - task.run   → 新建 TaskExecutor           │
│   - task.cancel → ActiveExecutorRegistry     │
│                   .cancel(taskId)            │
│                       ↓                      │
│              runner.disconnect()             │
│                       ↓                      │
│            session.abort() → AbortSignal     │
└───────────────────┬──────────────────────────┘
                    │ 触发事件链（自下而上）
                    ▼
  graph-runner catch AbortError
     → GraphRunCancelled
         ↓ (causationId)
     run-lifecycle 识别 abort
     → RunCancelled
         ↓ (causationId)
     task-executor 循环感知
     → TaskCancelled
                    │
                    │ event bus → forwarder
                    ▼
        CP event_log → event-mapper → AG-UI
                    │
                    ▼
              前端感知取消成功
```

**三条传导轴**：

| 轴 | 方向 | 传递的内容 |
|---|---|---|
| 命令轴 | CP → Node | 用户意图（run / cancel） |
| 事件轴 | Node → CP | 聚合生命周期状态 |
| causationId 链 | 自下而上 | GraphRun 终端 → Run 终端 → Task 终端 |

---

## 5. 事件契约

### 5.1 新增事件：GraphRunCancelled

在 `packages/shared/src/events/graph-run.ts` 新增：

| 字段 | 类型 | 说明 |
|---|---|---|
| `type` | `'GraphRunCancelled'` 字面量 | 判别符 |
| `runId` | `string` | graph 的 runId，同时作为 `aggregateId` |
| `graphId` | `string` | 图定义 id |
| `graphVersion` | `number` | 图版本 |
| `reason` | `'abort'` | 目前只有一种来源（外部 AbortSignal） |
| `timestamp` | `number` | unix ms |

同步更新：

- `GraphRunDomainEvent` union 加入新事件
- `packages/runtime/src/bus/event-target.ts` 的 `resolveTarget` 加入 `GraphRunCancelled` → `aggregateType: 'GraphRun'` 映射

### 5.2 发射契约收紧

| 事件 | 当前发射条件 | 收紧后的发射条件 |
|---|---|---|
| `GraphRunFailed` | 任何 graph 异常（含 AbortError） | 仅**非取消**的异常终止。`error.name === 'AbortError'` 且 `signal.aborted === true` 时不走这里 |
| `GraphRunCancelled` | 不存在 | 仅当 graph-runner catch 到 AbortError 且 AbortSignal 已触发时 |
| `RunFailed.error` | 被 runtime 层重包装 | 透传 `GraphRunFailed.error` 的原始 `name` / `code` / `message` |
| `TaskFailed.error` | `TianjiError('internal', 'TASK_EXECUTION_FAILED', message)` | `TianjiError` 外壳保留；`code` 透传原始 error `name`（如 `'PROVIDER_ERROR'`）；`message` 保留原始消息；`category` 沿用现有 `'internal'` |
| `TaskCompleted` | for-await 循环正常结束且见过任意 Run 终端 | 仅当循环期间记忆的最后一个 Run 终端事件是 `RunCompleted` |
| `TaskFailed` | catch 块内 | 包含两种路径：(a) 循环期间记忆的 Run 终端是 `RunFailed`；(b) catch 到异常 |
| `TaskCancelled` | 未发射 | 仅当循环期间记忆的 Run 终端是 `RunCancelled` |

### 5.3 因果链传导规则

三条路径的**相邻聚合终端事件**之间建立 `causationId` 链：

| 路径 | 事件链（下层.causationId 指向上层.eventId） |
|---|---|
| 成功 | `GraphRunCompleted` → `RunCompleted` → `TaskCompleted` |
| 失败 | `GraphRunFailed` → `RunFailed` → `TaskFailed` |
| 取消 | `CancelTaskCommand` → (abort 信号) → `GraphRunCancelled` → `RunCancelled` → `TaskCancelled` |

**correlationId** 全程保持不变（`taskId`），由 `enterCorrelation` 保证，本 spec 不修改。

取消路径的 `TaskCancelled` 与触发命令 `CancelTaskCommand` 的关联通过共享 `correlationId = taskId` 建立；`causationId` 仍然指向 `RunCancelled`（事件层的直接因果）。

---

## 6. 命令契约

### 6.1 Command 改造为 discriminated union

当前 `packages/shared/src/command.ts`：

- `Command.type: 'task.run'`（字面量，非 union）
- `Command.payload: TaskRunPayload`

改造后：

| Command 子类型 | type | payload |
|---|---|---|
| `TaskRunCommand` | `'task.run'` | `TaskRunPayload`（现有，不改） |
| `TaskCancelCommand` | `'task.cancel'` | `TaskCancelPayload`（新增） |

`Command = TaskRunCommand \| TaskCancelCommand`（discriminated union on `type`）。

### 6.2 TaskCancelPayload

| 字段 | 类型 | 说明 |
|---|---|---|
| `taskId` | `string` | 目标任务 id |
| `reason` | `'user'` | 取消来源；当前只有用户主动取消。未来扩展 `'timeout'` 等时再加 |

### 6.3 命令通路复用

不新建任何通路。所有 `task.cancel` 命令走：

```
CP: INSERT commands (type='task.cancel', node_id, payload={taskId,reason}, state='pending')
         ↓ (node long-polling, 服务端 1s 扫描间隔)
Node: GET /api/nodes/:nodeId/commands/poll → 立即唤醒返回
         ↓
Node: command-consumer 按 type 分发
```

涉及改动：

- `PollCommandResponse` 类型改为 discriminated union（与 Command 同步）
- `command-poll.ts` 路由不改（SELECT 不过滤 type，直接返回）
- Node 端命令消费者增加 `task.cancel` 分支

---

## 7. Node 端执行模型

### 7.1 活跃 TaskExecutor 注册表（ActiveExecutorRegistry）

新增进程级单例，按 `taskId` 索引当前正在运行的 `TaskExecutor` 实例。

| 能力 | 职责 |
|---|---|
| `register(taskId, executor)` | `TaskExecutor.execute()` 开始时调用，冲突则抛错（同一 taskId 不应同时运行） |
| `unregister(taskId)` | `TaskExecutor.execute()` finally 块中调用 |
| `cancel(taskId)` | 查表后调用对应 executor 的 cancel 方法；找不到时抛错（Let it crash） |

**定位**：放在 daemon-entry 作用域内（进程级单例）。**不放在 AsyncLocalStorage 里**——CLAUDE.md 规定 ALS 只允许放基础变量。

### 7.2 TaskExecutor.cancel() 方法

| 语义属性 | 规则 |
|---|---|
| 行为 | 调用内部 `runner.disconnect()` → `session.abort()` → 所有活跃 graph 的 AbortController 触发 |
| 返回 | 立即返回。生效信号通过事件链（`GraphRunCancelled` → `RunCancelled` → `TaskCancelled`）回传 |
| 幂等 | 重复调用只触发一次实际 abort，后续调用静默返回 |
| 非法调用 | 对 idle 状态的 TaskExecutor 调用 cancel，抛错（Let it crash） |

### 7.3 命令分发（在 daemon 的命令消费路径）

| command.type | 动作 |
|---|---|
| `task.run` | 走现有路径：`createRunner` → `new TaskExecutor` → 注册 → `execute()` → finally 注销 |
| `task.cancel` | `ActiveExecutorRegistry.cancel(payload.taskId)`；找不到对应 executor 时抛错 |

### 7.4 task-executor for-await 终端分发

**改造要点**：`TaskExecutor.execute()` 的 for-await 循环期间记忆最后一个 Run 终端事件类型。循环正常结束后，根据记忆分发：

| 记忆的 Run 终端 | 发射的 Task 终端事件 |
|---|---|
| `RunCompleted` | `TaskCompleted` |
| `RunFailed` | `TaskFailed`（携带透传的原始 error） |
| `RunCancelled` | `TaskCancelled`（携带 `reason` 透传） |
| 未记忆（循环异常终止） | 由 catch 块发 `TaskFailed`（携带异常） |

---

## 8. Controlplane 集成

### 8.1 TianjiAgent 新增取消入口

在 `apps/controlplane/src/agents/tianji-agent.ts` 中新增：

- `cancelTask(taskId: string): Promise<void>`
- 行为：向 `commands` 表 INSERT 一行 `type='task.cancel'`，payload 为 `{ taskId, reason: 'user' }`
- `node_id` 字段来源：从 `tasks` 表根据 `taskId` 反查该任务的归属 node（复用 `task.run` 命令建立的 task → node 关系）。Spec 不要求新增表结构；如果现有 `tasks` 表未持久化 `node_id`，实施阶段需识别并补齐
- 复用现有数据库连接和 schema

### 8.2 HTTP 路由

新增或扩展一条路由接收前端的 cancel 请求（具体路径按 CopilotKit SDK 约定，可能是 `/api/copilot` 扩展或新路径）：

- 从请求中取 `taskId`
- 调用 `TianjiAgent.cancelTask(taskId)`
- 返回 202 Accepted（cancel 是异步的，真实结果通过事件流回传）

**前端代码的具体落点不在本 spec 范围**——前端集成取决于 CopilotKit SDK 当前版本提供的 cancel API 形式（hook / action / 其他），实施阶段按 SDK 文档对接。

### 8.3 event-mapper 映射补齐

| 领域事件 | AG-UI 映射 |
|---|---|
| `TaskCancelled` | `RUN_FINISHED` 事件（带 `reason: 'cancelled'` 或等价信息，具体字段由 AG-UI 协议决定） |
| `TaskFailed` | （已有映射，保留）`RUN_ERROR` 事件携带 `error.code` 和 `error.message` |
| `GraphRunFailed` / `GraphRunCancelled` / `RunFailed` / `RunCancelled` | **不映射**（前端只看 Task 聚合） |

---

## 9. 数据流实例

### 9.1 失败路径：ProviderError 500 empty_stream

```
1. task-executor.execute(taskId=T1)
   emit TaskStarted(taskId=T1)
2. runner.connect() → session 创建 → emit TaskSessionAttached
3. for-await 循环开始：
   3.1 emit RunStarted(runId=R1)
   3.2 graph 启动 → emit GraphRunStarted(runId=G1)
   3.3 graph 内部调用 provider → 500 empty_stream
   3.4 graph-runner catch ProviderError（非 AbortError）
       → emit GraphRunFailed(runId=G1, error={name:'ProviderError', message:'500 empty_stream...'})
       → throw
   3.5 run-lifecycle catch → emit RunFailed(runId=R1, error={name:'ProviderError',...}  // 原样透传
   3.6 for-await 记忆最后 Run 终端 = RunFailed
4. 循环正常结束
5. 按记忆分发：
   emit TaskFailed(taskId=T1, error=TianjiError('internal', 'PROVIDER_ERROR', '500 empty_stream...'))
6. forwarder → CP event_log → event-mapper → AG-UI RUN_ERROR(code='PROVIDER_ERROR', message='500 empty_stream...')
7. 前端感知并展示错误
```

### 9.2 取消路径：用户主动取消

```
1. 用户在前端点 "取消"
2. CopilotKit 调用 cancel API → POST /api/copilot (cancel action)
3. TianjiAgent.cancelTask(taskId=T1)
   → INSERT commands (type='task.cancel', node_id=N1, payload={taskId:'T1',reason:'user'}, state='pending')
4. Node N1 的 long-poll 请求正在 hold
   → 服务端 1s 扫描发现新命令 → 立即返回 PollCommandResponse(type='task.cancel', ...)
5. Node daemon command-consumer 收到 task.cancel
   → ActiveExecutorRegistry.cancel('T1')
   → 查表找到对应 TaskExecutor 实例
   → executor.cancel()
   → runner.disconnect() → session.abort() → AbortController.abort()
6. graph-runner 的 invoke 抛 AbortError
   → catch 识别 AbortError + signal.aborted
   → emit GraphRunCancelled(runId=G1, reason='abort')
   → throw
7. run-lifecycle catch 识别 abort
   → emit RunCancelled(runId=R1, reason='abort')
8. task-executor for-await 记忆 RunCancelled
9. 循环结束 → emit TaskCancelled(taskId=T1)
10. forwarder → CP event_log → event-mapper → AG-UI RUN_FINISHED(cancelled)
11. 前端感知取消成功
```

### 9.3 成功路径

参照失败路径，把步骤 3.3~3.5 替换为正常完成路径（`GraphRunCompleted` → `RunCompleted`），步骤 5 分发 `TaskCompleted`。

---

## 10. 测试矩阵

### 10.1 单元测试

| 位置 | 场景 |
|---|---|
| `packages/agent/src/orchestration/__tests__/graph-runner.test.ts` | AbortError → `GraphRunCancelled`；非 AbortError → `GraphRunFailed`；error 原始字段不丢失 |
| `packages/runtime/src/__tests__/run-lifecycle.test.ts` | `GraphRunFailed.error` 在 `RunFailed` 中原样透传；AbortSignal 触发 `RunCancelled` |
| `apps/node/src/task/__tests__/task-executor.test.ts` | 三条路径的 Task 终端事件正确分发；error 透传到 `TaskFailed.error.code` |
| `apps/node/src/task/__tests__/active-executor-registry.test.ts`（新文件） | `register` 冲突检测；`unregister` 生命周期；`cancel` 路由；`cancel` 非活跃任务时抛错 |
| `apps/controlplane/src/agents/__tests__/event-mapper.test.ts` | `TaskCancelled` → AG-UI 映射 |
| `apps/controlplane/src/agents/__tests__/tianji-agent.test.ts` | `cancelTask` 正确插入 commands 表，字段符合 schema |

### 10.2 集成测试

| 位置 | 场景 |
|---|---|
| `apps/controlplane/src/__tests__/controlplane-node.e2e.test.ts` | 起 task → provider 模拟 500 → 前端收到带 `PROVIDER_ERROR` code 的 AG-UI RUN_ERROR |
| 同上 | 起 task → 中途发 cancel 命令 → 前端收到 AG-UI RUN_FINISHED(cancelled)，全链路事件完整 |
| `apps/node/src/__tests__/daemon-e2e.test.ts` | daemon 收到 `task.cancel` 命令正确路由到 `ActiveExecutorRegistry`；对非活跃 taskId 报错 |

### 10.3 回归场景

| 场景 | 验证点 |
|---|---|
| 用户贴的 500 empty_stream 日志重现 | `TaskFailed.error.code === 'PROVIDER_ERROR'`，前端可见 |
| 重复 cancel | 同 taskId 下发两次 `task.cancel`，第二次的 `cancel()` 调用静默 |
| cancel 时 task 已结束 | `ActiveExecutorRegistry.cancel` 抛错 → CP 端能看到命令失败状态 |
| 多 task 并发 | 多个 taskId 并发运行，cancel 其中一个不影响其他 |

---

## 11. 风险与边界情况

| 风险 | 表现 | 缓解 |
|---|---|---|
| CancelCommand 与自然完成竞态 | cancel 命令下发瞬间 task 刚好结束 | `ActiveExecutorRegistry.cancel` 抛错（Let it crash），CP 端把命令标记为 `failed` 状态，前端感知"取消时任务已结束" |
| 单个 session 内多个 graph 并发 | 一次 abort 要中止所有活跃 graph | `session.abort()` 已遍历所有 `activeGraphControllers`（现有能力，不改）；每个 graph 独立发 `GraphRunCancelled` |
| AbortError 识别 | 不同 Node 版本 / 不同库抛的 AbortError 字段差异 | 用 `error.name === 'AbortError'` 配合 `signal.aborted === true` 双重判断 |
| run-lifecycle 对新增 `GraphRunCancelled` 的响应 | 新事件出现时 run-lifecycle 能否正确识别并发 `RunCancelled` | run-lifecycle 现有路径通过 `AbortSignal.aborted` 状态判断（不是通过事件），改动范围仅需确认异常类型识别分支正确；测试必须覆盖 |
| node 离线时 cancel 命令的归宿 | node 长时间离线，`observation-monitor` 把 cancel 命令标为 `observation_lost` | 复用现有机制，不需新增 |

---

## 12. 分期建议（给 writing-plans 的输入）

本 spec 切分为三个可独立实施、独立 PR 的阶段：

| 阶段 | 内容 | 独立价值 | 依赖 |
|---|---|---|---|
| **P1: 失败路径对齐** | task-executor 按 Run 终端分发 + error 透传（`GraphRunFailed.error` → `RunFailed.error` → `TaskFailed.error.code`）| 立即解决用户贴的 `ProviderError` 日志痛点 | 无 |
| **P2: 取消事件定义** | 新增 `GraphRunCancelled`；graph-runner catch 区分 AbortError；`RunCancelled` → `TaskCancelled` 联动 | 事件链齐全（但此时仍无外部触发器） | P1 |
| **P3: Cancel 命令通路** | `Command` 改 discriminated union；`TaskCancelPayload`；`TaskExecutor.cancel()`；`ActiveExecutorRegistry`；`TianjiAgent.cancelTask`；前端 CopilotKit 入口；`event-mapper` 补 `TaskCancelled` 映射 | 用户能真正取消任务 | P2 |

建议按 P1 → P2 → P3 顺序执行，每阶段独立 commit / PR，便于 review 和回滚。

---

## 13. 验收标准

- [ ] `pnpm check` 通过（零 error / warning）
- [ ] 所有单元测试通过
- [ ] 所有集成测试通过（含冒烟测试 `SMOKE_E2E=1 pnpm --filter @tianji/node test:smoke`）
- [ ] 贴出的 `ProviderError 500 empty_stream` 场景重现后，前端能看到 `RUN_ERROR(code='PROVIDER_ERROR')`
- [ ] 前端模拟点击取消，< 3 秒内 task 停止并收到 `AG-UI RUN_FINISHED(cancelled)`
- [ ] 通过 `event_log` 表可验证三条路径 × 三层聚合的生命周期完整性（每个 `Started` 都有恰好一个终端事件，`causationId` 链正确）
- [ ] 相关 README 同步更新（`apps/node/README.md`、`apps/controlplane/README.md`、`docs/development/09 - EVENT_BUS_DESIGN.md`）

---

## 14. 参考资料

- `docs/development/09 - EVENT_BUS_DESIGN.md`：事件总线分层设计
- `docs/superpowers/plans/2026-04-16-task-aggregate-result-events.md`：并行进行的 TaskMessage* 事件方案（不冲突）
- `packages/shared/src/command.ts`：Command schema 当前定义
- `apps/controlplane/src/routes/command-poll.ts`：long-polling 实现
- `packages/runtime/src/runtime/run-lifecycle.ts`：Run 终端事件发射逻辑
