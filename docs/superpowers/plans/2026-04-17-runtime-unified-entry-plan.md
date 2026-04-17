# Runtime 统一执行入口实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 CLI、Daemon、Controlplane、ACP 四类入口全部收口到 `@tianji/agent` 的统一入口，再由 `@tianji/runtime` 作为唯一运行控制层执行默认编排图。

**Architecture:** 保留 `@tianji/agent` 与 `@tianji/runtime` 双包，但把 `agent` 收窄成入口适配与默认图装配层，把 `runtime` 扩成面向整张图的运行控制入口。所有旧的 `createAgentSession()`、`AgentRunner`、ACP 直跑链都退出主链，只保留为内部节点执行细节或直接删除。

**Tech Stack:** TypeScript, Vitest, pnpm workspace, `@tianji/agent`, `@tianji/runtime`, `apps/node`

---

## 文件结构与职责

### `packages/agent`

- Modify: `packages/agent/src/index.ts`
  重新导出统一入口 API，停止把旧 session facade 当成主入口能力暴露。
- Create: `packages/agent/src/unified-entry.ts`
  实现统一进程内入口工厂，负责请求解析、默认图装配、executor 注册表创建、调用 runtime 图运行入口。
- Create: `packages/agent/src/unified-entry-types.ts`
  定义统一入口请求、恢复、取消、事件观察器等契约，避免类型散落。
- Create: `packages/agent/src/default-graph-builder.ts`
  把默认图加载/最小图装配收口到统一入口层调用的位置。
- Modify: `packages/agent/src/acp-entry.ts`
  改成 ACP 协议适配层，只把请求转给统一入口，不再自己建 session 主链。
- Modify: `packages/agent/src/daemon-server.ts`
  改成依赖统一入口，而不是持有 `AgentSession + defaultGraph + executorFactory` 三件套。
- Modify: `packages/agent/src/session.ts`
  删除或降级旧 `createAgentSession()` 主链职责；若保留，只允许作为内部兼容薄层，并直接委托统一入口，不能再自己控制主链。
- Test: `packages/agent/src/__tests__/unified-entry.test.ts`
  统一入口单测，覆盖 run / resume / cancel / stream 的顺序与依赖装配。
- Test: `packages/agent/src/__tests__/acp-entry.test.ts`
  更新 ACP 入口测试，断言 ACP 只做协议转发。
- Test: `packages/agent/src/__tests__/daemon-server.test.ts`
  更新 daemon server 测试，断言 HTTP/SSE 只是 unified entry 事件视图。

### `packages/runtime`

- Modify: `packages/runtime/src/runtime/types.ts`
  新增图运行请求、图运行句柄、节点 executor 注册表等类型。
- Create: `packages/runtime/src/runtime/graph-runtime.ts`
  提供面向整张图的运行入口，负责 session/run 创建、图执行、事件流、取消、恢复。
- Modify: `packages/runtime/src/runtime.ts`
  对外导出新的 graph runtime API。
- Modify: `packages/runtime/src/index.ts`
  暴露 graph runtime 能力给 `@tianji/agent`。
- Test: `packages/runtime/src/__tests__/graph-runtime.test.ts`
  验证图运行入口的 run / resume / cancel / stream 主链语义。
- Test: `packages/runtime/src/__tests__/runtime-lifecycle.test.ts`
  扩展断言，确认事件源仍统一由 runtime 发出。

### `apps/node`

- Modify: `apps/node/src/commands/run.ts`
  CLI 单轮改走统一入口，不再 `new AgentRunner()`。
- Modify: `apps/node/src/daemon-entry.ts`
  Daemon 启动改为装配 unified entry，而不是启动时创建长期持有的 `AgentSession`。
- Modify: `apps/node/src/task/task-executor.ts`
  Controlplane 任务执行器改成创建统一入口 runner，不再让 runner 决定主链。
- Modify: `apps/node/src/node-runtime/controlplane-runtime.ts`
  调整依赖注入，确保 cp 任务流转入 unified entry。
- Modify: `apps/node/src/acp/agent-runner.ts`
  删除 ACP 主链假设，仅保留外部 agent 进程桥接或转为节点执行细节。
- Test: `apps/node/src/__tests__/run-e2e.test.ts`
  覆盖 CLI -> unified entry -> runtime 主链。
- Test: `apps/node/src/__tests__/daemon-entry.test.ts`
  覆盖 Daemon -> unified entry -> runtime 主链。
- Test: `apps/node/src/task/__tests__/task-executor.test.ts`
  覆盖 Controlplane -> unified entry -> runtime 主链。
- Test: `apps/node/src/__tests__/opencode-acp-smoke.test.ts`
  覆盖 ACP request -> unified entry -> runtime 主链。

### 文档

- Modify: `packages/agent/README.md`
  如果已有入口说明，更新为 unified entry 模型。
- Modify: `packages/runtime/README.md`
  如果已有 runtime 对外 API 说明，补充 graph runtime 入口。

### 总体验证

- Run: `pnpm --filter @tianji/runtime test`
- Run: `pnpm --filter @tianji/agent test`
- Run: `pnpm --filter apps/node test`
- Run: `pnpm check`

### Task 1: 定义统一入口契约

**Files:**
- Create: `packages/agent/src/unified-entry-types.ts`
- Create: `packages/agent/src/unified-entry.ts`
- Modify: `packages/agent/src/index.ts`
- Test: `packages/agent/src/__tests__/unified-entry.test.ts`

- [ ] **Step 1: 先读完整入口边界文件并记录旧职责冲突点**

Read:
- `packages/agent/src/session.ts`
- `packages/agent/src/acp-entry.ts`
- `packages/agent/src/daemon-server.ts`
- `packages/agent/src/index.ts`

Expected: 能明确列出哪些行为属于旧主链：入口自己建 session、入口自己决定执行后端、入口自己装配默认图后直接运行。

- [ ] **Step 2: 写统一入口契约失败测试**

```ts
import { describe, expect, it, vi } from 'vitest'

import { createUnifiedRuntimeEntry } from '../unified-entry.js'

describe('createUnifiedRuntimeEntry', () => {
  it('assembles default graph before delegating to runtime.runGraph', async () => {
    const loadGraph = vi.fn(async () => ({ id: 'default', version: '1', nodes: [], edges: [] }))
    const createExecutors = vi.fn(() => ({ deepagents: { execute: vi.fn() } }))
    const runGraph = vi.fn(async () => ({ runId: 'run_1', events: [] }))

    const entry = createUnifiedRuntimeEntry({
      loadDefaultGraph: loadGraph,
      createExecutorRegistry: createExecutors,
      runtime: { runGraph, resumeGraph: vi.fn(), cancelRun: vi.fn(), streamRun: vi.fn() },
    })

    await entry.run({ source: 'cli', input: 'hello', agentId: 'demo' })

    expect(loadGraph).toHaveBeenCalledBefore(createExecutors)
    expect(createExecutors).toHaveBeenCalledBefore(runGraph)
  })
})
```

- [ ] **Step 3: 运行单测确认当前失败**

Run: `pnpm --filter @tianji/agent test -- unified-entry.test.ts`

Expected: FAIL，报 `createUnifiedRuntimeEntry` 或新类型文件不存在。

- [ ] **Step 4: 实现最小统一入口类型与工厂**

```ts
export interface UnifiedRunRequest {
  readonly source: 'controlplane' | 'cli' | 'daemon' | 'acp'
  readonly agentId?: string
  readonly input: string
  readonly sessionId?: string
  readonly observer?: UnifiedEventObserver
}

export interface UnifiedRuntimeEntry {
  run(request: UnifiedRunRequest): Promise<UnifiedRunHandle>
  resume(request: UnifiedResumeRequest): Promise<UnifiedRunHandle>
  cancel(request: UnifiedCancelRequest): Promise<void>
  stream(request: UnifiedStreamRequest): AsyncIterable<DomainEvent>
}

export function createUnifiedRuntimeEntry(deps: UnifiedEntryDeps): UnifiedRuntimeEntry {
  return {
    async run(request) {
      const graph = await deps.loadDefaultGraph(request)
      const executors = await deps.createExecutorRegistry(request)
      return deps.runtime.runGraph({ request, graph, executors })
    },
    async resume(request) {
      return deps.runtime.resumeGraph(request)
    },
    async cancel(request) {
      await deps.runtime.cancelRun(request)
    },
    stream(request) {
      return deps.runtime.streamRun(request)
    },
  }
}
```

- [ ] **Step 5: 导出 unified entry API，避免外部继续只看到旧 session facade**

```ts
export {
  createUnifiedRuntimeEntry,
  type UnifiedRuntimeEntry,
  type UnifiedRunRequest,
} from './unified-entry.js'
```

- [ ] **Step 6: 运行 agent 单测确认通过**

Run: `pnpm --filter @tianji/agent test -- unified-entry.test.ts`

Expected: PASS。

- [ ] **Step 7: 提交本任务**

```bash
git add packages/agent/src/unified-entry-types.ts packages/agent/src/unified-entry.ts packages/agent/src/index.ts packages/agent/src/__tests__/unified-entry.test.ts
git commit -m "feat(agent): add unified runtime entry contract"
```

### Task 2: 为 Runtime 增加图运行入口

**Files:**
- Modify: `packages/runtime/src/runtime/types.ts`
- Create: `packages/runtime/src/runtime/graph-runtime.ts`
- Modify: `packages/runtime/src/runtime.ts`
- Modify: `packages/runtime/src/index.ts`
- Test: `packages/runtime/src/__tests__/graph-runtime.test.ts`

- [ ] **Step 1: 先读 runtime 现有执行边界，确认哪些能力可以复用**

Read:
- `packages/runtime/src/runtime/session-runtime.ts`
- `packages/runtime/src/runtime/types.ts`
- `packages/runtime/src/runtime.ts`

Expected: 明确现有 `SessionRuntime` 已有 session/run 生命周期，但还缺“整张图”的一等入口和节点 executor 注册表边界。

- [ ] **Step 2: 写 graph runtime 失败测试**

```ts
import { describe, expect, it, vi } from 'vitest'

import { createGraphRuntime } from '../runtime/graph-runtime.js'

describe('createGraphRuntime', () => {
  it('creates session and emits runtime-controlled graph events', async () => {
    const sessionRuntime = {
      createSession: vi.fn(async () => ({ sessionId: 'session_1' })),
      streamEvents: vi.fn(),
      cancelRun: vi.fn(),
    }

    const runtime = createGraphRuntime({ sessionRuntime })
    const handle = await runtime.runGraph({ graph: { id: 'g', version: '1', nodes: [], edges: [] } })

    expect(handle.sessionId).toBe('session_1')
    expect(sessionRuntime.createSession).toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @tianji/runtime test -- graph-runtime.test.ts`

Expected: FAIL，报 `createGraphRuntime` 未定义。

- [ ] **Step 4: 扩展 runtime 类型，加入 graph run 契约**

```ts
export interface GraphRunRequest {
  readonly graph: OrchestrationGraph
  readonly initialState?: Record<string, unknown>
  readonly executors: GraphExecutorRegistry
  readonly sessionId?: SessionId
  readonly runId?: RunId
}

export interface GraphRunHandle {
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly events: AsyncIterable<DomainEvent>
}

export interface GraphRuntime {
  runGraph(request: GraphRunRequest): Promise<GraphRunHandle>
  resumeGraph(request: ResumeGraphRunRequest): Promise<GraphRunHandle>
  cancelRun(request: CancelGraphRunRequest): Promise<void>
  streamRun(request: StreamGraphRunRequest): AsyncIterable<DomainEvent>
}
```

- [ ] **Step 5: 实现最小 graph runtime，内部复用现有 session runtime 能力**

```ts
export function createGraphRuntime(deps: GraphRuntimeDeps): GraphRuntime {
  return {
    async runGraph(request) {
      const session = await deps.sessionRuntime.createSession({ sessionId: request.sessionId })
      const runId = await deps.graphRunner.start({
        sessionId: session.sessionId,
        graph: request.graph,
        initialState: request.initialState,
        executors: request.executors,
      })

      return {
        sessionId: session.sessionId,
        runId,
        events: deps.sessionRuntime.streamEvents(runId),
      }
    },
    async resumeGraph(request) {
      return deps.graphRunner.resume(request)
    },
    async cancelRun(request) {
      deps.sessionRuntime.cancelRun(request.runId)
    },
    streamRun(request) {
      return deps.sessionRuntime.streamEvents(request.runId)
    },
  }
}
```

- [ ] **Step 6: 对外导出 graph runtime API**

```ts
export {
  createGraphRuntime,
  type GraphRuntime,
  type GraphRunRequest,
  type GraphRunHandle,
} from './runtime/graph-runtime.js'
```

- [ ] **Step 7: 运行 runtime 单测确认通过**

Run: `pnpm --filter @tianji/runtime test -- graph-runtime.test.ts`

Expected: PASS。

- [ ] **Step 8: 提交本任务**

```bash
git add packages/runtime/src/runtime/types.ts packages/runtime/src/runtime/graph-runtime.ts packages/runtime/src/runtime.ts packages/runtime/src/index.ts packages/runtime/src/__tests__/graph-runtime.test.ts
git commit -m "feat(runtime): add graph runtime entry"
```

### Task 3: 把默认图装配收口到统一入口

**Files:**
- Create: `packages/agent/src/default-graph-builder.ts`
- Modify: `packages/agent/src/unified-entry.ts`
- Modify: `packages/agent/src/acp-entry.ts`
- Modify: `packages/agent/src/session.ts`
- Test: `packages/agent/src/__tests__/unified-entry.test.ts`
- Test: `packages/agent/src/__tests__/acp-entry.test.ts`

- [ ] **Step 1: 先读默认图相关文件，确认已有加载器和 executor factory 的可复用点**

Read:
- `packages/agent/src/orchestration/graph-loader.ts`
- `packages/agent/src/orchestration/graph-runner.ts`
- `packages/agent/src/orchestration/executors/deepagents-executor.ts`
- `packages/agent/src/orchestration/executors/acp-executor.ts`

Expected: 明确默认图加载、图编译、executor factory 分别在哪里，避免重复造层。

- [ ] **Step 2: 补失败测试，断言入口必须先构图后运行**

```ts
it('throws when a caller tries to run without a resolved default graph', async () => {
  const entry = createUnifiedRuntimeEntry({
    loadDefaultGraph: async () => {
      throw new Error('default graph is required before runtime execution')
    },
    createExecutorRegistry: vi.fn(),
    runtime: fakeRuntime,
  })

  await expect(entry.run({ source: 'acp', input: 'hello' })).rejects.toThrow(
    'default graph is required before runtime execution'
  )
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter @tianji/agent test -- unified-entry.test.ts acp-entry.test.ts`

Expected: FAIL，说明默认图装配点还没有统一收口。

- [ ] **Step 4: 实现默认图 builder，并让 unified entry 统一调用**

```ts
export async function buildDefaultGraph(request: UnifiedRunRequest, deps: DefaultGraphDeps) {
  if (request.graph !== undefined) {
    return deps.validateGraph(request.graph)
  }

  if (request.agentId !== undefined) {
    return deps.loadGraphForAgent(request.agentId)
  }

  throw new Error('default graph is required before runtime execution')
}
```

- [ ] **Step 5: 把 `acp-entry.ts` 改成协议适配层**

```ts
export async function runAcpAgent(): Promise<void> {
  const context = await loadAgentContext()
  const entry = await createNodeUnifiedEntry(context)

  const connection = new AgentSideConnection((conn) => {
    return new TianjiAcpAgent(conn, {
      run: (request) => entry.run({ source: 'acp', ...request }),
      resume: (request) => entry.resume({ source: 'acp', ...request }),
      cancel: (request) => entry.cancel({ source: 'acp', ...request }),
      stream: (request) => entry.stream(request),
    })
  }, stream)

  await connection.closed
}
```

- [ ] **Step 6: 处理 `session.ts`，禁止它继续做主链控制**

```ts
export async function createAgentSession(): Promise<never> {
  throw new Error('createAgentSession is no longer a valid mainline entry; use createUnifiedRuntimeEntry')
}
```

如果仓库内仍有少量内部调用无法在同一任务内全部切走，可以先改成：

```ts
export async function createAgentSessionFromUnifiedEntry(...) {
  return createSessionFacadeFromUnifiedEntry(...)
}
```

前提：它只是薄转发，不能自己持有 runtime 和 graph 主链。

- [ ] **Step 7: 运行 agent 相关测试确认通过**

Run: `pnpm --filter @tianji/agent test -- unified-entry.test.ts acp-entry.test.ts daemon-server.test.ts`

Expected: PASS。

- [ ] **Step 8: 提交本任务**

```bash
git add packages/agent/src/default-graph-builder.ts packages/agent/src/unified-entry.ts packages/agent/src/acp-entry.ts packages/agent/src/session.ts packages/agent/src/__tests__/unified-entry.test.ts packages/agent/src/__tests__/acp-entry.test.ts
git commit -m "refactor(agent): route default graph assembly through unified entry"
```

### Task 4: 重接 CLI 与 Daemon 入口

**Files:**
- Modify: `apps/node/src/commands/run.ts`
- Modify: `apps/node/src/daemon-entry.ts`
- Modify: `packages/agent/src/daemon-server.ts`
- Test: `apps/node/src/__tests__/run-e2e.test.ts`
- Test: `apps/node/src/__tests__/daemon-entry.test.ts`
- Test: `packages/agent/src/__tests__/daemon-server.test.ts`

- [ ] **Step 1: 先读 CLI / Daemon 现有入口与测试**

Read:
- `apps/node/src/commands/run.ts`
- `apps/node/src/daemon-entry.ts`
- `apps/node/src/__tests__/run-e2e.test.ts`
- `apps/node/src/__tests__/daemon-entry.test.ts`

Expected: 确认哪些断言还写着 ACP 直连或长期 session 假设。

- [ ] **Step 2: 写失败测试，断言 CLI 不再创建 `AgentRunner`**

```ts
it('delegates cli run through unified runtime entry instead of AgentRunner', async () => {
  const run = vi.fn(async () => ({ runId: 'run_1', events: [] }))
  const createEntry = vi.fn(() => ({ run, stream: vi.fn(), resume: vi.fn(), cancel: vi.fn() }))

  await runCommand.handler({
    args: { prompt: 'hello' },
    deps: { createUnifiedEntry: createEntry },
  })

  expect(createEntry).toHaveBeenCalled()
  expect(run).toHaveBeenCalledWith(expect.objectContaining({ source: 'cli', input: 'hello' }))
})
```

- [ ] **Step 3: 运行节点侧测试确认失败**

Run: `pnpm --filter apps/node test -- run-e2e.test.ts daemon-entry.test.ts`

Expected: FAIL，因为 CLI / Daemon 仍依赖旧 session 或 ACP runner。

- [ ] **Step 4: 重写 `run.ts`，改走 unified entry**

```ts
const entry = await createUnifiedEntry(context)
const handle = await entry.run({
  source: 'cli',
  agentId: context.agent.agentName,
  input: prompt,
  observer: createCliObserver(logger),
})

for await (const event of handle.events) {
  await handleRuntimeEvent(event, logger)
}
```

- [ ] **Step 5: 重写 `daemon-entry.ts` 与 `daemon-server.ts`，只保留协议适配与事件转发**

```ts
const entry = await createUnifiedEntry(context)

const server = new DaemonServer({
  entry,
  bus,
  getControlPlaneStatus: () => controlPlaneStatus,
  enterCorrelation,
})
```

`DaemonServer` 内部的 `/chat` 处理改成：

```ts
const handle = await this.#entry.run({
  source: 'daemon',
  agentId: parsed.agentId,
  input: parsed.prompt,
  observer: this.#observer,
})

for await (const _event of handle.events) {
  // SSE 依旧从 runtime 事件视图转发
}
```

- [ ] **Step 6: 运行相关测试确认通过**

Run: `pnpm --filter @tianji/agent test -- daemon-server.test.ts`

Run: `pnpm --filter apps/node test -- run-e2e.test.ts daemon-entry.test.ts`

Expected: PASS。

- [ ] **Step 7: 提交本任务**

```bash
git add apps/node/src/commands/run.ts apps/node/src/daemon-entry.ts packages/agent/src/daemon-server.ts apps/node/src/__tests__/run-e2e.test.ts apps/node/src/__tests__/daemon-entry.test.ts packages/agent/src/__tests__/daemon-server.test.ts
git commit -m "refactor(node): route cli and daemon through unified entry"
```

### Task 5: 重接 Controlplane 与 ACP 入口

**Files:**
- Modify: `apps/node/src/task/task-executor.ts`
- Modify: `apps/node/src/node-runtime/controlplane-runtime.ts`
- Modify: `apps/node/src/acp/agent-runner.ts`
- Modify: `apps/node/src/acp/in-process-runner.ts`
- Test: `apps/node/src/task/__tests__/task-executor.test.ts`
- Test: `apps/node/src/__tests__/controlplane-runtime.test.ts`
- Test: `apps/node/src/__tests__/opencode-acp-smoke.test.ts`

- [ ] **Step 1: 先读 Controlplane / ACP 现有 runner 抽象与测试**

Read:
- `apps/node/src/task/task-executor.ts`
- `apps/node/src/node-runtime/controlplane-runtime.ts`
- `apps/node/src/acp/agent-runner.ts`
- `apps/node/src/acp/in-process-runner.ts`

Expected: 明确哪些代码在“按 native/external 选择主链”，这些逻辑必须退出主链。

- [ ] **Step 2: 写失败测试，断言 task executor 只能调用 unified entry**

```ts
it('hands task requests to unified entry instead of choosing runner chain', async () => {
  const entry = { run: vi.fn(async () => ({ runId: 'run_1', events: [] })) }
  const executor = new TaskExecutor({
    createRunner: async () => {
      throw new Error('runner selection should not happen in task executor anymore')
    },
    createUnifiedEntry: async () => entry,
    ...baseConfig,
  })

  await executor.execute(command)

  expect(entry.run).toHaveBeenCalledWith(expect.objectContaining({ source: 'controlplane' }))
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `pnpm --filter apps/node test -- task-executor.test.ts controlplane-runtime.test.ts opencode-acp-smoke.test.ts`

Expected: FAIL，因为 task executor 仍通过 runner/query 主链执行。

- [ ] **Step 4: 改造 task executor 和 controlplane runtime**

```ts
const handle = await unifiedEntry.run({
  source: 'controlplane',
  agentId: command.payload.agentId,
  input: command.payload.goal,
  sessionId: command.payload.sessionId,
})

for await (const event of handle.events) {
  this.#config.emitEvent(event)
  const mirrored = mirrorRunMessageToTaskMessage(taskId, event, Date.now())
  if (mirrored !== null) this.#config.emitEvent(mirrored)
}
```

- [ ] **Step 5: ACP runner 改成节点执行细节，不再代表主链**

```ts
export class AgentRunner {
  async query(): Promise<never> {
    throw new Error('AgentRunner can no longer be used as a mainline entry; use unified entry')
  }
}
```

如果还有图内 ACP executor 需要复用 ACP client/process 管理能力，只保留：

```ts
export interface AclNodeProcessBridge {
  connect(): Promise<void>
  invokeNode(request: AcpNodeInvocation): AsyncIterable<DomainEvent>
  disconnect(): Promise<void>
}
```

- [ ] **Step 6: 运行节点侧测试确认通过**

Run: `pnpm --filter apps/node test -- task-executor.test.ts controlplane-runtime.test.ts opencode-acp-smoke.test.ts`

Expected: PASS。

- [ ] **Step 7: 提交本任务**

```bash
git add apps/node/src/task/task-executor.ts apps/node/src/node-runtime/controlplane-runtime.ts apps/node/src/acp/agent-runner.ts apps/node/src/acp/in-process-runner.ts apps/node/src/task/__tests__/task-executor.test.ts apps/node/src/__tests__/controlplane-runtime.test.ts apps/node/src/__tests__/opencode-acp-smoke.test.ts
git commit -m "refactor(node): route controlplane and acp through unified entry"
```

### Task 6: 删除旧主链入口并补整链回归

**Files:**
- Modify: `packages/agent/src/session.ts`
- Modify: `packages/agent/src/index.ts`
- Modify: `apps/node/src/acp/index.ts`
- Modify: `apps/node/src/commands/chat.ts`
- Modify: `packages/agent/README.md`
- Modify: `packages/runtime/README.md`
- Test: `packages/agent/src/__tests__/suite/session-e2e.test.ts`
- Test: `apps/node/src/__tests__/native-agent-integration.test.ts`
- Test: `apps/node/src/__tests__/native-agent-routing-integration.test.ts`

- [ ] **Step 1: 先全局搜旧主链入口引用**

Search:
- `createAgentSession(`
- `new AgentRunner(`
- `queryWithGraph(`
- `runAcpAgent(`

Expected: 找出所有还在把旧 API 当主链的调用点。

- [ ] **Step 2: 写失败测试，断言旧 API 已退出主链**

```ts
it('throws when legacy mainline session api is used directly', async () => {
  await expect(createAgentSession(context)).rejects.toThrow(
    'createAgentSession is no longer a valid mainline entry'
  )
})
```

- [ ] **Step 3: 运行失败测试确认还有遗留引用**

Run: `pnpm --filter @tianji/agent test -- session-e2e.test.ts`

Expected: FAIL，说明还有旧主链路径未清理干净。

- [ ] **Step 4: 删除旧主链导出并更新文档**

```ts
export {
  createUnifiedRuntimeEntry,
  type UnifiedRuntimeEntry,
} from './unified-entry.js'

// 不再导出 createAgentSession / resumeAgentSession 作为公共主链 API
```

README 里明确写：

```md
所有入口必须先进入 unified entry，再创建默认图，再进入 runtime graph run。旧 session facade 与 ACP runner 不再是合法主链入口。
```

- [ ] **Step 5: 跑整链测试**

Run: `pnpm --filter @tianji/runtime test`

Run: `pnpm --filter @tianji/agent test`

Run: `pnpm --filter apps/node test`

Expected: 全部 PASS，且能覆盖 Controlplane / CLI / Daemon / ACP 四类入口。

- [ ] **Step 6: 运行仓库级检查并清零所有报错**

Run: `pnpm check`

Expected: PASS，0 error，0 warning，0 info 未修复项。

- [ ] **Step 7: 提交本任务**

```bash
git add packages/agent/src/session.ts packages/agent/src/index.ts apps/node/src/acp/index.ts apps/node/src/commands/chat.ts packages/agent/README.md packages/runtime/README.md packages/agent/src/__tests__/suite/session-e2e.test.ts apps/node/src/__tests__/native-agent-integration.test.ts apps/node/src/__tests__/native-agent-routing-integration.test.ts
git commit -m "refactor: remove legacy runtime entry chains"
```

## 风险与检查点

- 风险 1：`session.ts` 目前直接持有 runtime + graph 主链，拆的时候最容易留下半兼容状态。不能做静默 fallback，必须直接报错暴露。
- 风险 2：`DaemonServer` 和 `TaskExecutor` 现在都围绕“长 session / runner.query()”写的，改造后测试要先跟着改，不然会反向把旧模型留住。
- 风险 3：ACP 有“入口协议”和“图节点 executor”两层语义，计划执行时必须拆清楚，不能继续混成一个 `AgentRunner` 概念。
- 风险 4：如果 `packages/agent/README.md` 或 `packages/runtime/README.md` 当前不存在，执行时需要先确认对应包是否已有 README；没有就不要凭空创建文档噪音，除非该包确实已有公开使用说明。

## 完成定义

- 四类入口都只调用 unified entry。
- Runtime 对外暴露 graph runtime，一切 run / session / event / cancel / resume 都从这里统一发起。
- 默认图一定先于 runtime 执行创建完成。
- ACP 不再是平行主链，只保留为图节点执行方式或协议适配边界。
- `pnpm --filter @tianji/runtime test`、`pnpm --filter @tianji/agent test`、`pnpm --filter apps/node test`、`pnpm check` 全部通过。
