# 阶段 08：清理 TaskEvent 与旧事件遗物

> Spec：[../../specs/2026-04-14-event-bus-design.md](../../specs/2026-04-14-event-bus-design.md) §六.1、§八.8
> 前置：阶段 07（跨进程新通道已就绪）
> 交付物：删除 `task-event.ts`、`task_events` 表、`TaskLifecycleType`；一次性迁移脚本把旧 task_events 数据迁到 event_log（若有历史）；删除旧 `events.ts`（Legacy alias 出口）。

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development.

**Goal:** 把旧事件系统的所有遗物从仓库里彻底移除。一次性切换、不保留双路径。

**Architecture:** 按依赖倒序删：先删无人引用的旧类型与表 SQL，再删旧 mapper，最后删旧 `events.ts`。迁移脚本作为可选步骤 — 若目标环境无历史 task_events 数据则跳过。

---

## File Structure

- Delete: `packages/shared/src/task-event.ts`
- Delete: `packages/shared/src/events.ts`
- Modify: `packages/shared/src/index.ts`（移除 Legacy alias）
- Modify: `apps/controlplane/src/db/schema.ts`（移除 `task_events` 表定义）
- Create: `apps/controlplane/src/db/migrations/20260414-drop-task-events.sql`
- Create: `apps/controlplane/src/db/migrations/20260414-migrate-task-events.ts`
- Delete 可能残留的 mapper 老路径（若 `event-stream.ts` / `event-mapper.ts` 中有旧 RuntimeEvent 专用分支）
- Modify: 相关 README（observer / agent / controlplane）

---

### Task 1: 迁移脚本（若目标环境有历史数据）

**Files:**
- Create: `apps/controlplane/src/db/migrations/20260414-migrate-task-events.ts`

- [ ] **Step 1: 询问用户**：当前部署环境是否需要保留历史 `task_events` 数据？若确认**不需要**，跳过 Task 1，直接进 Task 2。以下按"需要迁移"实施。

- [ ] **Step 2: 写迁移脚本**

```ts
/**
 * 一次性把旧 task_events 数据迁移到 event_log。
 * 旧 TaskEvent 结构：{ kind: 'lifecycle'|'agent', payload, taskId, sequence, timestamp }
 * 迁移策略：
 *   - lifecycle kind → aggregateType='Task', type=按 TaskLifecycleType 映射，source.processKind='node'（历史假设）
 *   - agent kind → 解包内部 RuntimeEvent，按 event-target 推导 aggregateType/id
 *   - correlationId：用 taskId 的 `task-${taskId}`（历史数据无真实 correlationId）
 *   - causationId：null（历史数据无链路）
 *   - eventId：ulid（新生成）
 *
 * 运行一次即可。幂等靠 event_log 的 UNIQUE 约束兜底：重复 run 会 throw。
 * @module db/migrations/20260414-migrate-task-events
 */

import type Database from 'better-sqlite3'
import { ulid } from 'ulid'
// 具体映射辅助函数在此文件内实现

export function migrateTaskEvents(db: Database.Database): { migrated: number } {
  // 检查旧表是否存在
  const tableRow = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='task_events'",
  ).get()
  if (!tableRow) return { migrated: 0 }

  const rows = db.prepare(`
    SELECT task_id, sequence, kind, payload, timestamp
    FROM task_events ORDER BY task_id, sequence ASC
  `).all() as Array<{
    task_id: string; sequence: number; kind: string; payload: string; timestamp: number
  }>

  const insert = db.prepare(`
    INSERT INTO event_log
    (event_id, type, occurred_at, correlation_id, causation_id,
     sequence, aggregate_type, aggregate_id, source_json, payload_json)
    VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
  `)

  const tx = db.transaction(() => {
    let n = 0
    for (const r of rows) {
      const { type, aggregateType, aggregateId, payload } = mapLegacyRow(r)
      insert.run(
        ulid(),
        type,
        new Date(r.timestamp).toISOString(),
        `task-${r.task_id}`,
        r.sequence,
        aggregateType,
        aggregateId,
        JSON.stringify({ processKind: 'node', processId: 'legacy', nodeId: 'legacy' }),
        JSON.stringify(payload),
      )
      n++
    }
    return n
  })
  const migrated = tx()
  return { migrated }
}

function mapLegacyRow(row: { kind: string; payload: string; task_id: string }): {
  type: string; aggregateType: string; aggregateId: string; payload: unknown
} {
  const payload = JSON.parse(row.payload) as { type?: string; [k: string]: unknown }
  if (row.kind === 'lifecycle') {
    const legacyType = payload.type as string
    const newType = legacyLifecycleTypeMap[legacyType]
    if (!newType) throw new Error(`unknown legacy lifecycle type: ${legacyType}`)
    return {
      type: newType,
      aggregateType: 'Task',
      aggregateId: row.task_id,
      payload: { ...payload, type: newType, taskId: row.task_id },
    }
  }
  if (row.kind === 'agent') {
    const inner = payload as { type: string; runId?: string }
    return mapInnerRuntimeEvent(inner, row.task_id)
  }
  throw new Error(`unknown legacy kind: ${row.kind}`)
}

const legacyLifecycleTypeMap: Record<string, string> = {
  'task.started': 'TaskStarted',
  'task.waiting': 'TaskWaiting',
  'task.session.attached': 'TaskSessionAttached',
  'task.completed': 'TaskCompleted',
  'task.failed': 'TaskFailed',
  'task.cancelled': 'TaskCancelled',
}

function mapInnerRuntimeEvent(
  inner: { type: string; runId?: string },
  taskId: string,
): { type: string; aggregateType: string; aggregateId: string; payload: unknown } {
  const map: Record<string, { type: string; aggregateType: string }> = {
    'run.started': { type: 'RunStarted', aggregateType: 'Run' },
    'run.completed': { type: 'RunCompleted', aggregateType: 'Run' },
    'run.failed': { type: 'RunFailed', aggregateType: 'Run' },
    'run.cancelled': { type: 'RunCancelled', aggregateType: 'Run' },
    'message.started': { type: 'MessageStarted', aggregateType: 'Run' },
    'message.delta': { type: 'MessageDelta', aggregateType: 'Run' },
    'message.completed': { type: 'MessageCompleted', aggregateType: 'Run' },
    'tool.started': { type: 'ToolStarted', aggregateType: 'Run' },
    'tool.completed': { type: 'ToolCompleted', aggregateType: 'Run' },
    'tool.failed': { type: 'ToolFailed', aggregateType: 'Run' },
    'graph.started': { type: 'GraphRunStarted', aggregateType: 'GraphRun' },
    'graph.completed': { type: 'GraphRunCompleted', aggregateType: 'GraphRun' },
    'graph.node.started': { type: 'GraphNodeStarted', aggregateType: 'GraphRun' },
    'graph.node.completed': { type: 'GraphNodeCompleted', aggregateType: 'GraphRun' },
    'graph.node.failed': { type: 'GraphNodeFailed', aggregateType: 'GraphRun' },
  }
  const hit = map[inner.type]
  if (!hit) throw new Error(`unknown legacy inner event type: ${inner.type}`)
  return {
    type: hit.type,
    aggregateType: hit.aggregateType,
    aggregateId: inner.runId ?? `legacy-${taskId}`,
    payload: { ...inner, type: hit.type },
  }
}
```

- [ ] **Step 3: 提交**

```bash
git add apps/controlplane/src/db/migrations/20260414-migrate-task-events.ts
git commit -m "feat(controlplane): 一次性迁移 task_events → event_log 脚本"
```

---

### Task 2: drop `task_events` 表 SQL

**Files:**
- Create: `apps/controlplane/src/db/migrations/20260414-drop-task-events.sql`
- Modify: `apps/controlplane/src/db/schema.ts`（移除 `task_events` 表 DDL）

- [ ] **Step 1: 读取 schema.ts 定位旧 task_events 表 SQL**

- [ ] **Step 2: 写 drop SQL**

```sql
DROP INDEX IF EXISTS idx_task_events_task;
DROP TABLE IF EXISTS task_events;
```

- [ ] **Step 3: 从 schema.ts 的 `SCHEMA_SQL` 中删除 `CREATE TABLE task_events ...` 以及其相关 INDEX**

- [ ] **Step 4: 在启动路径调用顺序：执行 SCHEMA_SQL → 调 `migrateTaskEvents`（一次，可被 UNIQUE 阻止二次） → 执行 drop SQL**

把这个顺序落在 `apps/controlplane/src/db/database.ts` 或 `migrate-cli.ts`：

```ts
db.exec(SCHEMA_SQL)
migrateTaskEvents(db) // 若 Task 1 跳过则此行删
db.exec(DROP_TASK_EVENTS_SQL) // 读取 drop sql 文件
```

- [ ] **Step 5: 跑 cp 测试**

```bash
pnpm --filter @tianji/controlplane test
```

- [ ] **Step 6: 提交**

```bash
git add apps/controlplane/src/db
git commit -m "chore(controlplane): 移除 task_events 表定义并接入迁移"
```

---

### Task 3: 删除 `task-event.ts` 与 `TaskLifecycleType`

**Files:**
- Delete: `packages/shared/src/task-event.ts`
- Modify: `packages/shared/src/index.ts`（删除旧 re-export）

- [ ] **Step 1: `grep` 全仓确认无剩余引用**

```bash
# Grep pattern: "task-event|TaskLifecycleType|TaskEvent"
```

若有残留，多半在：
- `apps/node/src/task/task-executor.ts`（阶段 07 已删，确认残留）
- `apps/controlplane/src/routes/task-events.ts`（阶段 07 已切 envelope，确认）
- 任何 test 里硬编码 "task.started" 字符串（改为 "TaskStarted"）

- [ ] **Step 2: 删除文件**

```bash
git rm packages/shared/src/task-event.ts
```

- [ ] **Step 3: 改 shared index 移除对 task-event 的 re-export**

- [ ] **Step 4: `pnpm check` 全绿**

- [ ] **Step 5: 提交**

```bash
git add packages/shared
git commit -m "chore(shared): 删除 task-event.ts 与 TaskLifecycleType"
```

---

### Task 4: 删除旧 `events.ts` 及 Legacy alias

**Files:**
- Delete: `packages/shared/src/events.ts`
- Modify: `packages/shared/src/index.ts`（移除 Legacy alias 出口）

- [ ] **Step 1: Grep 全仓残留**

```bash
# Grep pattern: "Legacy(Run|Message|Tool|Graph)(Started|Completed|Failed|Cancelled|Delta)"
```

- [ ] **Step 2: 若仍有引用**

可能的残留：旧测试文件、某些 e2e 脚手架。逐个改为新类型。

- [ ] **Step 3: 删除文件**

```bash
git rm packages/shared/src/events.ts
```

- [ ] **Step 4: 改 shared index：移除 Legacy re-export 段落（阶段 01 Task 9 添加的 explicit 名单）**

- [ ] **Step 5: `pnpm check`**

- [ ] **Step 6: 提交**

```bash
git add packages/shared
git commit -m "chore(shared): 删除旧 events.ts 与 Legacy 别名"
```

---

### Task 5: README 更新

**Files:**
- Modify: `packages/shared/README.md`（若存在）
- Modify: `packages/agent/README.md`
- Modify: `packages/observer/README.md`
- Modify: `apps/controlplane/README.md`
- Modify: `apps/node/README.md`（若存在）

- [ ] **Step 1: 逐一读取**

- [ ] **Step 2: 在"事件系统 / 观测"小节下补一段**

```markdown
## 事件系统

tianji-ai 使用 Core / Integration / Protocol 三层事件架构：
- Core：聚合根发射纯 DomainEvent（PascalCase，如 `RunStarted`）。
- Integration：统一 `DomainEventEnvelope` 信封，`correlationId + causationId + sequence` 三件套。
- Protocol：AG-UI / ACP / Daemon SSE / OTel / Observer 都是 EventBus 订阅者。

旧 `RuntimeEvent` / `TaskEvent` 已移除。详见 `docs/superpowers/specs/2026-04-14-event-bus-design.md`。
```

- [ ] **Step 3: 提交**

```bash
git add packages/*/README.md apps/*/README.md
git commit -m "docs: README 更新事件系统说明"
```

---

### Task 6: 全量回归

- [ ] **Step 1: 单测 + 冒烟**

```bash
pnpm -r test
SMOKE_E2E=1 pnpm --filter @tianji/node test:smoke
pnpm check
```

Expected：全绿。

- [ ] **Step 2: 若仍有残留报错，回头修复，单独一个 commit**

---

## Self-Review Checklist

- [ ] `task-event.ts`、旧 `events.ts`、`TaskLifecycleType` 全部删除。
- [ ] `task_events` 表在 schema 中移除；迁移脚本落地（如环境需要）。
- [ ] `pnpm check` 全绿，`pnpm -r test` 全绿，冒烟通过。
- [ ] README 三处以上更新新事件系统描述。
- [ ] 未改动历史提交、未 force push。
