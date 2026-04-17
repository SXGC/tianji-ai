# Command Poll Waiter 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用进程内 waiter 注册表替代 command-poll 路由的 1 秒轮询循环，消除空闲时的无效数据库扫描。

**Architecture:** 新增 `CommandWaiterRegistry` 模块，提供 `wait(nodeId, signal) → Command | null` 和 `notify(nodeId) → void` 两个核心方法。poll 路由先查一次数据库，无任务则注册 waiter 挂起等待；入队代码（TianjiAgent）在 INSERT 事务提交后调用 `notify(nodeId)` 唤醒对应 waiter。数据库 lease 逻辑不变，waiter 只是通知机制。

**Tech Stack:** TypeScript, better-sqlite3, Hono, Vitest

---

## 文件结构

| 操作 | 文件路径 | 职责 |
|------|----------|------|
| 新建 | `apps/controlplane/src/services/command-waiter-registry.ts` | waiter 注册表核心逻辑：wait / notify / cancel |
| 新建 | `apps/controlplane/src/services/__tests__/command-waiter-registry.test.ts` | waiter 注册表单元测试 |
| 修改 | `apps/controlplane/src/routes/command-poll.ts` | 用 waiter 替换 while 循环 |
| 修改 | `apps/controlplane/src/routes/__tests__/command-poll.test.ts` | 补充 waiter 集成测试场景 |
| 修改 | `apps/controlplane/src/agents/tianji-agent.ts` | INSERT 后调用 notify |
| 修改 | `apps/controlplane/src/agents/__tests__/tianji-agent.test.ts` | 验证 notify 被调用 |
| 修改 | `apps/controlplane/src/app.ts` | 创建 registry 实例并注入到路由和 agent |

---

## 现有代码关键位置

| 概念 | 文件 | 行号 |
|------|------|------|
| 1 秒轮询循环 | `routes/command-poll.ts` | 44-61 |
| lease 原子操作 `tryLeasePendingCommand` | `routes/command-poll.ts` | 76-114 |
| `createCommandPollRoute` 签名 | `routes/command-poll.ts` | 19-22 |
| INSERT INTO commands | `agents/tianji-agent.ts` | 104-108 |
| `TianjiAgent` 构造函数 | `agents/tianji-agent.ts` | 48-54 |
| `createApp` 装配点 | `app.ts` | 67 |

---

### Task 1: 实现 CommandWaiterRegistry

**Files:**
- Create: `apps/controlplane/src/services/command-waiter-registry.ts`
- Test: `apps/controlplane/src/services/__tests__/command-waiter-registry.test.ts`

- [ ] **Step 1: 写 waiter 注册表的失败测试 — wait 立即被 notify 唤醒**

```typescript
// apps/controlplane/src/services/__tests__/command-waiter-registry.test.ts
import { afterEach, describe, expect, it } from 'vitest'

import { CommandWaiterRegistry } from '../command-waiter-registry.js'

describe('CommandWaiterRegistry', () => {
  let registry: CommandWaiterRegistry

  afterEach(() => {
    registry?.destroy()
  })

  it('wait 被 notify 唤醒后返回 true', async () => {
    registry = new CommandWaiterRegistry()
    const controller = new AbortController()

    const waitPromise = registry.wait('node-1', controller.signal)

    registry.notify('node-1')

    const result = await waitPromise
    expect(result).toBe(true)
  })
})
```

Run: `pnpm --filter @tianji/controlplane vitest run src/services/__tests__/command-waiter-registry.test.ts`
Expected: FAIL — `CommandWaiterRegistry` 不存在

- [ ] **Step 2: 实现最小 CommandWaiterRegistry 让上面的测试通过**

```typescript
// apps/controlplane/src/services/command-waiter-registry.ts
/**
 * 进程内 command poll waiter 注册表。
 *
 * 用于替代 command-poll 路由中的 1 秒轮询循环。
 * 当 poll 请求没有待处理任务时，注册一个 waiter 挂起等待，
 * 在入队代码 INSERT 提交后通过 notify 唤醒。
 *
 * 设计约束：
 * - 单进程内有效，不跨实例共享
 * - waiter 只是通知机制，不传递数据；真正拿任务仍走数据库 lease
 * - 同一 nodeId 允许多个 waiter 并发等待（多个 poll 请求），notify 全部唤醒
 */
export class CommandWaiterRegistry {
  readonly #waiters = new Map<string, Set<() => void>>()
  #destroyed = false

  /**
   * 注册 waiter 并挂起，直到被 notify 唤醒、signal 中止、或超时。
   *
   * @param nodeId - 目标节点 ID
   * @param signal - AbortSignal，用于客户端断开时取消
   * @returns true 表示被 notify 唤醒，false 表示被中止或超时
   */
  wait(nodeId: string, signal: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      if (this.#destroyed) {
        resolve(false)
        return
      }

      const onNotify = (): void => {
        cleanup()
        resolve(true)
      }

      const onAbort = (): void => {
        cleanup()
        resolve(false)
      }

      const cleanup = (): void => {
        signal.removeEventListener('abort', onAbort)
        const set = this.#waiters.get(nodeId)
        if (set !== undefined) {
          set.delete(onNotify)
          if (set.size === 0) {
            this.#waiters.delete(nodeId)
          }
        }
      }

      signal.addEventListener('abort', onAbort)

      let set = this.#waiters.get(nodeId)
      if (set === undefined) {
        set = new Set()
        this.#waiters.set(nodeId, set)
      }
      set.add(onNotify)
    })
  }

  /**
   * 唤醒指定 nodeId 的所有 waiter。
   *
   * 应在 INSERT INTO commands 事务提交之后调用。
   */
  notify(nodeId: string): void {
    const set = this.#waiters.get(nodeId)
    if (set !== undefined) {
      for (const resolve of set) {
        resolve()
      }
    }
  }

  /** 销毁注册表，唤醒所有 waiter 并拒绝后续 wait 调用。 */
  destroy(): void {
    this.#destroyed = true
    for (const set of this.#waiters.values()) {
      for (const resolve of set) {
        resolve()
      }
    }
    this.#waiters.clear()
  }
}
```

- [ ] **Step 3: 运行测试验证通过**

Run: `pnpm --filter @tianji/controlplane vitest run src/services/__tests__/command-waiter-registry.test.ts`
Expected: PASS

- [ ] **Step 4: 补充测试 — wait 被超时中止返回 false**

```typescript
it('wait 超时未被 notify 时返回 false', async () => {
  registry = new CommandWaiterRegistry()
  const controller = new AbortController()

  setTimeout(() => controller.abort(), 50)

  const result = await registry.wait('node-1', controller.signal)
  expect(result).toBe(false)
})
```

- [ ] **Step 5: 补充测试 — notify 唤醒同一 nodeId 的多个 waiter**

```typescript
it('notify 唤醒同一 nodeId 的所有 waiter', async () => {
  registry = new CommandWaiterRegistry()

  const controller1 = new AbortController()
  const controller2 = new AbortController()

  const p1 = registry.wait('node-1', controller1.signal)
  const p2 = registry.wait('node-1', controller2.signal)

  registry.notify('node-1')

  const [r1, r2] = await Promise.all([p1, p2])
  expect(r1).toBe(true)
  expect(r2).toBe(true)
})
```

- [ ] **Step 6: 补充测试 — notify 不存在的 nodeId 不报错**

```typescript
it('notify 不存在的 nodeId 不报错', () => {
  registry = new CommandWaiterRegistry()
  expect(() => registry.notify('ghost-node')).not.toThrow()
})
```

- [ ] **Step 7: 补充测试 — destroy 唤醒所有等待中的 waiter**

```typescript
it('destroy 唤醒所有等待中的 waiter', async () => {
  registry = new CommandWaiterRegistry()

  const c1 = new AbortController()
  const c2 = new AbortController()

  const p1 = registry.wait('node-1', c1.signal)
  const p2 = registry.wait('node-2', c2.signal)

  registry.destroy()

  const [r1, r2] = await Promise.all([p1, p2])
  expect(r1).toBe(false)
  expect(r2).toBe(false)
})
```

- [ ] **Step 8: 补充测试 — destroy 后再 wait 立即返回 false**

```typescript
it('destroy 后再 wait 立即返回 false', async () => {
  registry = new CommandWaiterRegistry()
  registry.destroy()

  const result = await registry.wait('node-1', new AbortController().signal)
  expect(result).toBe(false)
})
```

- [ ] **Step 9: 运行所有 waiter 测试**

Run: `pnpm --filter @tianji/controlplane vitest run src/services/__tests__/command-waiter-registry.test.ts`
Expected: 全部 PASS

- [ ] **Step 10: Commit**

```bash
git add apps/controlplane/src/services/command-waiter-registry.ts apps/controlplane/src/services/__tests__/command-waiter-registry.test.ts
git commit -m "feat(controlplane): add CommandWaiterRegistry for poll waiter notification"
```

---

### Task 2: 改造 command-poll 路由使用 waiter

**Files:**
- Modify: `apps/controlplane/src/routes/command-poll.ts`
- Modify: `apps/controlplane/src/routes/__tests__/command-poll.test.ts`

- [ ] **Step 1: 修改 `createCommandPollRoute` 签名，接受 registry 参数**

修改 `apps/controlplane/src/routes/command-poll.ts`:

1. 在文件顶部新增 import:

```typescript
import type { CommandWaiterRegistry } from '../services/command-waiter-registry.js'
```

2. 修改函数签名，增加 `registry` 参数:

```typescript
export function createCommandPollRoute(
  db: ControlPlaneDb,
  logger: ObserverLogger,
  registry: CommandWaiterRegistry
): Hono<AuthVariables> {
```

- [ ] **Step 2: 改写路由 handler，用 waiter 替代 while 循环**

替换路由 handler 中 `const deadline = Date.now() + timeout` 到 `return c.body(null, 204)` 的 while 循环部分:

```typescript
    const deadline = Date.now() + timeout
    const timer = new AbortController()
    const timeoutId = setTimeout(() => timer.abort(), deadline - Date.now())

    try {
      while (Date.now() < deadline) {
        const notified = await registry.wait(nodeId, timer.signal)
        if (!notified) {
          return c.body(null, 204)
        }

        if (!isNodeBusy(db, nodeId)) {
          const nextCommand = tryLeasePendingCommand(db, nodeId)
          if (nextCommand !== null) {
            return c.json(nextCommand)
          }
        }
      }
    } finally {
      clearTimeout(timeoutId)
    }

    return c.body(null, 204)
```

注意：保留了循环结构是因为 notify 不保证有任务可 lease（可能被别的请求抢先 lease），所以被唤醒后仍需重新查询。但不再有 `setTimeout(1000)` 的固定间隔轮询。

- [ ] **Step 3: 更新现有测试 — setup 函数注入 registry**

修改 `apps/controlplane/src/routes/__tests__/command-poll.test.ts`:

1. 新增 import:

```typescript
import { CommandWaiterRegistry } from '../../services/command-waiter-registry.js'
```

2. 在 `setup()` 函数中创建 registry 实例，并传给 `createCommandPollRoute`:

```typescript
  async function setup() {
    db = createDatabase(':memory:')
    db.raw
      .prepare('INSERT INTO enrollment_tokens (token, created_at) VALUES (?, ?)')
      .run('valid-token', Date.now())

    const sink = createMemorySink()
    const logger = createObserverLogger({ sinks: [sink] })
    const registry = new CommandWaiterRegistry()
    const app = new Hono()
    app.route('/', createNodeRegisterRoute(db, logger))
    app.route('/', createCommandPollRoute(db, logger, registry))

    const response = await app.request('/api/nodes/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId: 'node-001',
        enrollmentToken: 'valid-token',
        hostname: 'dev',
        platform: 'linux',
        version: '3.0.0',
        agentList: [],
      }),
    })

    accessToken = ((await response.json()) as { accessToken: string }).accessToken
    return { app, registry }
  }
```

3. 更新已有三个测试用例的 `setup()` 调用，解构取 `app`，确保行为不变。

- [ ] **Step 4: 运行已有测试验证无回归**

Run: `pnpm --filter @tianji/controlplane vitest run src/routes/__tests__/command-poll.test.ts`
Expected: 全部 PASS（三个已有测试行为不变）

- [ ] **Step 5: 新增测试 — 入队后立即唤醒等待中的 poll 请求**

在 `command-poll.test.ts` 末尾新增:

```typescript
  it('should return command immediately when notified during wait', async () => {
    const { app, registry } = await setup()
    const now = Date.now()

    const pollPromise = app.request('/api/nodes/node-001/commands/poll?timeout=2000', {
      headers: { Authorization: `Bearer ${accessToken}` },
    })

    await new Promise((resolve) => setTimeout(resolve, 50))

    db.raw
      .prepare(
        `INSERT INTO commands (command_id, node_id, type, payload, state, created_at)
         VALUES ('cmd-notify', 'node-001', 'task.run', ?, 'pending', ?)`
      )
      .run(JSON.stringify({ taskId: 'task-notify', agentId: 'default', goal: 'notify test' }), now)
    db.raw
      .prepare(
        `INSERT INTO tasks (task_id, command_id, node_id, agent_id, goal, status, created_at, updated_at)
         VALUES ('task-notify', 'cmd-notify', 'node-001', 'default', 'notify test', 'pending', ?, ?)`
      )
      .run(now, now)

    registry.notify('node-001')

    const response = await pollPromise
    expect(response.status).toBe(200)

    const data = (await response.json()) as { commandId: string }
    expect(data.commandId).toBe('cmd-notify')
  })
```

- [ ] **Step 6: 新增测试 — 并发 poll 只有一个人 lease 成功**

```typescript
  it('only one concurrent poll should lease the same command', async () => {
    const { app, registry } = await setup()
    const now = Date.now()

    db.raw
      .prepare(
        `INSERT INTO commands (command_id, node_id, type, payload, state, created_at)
         VALUES ('cmd-race', 'node-001', 'task.run', ?, 'pending', ?)`
      )
      .run(JSON.stringify({ taskId: 'task-race', agentId: 'default', goal: 'race test' }), now)
    db.raw
      .prepare(
        `INSERT INTO tasks (task_id, command_id, node_id, agent_id, goal, status, created_at, updated_at)
         VALUES ('task-race', 'cmd-race', 'node-001', 'default', 'race test', 'pending', ?, ?)`
      )
      .run(now, now)

    const [r1, r2] = await Promise.all([
      app.request('/api/nodes/node-001/commands/poll?timeout=100', {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
      app.request('/api/nodes/node-001/commands/poll?timeout=100', {
        headers: { Authorization: `Bearer ${accessToken}` },
      }),
    ])

    const statuses = [r1.status, r2.status].sort()
    expect(statuses).toEqual([200, 204])
  })
```

- [ ] **Step 7: 运行 command-poll 全部测试**

Run: `pnpm --filter @tianji/controlplane vitest run src/routes/__tests__/command-poll.test.ts`
Expected: 全部 PASS

- [ ] **Step 8: Commit**

```bash
git add apps/controlplane/src/routes/command-poll.ts apps/controlplane/src/routes/__tests__/command-poll.test.ts
git commit -m "refactor(controlplane): replace poll loop with CommandWaiterRegistry in command-poll route"
```

---

### Task 3: TianjiAgent 入队后 notify

**Files:**
- Modify: `apps/controlplane/src/agents/tianji-agent.ts`
- Modify: `apps/controlplane/src/agents/__tests__/tianji-agent.test.ts`

- [ ] **Step 1: 修改 TianjiAgent 构造函数，接受 registry 参数**

修改 `apps/controlplane/src/agents/tianji-agent.ts`:

1. 新增 import:

```typescript
import type { CommandWaiterRegistry } from '../services/command-waiter-registry.js'
```

2. 增加 `#registry` 私有字段:

```typescript
  readonly #registry: CommandWaiterRegistry | undefined
```

3. 修改构造函数，增加可选 `registry` 参数:

```typescript
  constructor(
    db: ControlPlaneDb,
    nodeId: string,
    agentId: string,
    bus?: EventBus,
    registry?: CommandWaiterRegistry
  ) {
    super({ description: `Tianji agent for node ${nodeId}` })
    this.#db = db
    this.#nodeId = nodeId
    this.#cpAgentId = agentId
    this.#bus = bus
    this.#registry = registry
  }
```

4. 在 `INSERT INTO commands` 之后（`tianji-agent.ts` 约 108 行后），添加 notify 调用:

```typescript
      this.#registry?.notify(this.#nodeId)
```

注意：better-sqlite3 的 `.run()` 是同步的，执行完毕时事务已提交，所以直接在 `.run()` 后调用 notify 是安全的。

5. 更新 `clone()` 方法:

```typescript
  clone(): TianjiAgent {
    return new TianjiAgent(this.#db, this.#nodeId, this.#cpAgentId, this.#bus, this.#registry)
  }
```

- [ ] **Step 2: 新增测试 — 验证 INSERT 后 registry.notify 被调用**

修改 `apps/controlplane/src/agents/__tests__/tianji-agent.test.ts`:

1. 新增 import:

```typescript
import { CommandWaiterRegistry } from '../../services/command-waiter-registry.js'
```

2. 新增测试:

```typescript
  it('入队后调用 registry.notify 唤醒 poll 等待', async () => {
    db = createDatabase(':memory:')
    setupOnlineNode('node-1')

    const registry = new CommandWaiterRegistry()
    const notifySpy = vi.spyOn(registry, 'notify')

    const agent = new TianjiAgent(db, 'node-1', 'agent-1', undefined, registry)

    await firstValueFrom(
      agent.run({
        messages: [{ id: 'msg-1', role: 'user', content: 'hello' }],
        tools: [],
        context: [],
        forwardedProps: {},
        state: {},
      })
    )

    expect(notifySpy).toHaveBeenCalledWith('node-1')

    registry.destroy()
  })
```

注意：需要在文件顶部或 describe 块内引入 `vi`（vitest 全局变量，globals 已开启）。

- [ ] **Step 3: 运行 tianji-agent 测试**

Run: `pnpm --filter @tianji/controlplane vitest run src/agents/__tests__/tianji-agent.test.ts`
Expected: 全部 PASS

- [ ] **Step 4: Commit**

```bash
git add apps/controlplane/src/agents/tianji-agent.ts apps/controlplane/src/agents/__tests__/tianji-agent.test.ts
git commit -m "feat(controlplane): TianjiAgent notifies CommandWaiterRegistry after enqueue"
```

---

### Task 4: 装配层注入 registry

**Files:**
- Modify: `apps/controlplane/src/app.ts`
- Modify: `apps/controlplane/src/__tests__/app.test.ts`
- Modify: `apps/controlplane/src/routes/copilot.ts` (传递 registry 给 TianjiAgent)

- [ ] **Step 1: 在 `createApp` 中创建 registry 实例并注入**

修改 `apps/controlplane/src/app.ts`:

1. 新增 import:

```typescript
import { CommandWaiterRegistry } from './services/command-waiter-registry.js'
```

2. 在 `createApp` 函数体内创建 registry:

```typescript
  const registry = new CommandWaiterRegistry()
```

3. 将 registry 传给 `createCommandPollRoute`:

```typescript
  app.route('/', createCommandPollRoute(db, logger, registry))
```

4. 将 registry 传给 `createCopilotRoute`:

```typescript
  app.route('/', createCopilotRoute(db, bus, registry))
```

5. 在返回对象的 `monitor` 旁增加 `registry`，以便进程关闭时可调用 `destroy()`:

```typescript
  return {
    app,
    monitor: new ObservationMonitor(db, logger, emitEvent, enterCorrelation),
    registry,
  }
```

6. 更新 `ControlPlaneApp` 接口:

```typescript
export interface ControlPlaneApp {
  readonly app: Hono
  readonly monitor: ObservationMonitor
  readonly registry: CommandWaiterRegistry
}
```

- [ ] **Step 2: 修改 `createCopilotRoute` 接受并传递 registry 给 TianjiAgent**

修改 `apps/controlplane/src/routes/copilot.ts`:

1. 新增 import:

```typescript
import type { CommandWaiterRegistry } from '../services/command-waiter-registry.js'
```

2. 修改函数签名:

```typescript
export function createCopilotRoute(db: ControlPlaneDb, bus?: EventBus, registry?: CommandWaiterRegistry): Hono {
```

3. 修改 TianjiAgent 构造:

```typescript
    const agent = new TianjiAgent(db, nodeId, agentId, bus, registry)
```

- [ ] **Step 3: 更新 app.test.ts 中对 createApp 返回值的断言**

修改 `apps/controlplane/src/__tests__/app.test.ts`:

1. 在第一个测试 `'returns a Hono app with a health endpoint'` 中，增加 registry destroy:

```typescript
    const { app, monitor, registry } = createApp(db, logger)
    // ... existing assertions ...
    monitor.stop()
    registry.destroy()
    db.close()
```

2. 在其余测试中做相同修改。

- [ ] **Step 4: 运行 app 测试**

Run: `pnpm --filter @tianji/controlplane vitest run src/__tests__/app.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/controlplane/src/app.ts apps/controlplane/src/__tests__/app.test.ts apps/controlplane/src/routes/copilot.ts
git commit -m "feat(controlplane): wire CommandWaiterRegistry into app assembly"
```

---

### Task 5: 全量回归测试 + pnpm check

**Files:** 无新增

- [ ] **Step 1: 运行 controlplane 全部测试**

Run: `pnpm --filter @tianji/controlplane vitest run`
Expected: 全部 PASS

- [ ] **Step 2: 运行 pnpm check**

Run: `pnpm check`
Expected: 0 errors, 0 warnings

如有报错，逐个修复后重新运行，直到通过。

- [ ] **Step 3: 最终 commit（如有 lint/type 修复）**

```bash
git add -u
git commit -m "chore(controlplane): fix lint/type issues from waiter integration"
```

---

## 自检清单

| 检查项 | 状态 |
|--------|------|
| Spec 覆盖：waiter 注册表 | Task 1 |
| Spec 覆盖：改 command-poll 路由 | Task 2 |
| Spec 覆盖：改任务入队代码 | Task 3 |
| Spec 覆盖：保留现有 lease 逻辑 | Task 2 Step 2（保留 tryLeasePendingCommand） |
| Spec 覆盖：补测试 | Task 1 + Task 2 + Task 3 |
| Spec 覆盖：跑检查 | Task 5 |
| 无 placeholder | 已确认 |
| 类型一致性：`CommandWaiterRegistry` 在所有文件中同名 | 已确认 |
| notify 在 INSERT 提交后调用 | Task 3 Step 1 注释说明 better-sqlite3 同步特性 |
