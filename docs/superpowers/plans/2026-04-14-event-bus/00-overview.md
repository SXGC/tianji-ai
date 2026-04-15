# 事件总线与领域事件建模 实施计划总览

> 日期：2026-04-14
> Spec：[../../specs/2026-04-14-event-bus-design.md](../../specs/2026-04-14-event-bus-design.md)
> 盘点基线：[../../specs/2026-04-14-events-inventory.md](../../specs/2026-04-14-events-inventory.md)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把现状 7 层事件分层重构为 Core / Integration / Protocol 三层架构，落地统一 `DomainEventEnvelope`、进程内 EventBus、`event_log` 持久化与 5 个协议适配器，彻底废弃 `TaskEvent` 与 `task_events` 表.

**Architecture:** Core 层由聚合根发射纯领域事件；Integration 层在装配时用 `wrapEnvelope` 套上信封（ULID eventId、correlationId、causationId、聚合内单调 sequence）并 publish 到薄 pub/sub EventBus；订阅者包含 5 个协议适配器和 EventLogStore（批量写 SQLite）。跨进程沿用 HTTP NDJSON / stdio NDJSON / SSE 三条物理通道，内层载荷统一为 envelope。单 writer 不变式靠三重防线保证（内存计数器 + UNIQUE 约束 + ingest 归属校验）.

**Tech Stack:** TypeScript + pnpm workspaces、vitest、better-sqlite3（cp 侧已在用）、ULID、LangGraph/DeepAgents（runtime 侧）、CopilotKit（AG-UI 协议）、ACP（stdio）.

---

## 阶段与执行顺序

每一阶段单独一个 plan 文件，按顺序执行；阶段之间存在硬依赖（后一阶段以前一阶段产物为前提）.

| 阶段 | 文件 | 依赖 | 交付物 |
|------|------|------|--------|
| 01 | `01-core-events-types.md` | — | `packages/shared/src/events/*` 新领域事件与 envelope 类型 |
| 02 | `02-event-bus.md` | 01 | `packages/shared/src/bus/*` EventBus 薄实现 + 单测 |
| 03 | `03-wrap-envelope-counters.md` | 01 | `packages/runtime/src/bus/*` wrapEnvelope、聚合计数器、重启恢复接口 |
| 04 | `04-event-log-store.md` | 01, 03 | EventLogStore 接口 + SQLite 实现 + schema 迁移 |
| 05 | `05-runtime-bus-integration.md` | 02, 03, 04 | runtime / engine 的 `emitEvent` 注入 Bus publish；补发新增领域事件 |
| 06 | `06-protocol-adapters.md` | 02, 05 | 5 个适配器从 RuntimeEvent 改订 envelope |
| 07 | `07-cross-process-transport.md` | 02, 04, 05, 06 | node→cp forwarder + ingest，端点语义升级 |
| 08 | `08-cleanup-taskevent.md` | 07 | 删除 `task-event.ts`、`task_events` 表与 `TaskLifecycleType`，一次性迁移脚本 |

## 跨阶段共享约定

### 命名与字符串常量

| 项 | 值 |
|----|----|
| envelope `type` 字段 | PascalCase 事件名（例 `RunStarted`、`GraphNodeFailed`、`TaskObservationLost`） |
| 事件 TS 类型名 | 与 `type` 字符串完全一致的 `*Event` 接口（例 `RunStartedEvent`） |
| 聚合类型字面量 | `'Session' | 'GraphRun' | 'Run' | 'Task' | 'Node'`（TS union 类型 `AggregateType`） |
| 进程种类字面量 | `'daemon' | 'node' | 'cp'`（TS union 类型 `ProcessKind`） |
| ULID 生成库 | `ulid` npm 包（若未安装则在 01 阶段引入） |
| NodeKind 字段 | 保留现有 `'agent' | 'acp-agent' | 'human-gate' | 'fork'` |

### 文件结构约束

- 所有新增文件单文件不得超过 800 行。
- 业务代码禁止 `any`；禁止内联 `import()`；所有导入置于文件顶部。
- 所有新增文件含顶层 TSDoc `@module` 描述。

### 测试约束

- TDD：先写失败测试，再写最小实现。
- vitest 从对应包根目录执行：`pnpm --filter @tianji/shared test` 等。
- 日志相关代码不写测试。
- 每阶段结束执行 `pnpm check` 并修复全部 error / warning / info。

### 提交约定

- 每个 Step 中的 commit 都使用语义化中文消息，禁止加 `Co-Authored-By:`。
- 每次提交前手动 `git add <具体路径>`，禁止 `git add -A/.`。
- 执行 `git commit` 前必须加载 `git-commit` skill。

### 跨阶段类型引用速查

01 阶段定义、后续阶段引用的核心符号：

```ts
// packages/shared/src/events/envelope.ts
export type AggregateType = 'Session' | 'GraphRun' | 'Run' | 'Task' | 'Node'
export type ProcessKind = 'daemon' | 'node' | 'cp'
export interface EnvelopeSource { processKind: ProcessKind; processId: string; nodeId?: string }
export interface DomainEventEnvelope<T extends DomainEvent = DomainEvent> { /* 见 01 阶段 */ }

// packages/shared/src/events/domain-event.ts
export type DomainEvent = /* 25 种事件联合 */
```

后续阶段一律从 `@tianji/shared` 导入，不得重复定义。

## 风险与兜底立场

- **Let it crash**：`event_log` UNIQUE 冲突、writer 归属校验失败、envelope 缺字段、ingest 载荷解析失败——直接 throw，不做降级。
- **不做双写**：按 spec 要求一次性切换。阶段 07 完成后，08 直接删除旧路径。
- **不做 at-least-once**：跨进程 forwarder 缓冲仅用于打包，丢失窗口与 50ms batch 一致。
- **不做订阅者重连补发**：慢订阅者队列满 → 丢事件并发 `SubscriberLag` 元事件。
