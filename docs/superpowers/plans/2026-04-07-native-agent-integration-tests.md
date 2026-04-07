# Node 调用自有 Agent 集成测试 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 node 进程调用自有（native）agent 的完整链路添加集成测试，覆盖 TaskExecutor + InProcessAgentRunner 端到端执行、事件流完整性、错误恢复、以及 ControlPlaneRuntime 的路由集成。

**Architecture:** 测试不 mock IAgentRunner 接口，而是使用真实的 InProcessAgentRunner（mock 底层 `@tianji/agent` 的 `createAgentSession` / `loadAgentContextForName`）。这样可以验证 TaskExecutor 和 InProcessAgentRunner 之间的集成行为，包括状态转换、事件序列化、NDJSON 格式和错误传播。

**Tech Stack:** Vitest, TypeScript, `@tianji/shared` (RuntimeEvent types), `@tianji/agent` (mocked at module boundary)

---

## File Structure

| File | Responsibility |
|------|---------------|
| `apps/node/src/__tests__/native-agent-integration.test.ts` | TaskExecutor + InProcessAgentRunner 端到端集成测试 |
| `apps/node/src/__tests__/native-agent-error-recovery.test.ts` | Runner 错误恢复与资源清理测试 |
| `apps/node/src/__tests__/native-agent-routing-integration.test.ts` | ControlPlaneRuntime 路由到真实 TaskExecutor + InProcessAgentRunner 的集成 |

所有测试共用同一套 `@tianji/agent` mock 策略：在模块级 mock `createAgentSession` 和 `loadAgentContextForName`，让 InProcessAgentRunner 内部逻辑真实执行。

---

### Task 1: TaskExecutor + InProcessAgentRunner 端到端集成

**Files:**
- Create: `apps/node/src/__tests__/native-agent-integration.test.ts`

- [ ] **Step 1: 编写第一个测试 — 完整事件流验证**

```typescript
import { createNodeId, createTaskId, type Command, type RuntimeEvent } from '@tianji/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { InProcessAgentRunner } from '../acp/in-process-runner.js'
import { TaskExecutor } from '../task/task-executor.js'

import type { LoadedAgentContext } from '@tianji/agent'

const createAgentSessionMock = vi.fn()
const loadAgentContextForNameMock = vi.fn()

vi.mock('@tianji/agent', () => ({
  createAgentSession: createAgentSessionMock,
  loadAgentContextForName: loadAgentContextForNameMock,
}))

function createContext(): LoadedAgentContext {
  return {
    paths: {
      configDir: '/tmp/test',
      agentsDir: '/tmp/test/agents',
      logsDir: '/tmp/test/logs',
      configFilePath: '/tmp/test/tianji.json',
      cliLogFilePath: '/tmp/test/logs/tianji.log',
      daemonPortPath: '/tmp/test/daemon.port',
      daemonPidPath: '/tmp/test/daemon.pid',
    },
    config: {},
    agent: {
      agentName: 'default',
      modelRef: 'openai/gpt-4o-mini',
      provider: 'openai',
      modelName: 'gpt-4o-mini',
      providerConfig: undefined,
      soulPath: '/tmp/test/agents/default/SOUL.md',
      soul: 'test soul',
    },
    resolvedEnvVars: [],
    snapshotStore: {} as never,
  }
}

function createCommand(taskId: ReturnType<typeof createTaskId>, goal: string): Command {
  return {
    commandId: `command-${taskId}` as never,
    nodeId: createNodeId('node-001'),
    type: 'task.run',
    state: 'pending',
    createdAt: Date.now(),
    payload: { taskId, agentId: 'reviewer', goal },
  }
}

describe('TaskExecutor + InProcessAgentRunner integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    loadAgentContextForNameMock.mockResolvedValue(createContext())
  })

  it('produces correct NDJSON event sequence for a successful run', async () => {
    const agentEvents: RuntimeEvent[] = [
      {
        type: 'message.delta',
        runId: 'run-1' as never,
        messageId: 'msg-1',
        sequence: 0,
        channel: 'text',
        payload: { content: 'hello' },
        timestamp: 1,
      },
      {
        type: 'run.completed',
        runId: 'run-1' as never,
        sessionId: 'session-1' as never,
        triggerType: 'new',
        timestamp: 2,
      },
    ]

    createAgentSessionMock.mockReturnValue({
      sessionId: 'session-1',
      abort: vi.fn(),
      async *query() {
        for (const event of agentEvents) {
          yield event
        }
      },
    })

    const writes: string[] = []
    const stateChanges: string[] = []

    const executor = new TaskExecutor({
      nodeId: createNodeId('node-001'),
      onExecutionStateChange: (state) => stateChanges.push(state),
      createRunner: async (command) =>
        new InProcessAgentRunner({
          agentId: command.payload.agentId,
          nativeAgentContext: createContext(),
        }),
      openEventStream: async () => ({
        write: async (json: string) => { writes.push(json) },
        writeKeepalive: async () => undefined,
        close: async () => undefined,
        abort: () => undefined,
      }),
    })

    await executor.execute(createCommand(createTaskId('task-001'), 'review this'))

    // 验证状态转换: busy -> idle
    expect(stateChanges).toEqual(['busy', 'idle'])

    // 验证每行都是合法 JSON
    const parsed = writes.map((line) => JSON.parse(line))

    // 验证事件顺序
    expect(parsed[0]).toMatchObject({ kind: 'lifecycle', sequence: 1, type: 'task.started' })
    expect(parsed[1]).toMatchObject({ kind: 'agent', sequence: 2, event: { type: 'message.delta' } })
    expect(parsed[2]).toMatchObject({ kind: 'agent', sequence: 3, event: { type: 'run.completed' } })
    expect(parsed[3]).toMatchObject({ kind: 'lifecycle', sequence: 4, type: 'task.completed' })

    // 验证 sequence 连续无跳跃
    const sequences = parsed.map((p: { sequence: number }) => p.sequence)
    expect(sequences).toEqual([1, 2, 3, 4])

    // 验证执行结束后回到 idle
    expect(executor.executionState).toBe('idle')
    expect(executor.currentTaskId).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试验证失败**

Run: `cd apps/node && pnpm vitest run src/__tests__/native-agent-integration.test.ts`
Expected: PASS（因为使用真实代码 + mock agent session，代码已存在）

- [ ] **Step 3: 添加多事件类型测试 — 验证 tool 事件也正确序列化**

在同一文件的 describe 块内追加：

```typescript
  it('serializes tool events in correct NDJSON format', async () => {
    const agentEvents: RuntimeEvent[] = [
      {
        type: 'tool.started',
        runId: 'run-1' as never,
        toolCallId: 'tc-1',
        invocation: { name: 'read_file', input: { path: '/tmp/foo' } },
        timestamp: 1,
      },
      {
        type: 'tool.completed',
        runId: 'run-1' as never,
        toolCallId: 'tc-1',
        result: { output: 'file content' },
        timestamp: 2,
      },
      {
        type: 'run.completed',
        runId: 'run-1' as never,
        sessionId: 'session-1' as never,
        triggerType: 'new',
        timestamp: 3,
      },
    ]

    createAgentSessionMock.mockReturnValue({
      sessionId: 'session-1',
      abort: vi.fn(),
      async *query() {
        for (const event of agentEvents) {
          yield event
        }
      },
    })

    const writes: string[] = []

    const executor = new TaskExecutor({
      nodeId: createNodeId('node-001'),
      onExecutionStateChange: () => undefined,
      createRunner: async (command) =>
        new InProcessAgentRunner({
          agentId: command.payload.agentId,
          nativeAgentContext: createContext(),
        }),
      openEventStream: async () => ({
        write: async (json: string) => { writes.push(json) },
        writeKeepalive: async () => undefined,
        close: async () => undefined,
        abort: () => undefined,
      }),
    })

    await executor.execute(createCommand(createTaskId('task-002'), 'run tools'))

    const parsed = writes.map((line) => JSON.parse(line))
    expect(parsed).toHaveLength(5)
    expect(parsed[1]).toMatchObject({
      kind: 'agent',
      sequence: 2,
      event: { type: 'tool.started', invocation: { name: 'read_file' } },
    })
    expect(parsed[2]).toMatchObject({
      kind: 'agent',
      sequence: 3,
      event: { type: 'tool.completed', result: { output: 'file content' } },
    })
  })
```

- [ ] **Step 4: 添加 run.completed 去重集成测试**

验证 InProcessAgentRunner 的去重逻辑在 TaskExecutor 管道中生效：

```typescript
  it('deduplicates repeated run.completed events through the full pipeline', async () => {
    const completed: RuntimeEvent = {
      type: 'run.completed',
      runId: 'run-1' as never,
      sessionId: 'session-1' as never,
      triggerType: 'new',
      timestamp: 1,
    }

    createAgentSessionMock.mockReturnValue({
      sessionId: 'session-1',
      abort: vi.fn(),
      async *query() {
        yield completed
        yield completed
        yield completed
      },
    })

    const writes: string[] = []

    const executor = new TaskExecutor({
      nodeId: createNodeId('node-001'),
      onExecutionStateChange: () => undefined,
      createRunner: async (command) =>
        new InProcessAgentRunner({
          agentId: command.payload.agentId,
          nativeAgentContext: createContext(),
        }),
      openEventStream: async () => ({
        write: async (json: string) => { writes.push(json) },
        writeKeepalive: async () => undefined,
        close: async () => undefined,
        abort: () => undefined,
      }),
    })

    await executor.execute(createCommand(createTaskId('task-003'), 'dedup test'))

    const parsed = writes.map((line) => JSON.parse(line))
    // task.started + 1x run.completed (deduped) + task.completed = 3
    expect(parsed).toHaveLength(3)
    expect(parsed[1]).toMatchObject({ kind: 'agent', event: { type: 'run.completed' } })
  })
```

- [ ] **Step 5: 运行测试**

Run: `cd apps/node && pnpm vitest run src/__tests__/native-agent-integration.test.ts`
Expected: ALL PASS

- [ ] **Step 6: 提交**

```bash
git add apps/node/src/__tests__/native-agent-integration.test.ts
git commit -m "test(node): add TaskExecutor + InProcessAgentRunner end-to-end integration tests"
```

---

### Task 2: Runner 错误恢复与资源清理

**Files:**
- Create: `apps/node/src/__tests__/native-agent-error-recovery.test.ts`

- [ ] **Step 1: 编写 connect 失败测试**

```typescript
import { createNodeId, createTaskId, type Command } from '@tianji/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { InProcessAgentRunner } from '../acp/in-process-runner.js'
import { TaskExecutor } from '../task/task-executor.js'

import type { LoadedAgentContext } from '@tianji/agent'

const createAgentSessionMock = vi.fn()
const loadAgentContextForNameMock = vi.fn()

vi.mock('@tianji/agent', () => ({
  createAgentSession: createAgentSessionMock,
  loadAgentContextForName: loadAgentContextForNameMock,
}))

function createContext(): LoadedAgentContext {
  return {
    paths: {
      configDir: '/tmp/test',
      agentsDir: '/tmp/test/agents',
      logsDir: '/tmp/test/logs',
      configFilePath: '/tmp/test/tianji.json',
      cliLogFilePath: '/tmp/test/logs/tianji.log',
      daemonPortPath: '/tmp/test/daemon.port',
      daemonPidPath: '/tmp/test/daemon.pid',
    },
    config: {},
    agent: {
      agentName: 'default',
      modelRef: 'openai/gpt-4o-mini',
      provider: 'openai',
      modelName: 'gpt-4o-mini',
      providerConfig: undefined,
      soulPath: '/tmp/test/agents/default/SOUL.md',
      soul: 'test soul',
    },
    resolvedEnvVars: [],
    snapshotStore: {} as never,
  }
}

function createCommand(taskId: ReturnType<typeof createTaskId>, goal: string): Command {
  return {
    commandId: `command-${taskId}` as never,
    nodeId: createNodeId('node-001'),
    type: 'task.run',
    state: 'pending',
    createdAt: Date.now(),
    payload: { taskId, agentId: 'reviewer', goal },
  }
}

describe('Native agent error recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('recovers to idle when loadAgentContextForName fails during connect', async () => {
    loadAgentContextForNameMock.mockRejectedValue(new Error('agent config not found'))

    const writes: string[] = []
    const stateChanges: string[] = []

    const executor = new TaskExecutor({
      nodeId: createNodeId('node-001'),
      onExecutionStateChange: (state) => stateChanges.push(state),
      createRunner: async (command) =>
        new InProcessAgentRunner({
          agentId: command.payload.agentId,
          nativeAgentContext: createContext(),
        }),
      openEventStream: async () => ({
        write: async (json: string) => { writes.push(json) },
        writeKeepalive: async () => undefined,
        close: async () => undefined,
        abort: () => undefined,
      }),
    })

    await expect(
      executor.execute(createCommand(createTaskId('task-err-1'), 'will fail'))
    ).rejects.toThrow('agent config not found')

    // 状态回到 idle
    expect(executor.executionState).toBe('idle')
    expect(executor.currentTaskId).toBeNull()
    expect(stateChanges).toEqual(['busy', 'idle'])

    // 写了 task.started 和 task.failed
    const parsed = writes.map((line) => JSON.parse(line))
    expect(parsed[0]).toMatchObject({ kind: 'lifecycle', type: 'task.started' })
    expect(parsed[parsed.length - 1]).toMatchObject({
      kind: 'lifecycle',
      type: 'task.failed',
      error: 'agent config not found',
    })
  })

  it('writes task.failed when query throws mid-stream and cleans up runner', async () => {
    loadAgentContextForNameMock.mockResolvedValue(createContext())

    const abort = vi.fn()
    createAgentSessionMock.mockReturnValue({
      sessionId: 'session-1',
      abort,
      async *query() {
        yield {
          type: 'message.delta',
          runId: 'run-1' as never,
          messageId: 'msg-1',
          sequence: 0,
          channel: 'text' as const,
          payload: { content: 'partial' },
          timestamp: 1,
        }
        throw new Error('provider rate limited')
      },
    })

    const writes: string[] = []

    const executor = new TaskExecutor({
      nodeId: createNodeId('node-001'),
      onExecutionStateChange: () => undefined,
      createRunner: async (command) =>
        new InProcessAgentRunner({
          agentId: command.payload.agentId,
          nativeAgentContext: createContext(),
        }),
      openEventStream: async () => ({
        write: async (json: string) => { writes.push(json) },
        writeKeepalive: async () => undefined,
        close: async () => undefined,
        abort: () => undefined,
      }),
    })

    await expect(
      executor.execute(createCommand(createTaskId('task-err-2'), 'mid-stream fail'))
    ).rejects.toThrow('provider rate limited')

    const parsed = writes.map((line) => JSON.parse(line))

    // task.started -> message.delta -> task.failed
    expect(parsed[0]).toMatchObject({ kind: 'lifecycle', type: 'task.started' })
    expect(parsed[1]).toMatchObject({ kind: 'agent', event: { type: 'message.delta' } })
    expect(parsed[parsed.length - 1]).toMatchObject({
      kind: 'lifecycle',
      type: 'task.failed',
      error: 'provider rate limited',
    })

    // runner.disconnect 调用了 session.abort
    expect(abort).toHaveBeenCalled()

    // executor 回到 idle，可接受新任务
    expect(executor.executionState).toBe('idle')
  })

  it('can execute a new task after a failed one', async () => {
    loadAgentContextForNameMock.mockResolvedValue(createContext())

    // 第一次调用失败
    createAgentSessionMock.mockReturnValueOnce({
      sessionId: 'session-1',
      abort: vi.fn(),
      async *query() {
        throw new Error('first run failed')
      },
    })

    // 第二次调用成功
    createAgentSessionMock.mockReturnValueOnce({
      sessionId: 'session-2',
      abort: vi.fn(),
      async *query() {
        yield {
          type: 'run.completed',
          runId: 'run-2' as never,
          sessionId: 'session-2' as never,
          triggerType: 'new',
          timestamp: 1,
        }
      },
    })

    const writes: string[] = []

    const executor = new TaskExecutor({
      nodeId: createNodeId('node-001'),
      onExecutionStateChange: () => undefined,
      createRunner: async (command) =>
        new InProcessAgentRunner({
          agentId: command.payload.agentId,
          nativeAgentContext: createContext(),
        }),
      openEventStream: async () => ({
        write: async (json: string) => { writes.push(json) },
        writeKeepalive: async () => undefined,
        close: async () => undefined,
        abort: () => undefined,
      }),
    })

    // 第一次失败
    await expect(
      executor.execute(createCommand(createTaskId('task-fail'), 'will fail'))
    ).rejects.toThrow('first run failed')

    // 清空记录
    writes.length = 0

    // 第二次成功
    await executor.execute(createCommand(createTaskId('task-ok'), 'will succeed'))

    const parsed = writes.map((line) => JSON.parse(line))
    expect(parsed[0]).toMatchObject({ kind: 'lifecycle', type: 'task.started' })
    expect(parsed[parsed.length - 1]).toMatchObject({ kind: 'lifecycle', type: 'task.completed' })
  })
})
```

- [ ] **Step 2: 运行测试**

Run: `cd apps/node && pnpm vitest run src/__tests__/native-agent-error-recovery.test.ts`
Expected: ALL PASS

- [ ] **Step 3: 提交**

```bash
git add apps/node/src/__tests__/native-agent-error-recovery.test.ts
git commit -m "test(node): add native agent error recovery integration tests"
```

---

### Task 3: ControlPlaneRuntime 路由集成（不 mock runner 构造器）

**Files:**
- Create: `apps/node/src/__tests__/native-agent-routing-integration.test.ts`

- [ ] **Step 1: 编写路由集成测试**

与现有 `controlplane-runtime.test.ts` 不同，这里不 mock `AgentRunner` / `InProcessAgentRunner` 构造器，而是让默认 `createRunner` 真实执行，验证从 ControlPlaneRuntime 到 InProcessAgentRunner 的完整路由。

```typescript
import { createNodeId, createTaskId, type Command } from '@tianji/shared'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { ControlPlaneConnectionLike } from '../node-runtime/controlplane-runtime.js'
import { createControlPlaneRuntime } from '../node-runtime/controlplane-runtime.js'

import type { LoadedAgentContext } from '@tianji/agent'

const createAgentSessionMock = vi.fn()
const loadAgentContextForNameMock = vi.fn()

vi.mock('@tianji/agent', () => ({
  createAgentSession: createAgentSessionMock,
  loadAgentContextForName: loadAgentContextForNameMock,
}))

function createContext(): LoadedAgentContext {
  return {
    paths: {
      configDir: '/tmp/test',
      agentsDir: '/tmp/test/agents',
      logsDir: '/tmp/test/logs',
      configFilePath: '/tmp/test/tianji.json',
      cliLogFilePath: '/tmp/test/logs/tianji.log',
      daemonPortPath: '/tmp/test/daemon.port',
      daemonPidPath: '/tmp/test/daemon.pid',
    },
    config: {},
    agent: {
      agentName: 'default',
      modelRef: 'openai/gpt-4o-mini',
      provider: 'openai',
      modelName: 'gpt-4o-mini',
      providerConfig: undefined,
      soulPath: '/tmp/test/agents/default/SOUL.md',
      soul: 'test soul',
    },
    resolvedEnvVars: [],
    snapshotStore: {} as never,
  }
}

function createConnectionDouble(): ControlPlaneConnectionLike {
  return {
    start: vi.fn(async () => undefined),
    stop: vi.fn(),
    setExecutionState: vi.fn(),
    client: {
      openEventStream: vi.fn(async () => ({
        write: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        abort: vi.fn(),
        writeKeepalive: vi.fn(async () => undefined),
      })),
    },
  }
}

function createTestCommand(): Command {
  return {
    commandId: 'cmd-int-001' as never,
    nodeId: createNodeId('node-test'),
    type: 'task.run',
    state: 'pending',
    createdAt: Date.now(),
    payload: {
      taskId: createTaskId('task-int-001'),
      agentId: 'reviewer',
      goal: 'integration test goal',
    },
  }
}

describe('ControlPlaneRuntime native agent routing integration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    loadAgentContextForNameMock.mockResolvedValue(createContext())
    createAgentSessionMock.mockReturnValue({
      sessionId: 'session-1',
      abort: vi.fn(),
      async *query() {
        yield {
          type: 'run.completed',
          runId: 'run-1' as never,
          sessionId: 'session-1' as never,
          triggerType: 'new',
          timestamp: 1,
        }
      },
    })
  })

  it('routes native agent through real InProcessAgentRunner and completes task', async () => {
    const writes: string[] = []
    const connectionDouble: ControlPlaneConnectionLike = {
      start: vi.fn(async () => undefined),
      stop: vi.fn(),
      setExecutionState: vi.fn(),
      client: {
        openEventStream: vi.fn(async () => ({
          write: vi.fn(async (json: string) => { writes.push(json) }),
          close: vi.fn(async () => undefined),
          abort: vi.fn(),
          writeKeepalive: vi.fn(async () => undefined),
        })),
      },
    }

    const runtime = createControlPlaneRuntime(
      {
        baseUrl: 'http://localhost:3000',
        nodeId: createNodeId('node-test'),
        enrollmentToken: 'test-token',
        hostname: 'testhost',
        platform: 'linux',
        version: '1.0.0',
        agentList: [],
        agentConfigs: {
          reviewer: { model: 'openai/gpt-4o-mini' },
        },
        nativeAgentContext: createContext(),
      },
      {
        createConnection: () => connectionDouble,
      }
    )

    await runtime.onCommand(createTestCommand())

    // 验证 loadAgentContextForName 被真实调用（不是 mock 的 runner 构造器）
    expect(loadAgentContextForNameMock).toHaveBeenCalledWith('reviewer', expect.any(Object))
    expect(createAgentSessionMock).toHaveBeenCalled()

    // 验证事件写入
    const parsed = writes.map((line) => JSON.parse(line))
    expect(parsed[0]).toMatchObject({ kind: 'lifecycle', type: 'task.started' })
    expect(parsed[parsed.length - 1]).toMatchObject({ kind: 'lifecycle', type: 'task.completed' })

    // 验证执行状态回到 idle
    expect(connectionDouble.setExecutionState).toHaveBeenCalledWith('busy')
    expect(connectionDouble.setExecutionState).toHaveBeenLastCalledWith('idle')
  })

  it('propagates agent session failure through the full runtime stack', async () => {
    loadAgentContextForNameMock.mockRejectedValue(new Error('soul file missing'))

    const connectionDouble = createConnectionDouble()

    const runtime = createControlPlaneRuntime(
      {
        baseUrl: 'http://localhost:3000',
        nodeId: createNodeId('node-test'),
        enrollmentToken: 'test-token',
        hostname: 'testhost',
        platform: 'linux',
        version: '1.0.0',
        agentList: [],
        agentConfigs: {
          reviewer: { model: 'openai/gpt-4o-mini' },
        },
        nativeAgentContext: createContext(),
      },
      {
        createConnection: () => connectionDouble,
      }
    )

    // onCommand 会抛出错误
    await expect(runtime.onCommand(createTestCommand())).rejects.toThrow('soul file missing')

    // 状态最终回到 idle
    expect(connectionDouble.setExecutionState).toHaveBeenLastCalledWith('idle')
  })
})
```

- [ ] **Step 2: 运行测试**

Run: `cd apps/node && pnpm vitest run src/__tests__/native-agent-routing-integration.test.ts`
Expected: ALL PASS

- [ ] **Step 3: 运行全量测试回归**

Run: `cd apps/node && pnpm vitest run`
Expected: ALL PASS, 无回归

- [ ] **Step 4: 运行 pnpm check**

Run: `pnpm check`
Expected: 无错误、无警告

- [ ] **Step 5: 提交**

```bash
git add apps/node/src/__tests__/native-agent-routing-integration.test.ts
git commit -m "test(node): add ControlPlaneRuntime native agent routing integration tests"
```
