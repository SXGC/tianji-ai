# Shared 协议扩展 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `@tianji/shared` 中新增 V3 分布式架构所需的类型定义——TaskEvent、TaskStatus、Command、Node/Agent 元数据类型。

**Architecture:** 在现有 `packages/shared/src/` 中新增 3 个文件（`task-event.ts`、`command.ts`、`node-types.ts`），扩展 `identifiers.ts` 添加新的品牌类型，通过 `index.ts` 统一导出。所有类型为纯 TypeScript 接口/联合类型，无运行时逻辑依赖。

**Tech Stack:** TypeScript 5.8+, Vitest

**设计文档:** `docs/superpowers/specs/2026-04-03-v3-distributed-node-controlplane-design.md` 第 1.1、4.3、4.5、4.6 节

---

### Task 1: 扩展 identifiers.ts — 添加 TaskId、NodeId、CommandId 品牌类型

**Files:**
- Modify: `packages/shared/src/identifiers.ts`
- Test: `packages/shared/src/__tests__/identifiers.test.ts`

- [ ] **Step 1: 在测试文件末尾追加失败测试**

在 `packages/shared/src/__tests__/identifiers.test.ts` 文件末尾（最外层 `describe` 块内部）追加以下测试：

```typescript
describe('createTaskId', () => {
  it('should create a TaskId from a string', () => {
    const id = createTaskId('task-001')
    expect(id).toBe('task-001')
  })

  it('should return a string at runtime', () => {
    const id = createTaskId('test')
    expect(typeof id).toBe('string')
  })
})

describe('createNodeId', () => {
  it('should create a NodeId from a string', () => {
    const id = createNodeId('node-001')
    expect(id).toBe('node-001')
  })

  it('should return a string at runtime', () => {
    const id = createNodeId('test')
    expect(typeof id).toBe('string')
  })
})

describe('createCommandId', () => {
  it('should create a CommandId from a string', () => {
    const id = createCommandId('cmd-001')
    expect(id).toBe('cmd-001')
  })

  it('should return a string at runtime', () => {
    const id = createCommandId('test')
    expect(typeof id).toBe('string')
  })
})

describe('isTaskId', () => {
  it('should return true for strings', () => {
    expect(isTaskId('any-string')).toBe(true)
  })

  it('should return false for non-strings', () => {
    expect(isTaskId(123)).toBe(false)
    expect(isTaskId(null)).toBe(false)
  })
})

describe('isNodeId', () => {
  it('should return true for strings', () => {
    expect(isNodeId('any-string')).toBe(true)
  })

  it('should return false for non-strings', () => {
    expect(isNodeId(123)).toBe(false)
    expect(isNodeId(null)).toBe(false)
  })
})

describe('isCommandId', () => {
  it('should return true for strings', () => {
    expect(isCommandId('any-string')).toBe(true)
  })

  it('should return false for non-strings', () => {
    expect(isCommandId(123)).toBe(false)
    expect(isCommandId(null)).toBe(false)
  })
})
```

同时在测试文件顶部的 import 中追加新的导入：

```typescript
import {
  type RunId,
  type SessionId,
  type ThreadId,
  type TaskId,
  type NodeId,
  type CommandId,
  createRunId,
  createSessionId,
  createThreadId,
  createTaskId,
  createNodeId,
  createCommandId,
  isRunId,
  isSessionId,
  isThreadId,
  isTaskId,
  isNodeId,
  isCommandId,
} from '../identifiers.js'
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/shared && pnpm test -- --reporter=verbose identifiers`
Expected: FAIL — `createTaskId`, `createNodeId`, `createCommandId`, `isTaskId`, `isNodeId`, `isCommandId` 不存在

- [ ] **Step 3: 在 identifiers.ts 中实现新类型**

在 `packages/shared/src/identifiers.ts` 的 Branded Types 区域追加：

```typescript
/** 唯一标识一个 Task（控制平面创建的长期工作对象） */
export type TaskId = string & { readonly __brand: unique symbol }

/** 唯一标识一个 Node（设备级 agent 管理器） */
export type NodeId = string & { readonly __brand: unique symbol }

/** 唯一标识一个 Command（控制平面下发给 node 的指令） */
export type CommandId = string & { readonly __brand: unique symbol }
```

在 Factory Functions 区域追加：

```typescript
/** @param value - 字符串值，标记为 TaskId */
export function createTaskId(value: string): TaskId {
  return value as TaskId
}

/** @param value - 字符串值，标记为 NodeId */
export function createNodeId(value: string): NodeId {
  return value as NodeId
}

/** @param value - 字符串值，标记为 CommandId */
export function createCommandId(value: string): CommandId {
  return value as CommandId
}
```

在 Type Guards 区域追加：

```typescript
export function isTaskId(value: unknown): value is TaskId {
  return typeof value === 'string'
}

export function isNodeId(value: unknown): value is NodeId {
  return typeof value === 'string'
}

export function isCommandId(value: unknown): value is CommandId {
  return typeof value === 'string'
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/shared && pnpm test -- --reporter=verbose identifiers`
Expected: ALL PASS

- [ ] **Step 5: 运行 pnpm check 确认无错误**

Run: `pnpm check`
Expected: 无错误

- [ ] **Step 6: 提交**

```bash
git add packages/shared/src/identifiers.ts packages/shared/src/__tests__/identifiers.test.ts
git commit -m "feat(shared): add TaskId, NodeId, CommandId branded types"
```

---

### Task 2: 创建 task-event.ts — TaskEvent 类型定义

**Files:**
- Create: `packages/shared/src/task-event.ts`
- Create: `packages/shared/src/__tests__/task-event.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: 编写 task-event.test.ts**

```typescript
import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  TaskEvent,
  TaskLifecycleEvent,
  TaskAgentEvent,
  TaskLifecycleType,
  TaskStatus,
} from '../task-event.js'
import { TASK_STATUSES, TASK_LIFECYCLE_TYPES, isTerminalTaskStatus } from '../task-event.js'
import { createRunId, createSessionId, createTaskId } from '../identifiers.js'

describe('task-event types', () => {
  const taskId = createTaskId('task-001')
  const sessionId = createSessionId('session-001')
  const runId = createRunId('run-001')

  describe('TaskLifecycleEvent', () => {
    it('should construct a task.started lifecycle event', () => {
      const event: TaskLifecycleEvent = {
        kind: 'lifecycle',
        taskId,
        type: 'task.started',
        sequence: 1,
        timestamp: Date.now(),
        sessionId,
        runId,
        summary: 'started analysis',
      }
      expect(event.kind).toBe('lifecycle')
      expect(event.type).toBe('task.started')
    })

    it('should construct a task.completed lifecycle event', () => {
      const event: TaskLifecycleEvent = {
        kind: 'lifecycle',
        taskId,
        type: 'task.completed',
        sequence: 10,
        timestamp: Date.now(),
        summary: 'done',
      }
      expect(event.type).toBe('task.completed')
      expect(event.error).toBeUndefined()
    })

    it('should construct a task.failed lifecycle event with error', () => {
      const event: TaskLifecycleEvent = {
        kind: 'lifecycle',
        taskId,
        type: 'task.failed',
        sequence: 10,
        timestamp: Date.now(),
        error: 'agent crashed',
      }
      expect(event.type).toBe('task.failed')
      expect(event.error).toBe('agent crashed')
    })

    it('should construct a task.waiting lifecycle event', () => {
      const event: TaskLifecycleEvent = {
        kind: 'lifecycle',
        taskId,
        type: 'task.waiting',
        sequence: 5,
        timestamp: Date.now(),
        summary: 'waiting for user input',
      }
      expect(event.type).toBe('task.waiting')
    })

    it('should construct a task.session.attached lifecycle event', () => {
      const event: TaskLifecycleEvent = {
        kind: 'lifecycle',
        taskId,
        type: 'task.session.attached',
        sequence: 2,
        timestamp: Date.now(),
        sessionId,
      }
      expect(event.type).toBe('task.session.attached')
      expect(event.sessionId).toBe(sessionId)
    })
  })

  describe('TaskAgentEvent', () => {
    it('should wrap a RuntimeEvent with task context', () => {
      const event: TaskAgentEvent = {
        kind: 'agent',
        taskId,
        sequence: 3,
        sessionId,
        runId,
        event: {
          type: 'message.delta',
          runId,
          messageId: 'msg-1',
          sequence: 0,
          channel: 'text',
          payload: { content: 'hello' },
          timestamp: Date.now(),
        },
      }
      expect(event.kind).toBe('agent')
      expect(event.event.type).toBe('message.delta')
    })
  })

  describe('TaskEvent discriminated union', () => {
    it('should narrow by kind field', () => {
      const events: TaskEvent[] = [
        {
          kind: 'lifecycle',
          taskId,
          type: 'task.started',
          sequence: 1,
          timestamp: Date.now(),
        },
        {
          kind: 'agent',
          taskId,
          sequence: 2,
          sessionId,
          runId,
          event: {
            type: 'run.started',
            runId,
            sessionId,
            triggerType: 'new',
            timestamp: Date.now(),
          },
        },
      ]

      const lifecycle = events.filter(
        (e): e is TaskLifecycleEvent => e.kind === 'lifecycle'
      )
      const agent = events.filter(
        (e): e is TaskAgentEvent => e.kind === 'agent'
      )

      expect(lifecycle).toHaveLength(1)
      expect(agent).toHaveLength(1)
      expect(lifecycle[0]!.type).toBe('task.started')
      expect(agent[0]!.event.type).toBe('run.started')
    })
  })

  describe('TaskStatus', () => {
    it('should include all expected status values', () => {
      const expected = [
        'pending', 'running', 'waiting',
        'completed', 'failed', 'cancelled', 'observation_lost',
      ]
      expect(TASK_STATUSES).toEqual(expected)
    })

    it('should identify terminal statuses correctly', () => {
      expect(isTerminalTaskStatus('completed')).toBe(true)
      expect(isTerminalTaskStatus('failed')).toBe(true)
      expect(isTerminalTaskStatus('cancelled')).toBe(true)
      expect(isTerminalTaskStatus('observation_lost')).toBe(true)
      expect(isTerminalTaskStatus('pending')).toBe(false)
      expect(isTerminalTaskStatus('running')).toBe(false)
      expect(isTerminalTaskStatus('waiting')).toBe(false)
    })
  })

  describe('TaskLifecycleType', () => {
    it('should include all expected lifecycle types', () => {
      const expected = [
        'task.started', 'task.waiting', 'task.completed',
        'task.failed', 'task.cancelled', 'task.session.attached',
      ]
      expect(TASK_LIFECYCLE_TYPES).toEqual(expected)
    })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/shared && pnpm test -- --reporter=verbose task-event`
Expected: FAIL — 模块 `../task-event.js` 不存在

- [ ] **Step 3: 创建 task-event.ts**

创建 `packages/shared/src/task-event.ts`：

```typescript
/**
 * Task event types for V3 distributed control plane.
 *
 * TaskEvent 是 node 向 controlplane 上报的事件协议。
 * 分为两类：lifecycle（task 生命周期）和 agent（RuntimeEvent 透传）。
 *
 * @module task-event
 */

import type { RunId, SessionId, TaskId } from './identifiers.js'
import type { RuntimeEvent } from './events.js'

// ============================================================================
// Task Status
// ============================================================================

export const TASK_STATUSES = [
  'pending',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
  'observation_lost',
] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]

const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'completed',
  'failed',
  'cancelled',
  'observation_lost',
])

/** 判断 task 状态是否为确定性终态 */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status)
}

// ============================================================================
// Task Lifecycle Types
// ============================================================================

export const TASK_LIFECYCLE_TYPES = [
  'task.started',
  'task.waiting',
  'task.completed',
  'task.failed',
  'task.cancelled',
  'task.session.attached',
] as const

export type TaskLifecycleType = (typeof TASK_LIFECYCLE_TYPES)[number]

// ============================================================================
// Task Events
// ============================================================================

/** Node 生成的 task 生命周期事件 */
export interface TaskLifecycleEvent {
  readonly kind: 'lifecycle'
  readonly taskId: TaskId
  readonly type: TaskLifecycleType
  /** 单调递增序列号，用于去重和排序 */
  readonly sequence: number
  /** Unix 毫秒时间戳 */
  readonly timestamp: number
  readonly sessionId?: SessionId
  readonly runId?: RunId
  readonly summary?: string
  /** task.failed 时携带的错误信息 */
  readonly error?: string
}

/** Agent 产出的 RuntimeEvent 透传包装 */
export interface TaskAgentEvent {
  readonly kind: 'agent'
  readonly taskId: TaskId
  /** 与 lifecycle 事件共享同一递增序列 */
  readonly sequence: number
  readonly sessionId: SessionId
  readonly runId: RunId
  /** 原样透传的 RuntimeEvent */
  readonly event: RuntimeEvent
}

/** TaskEvent 联合类型，NDJSON 流中每行一个 */
export type TaskEvent = TaskLifecycleEvent | TaskAgentEvent
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/shared && pnpm test -- --reporter=verbose task-event`
Expected: ALL PASS

- [ ] **Step 5: 在 index.ts 中导出 task-event 模块**

在 `packages/shared/src/index.ts` 的 `export * from './tool.js'` 行之后追加：

```typescript
export * from './task-event.js'
```

- [ ] **Step 6: 运行 pnpm check 确认无错误**

Run: `pnpm check`
Expected: 无错误

- [ ] **Step 7: 提交**

```bash
git add packages/shared/src/task-event.ts packages/shared/src/__tests__/task-event.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): add TaskEvent, TaskStatus, TaskLifecycleEvent types"
```

---

### Task 3: 创建 command.ts — Command 协议类型

**Files:**
- Create: `packages/shared/src/command.ts`
- Create: `packages/shared/src/__tests__/command.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: 编写 command.test.ts**

```typescript
import { describe, expect, expectTypeOf, it } from 'vitest'
import type {
  Command,
  CommandState,
  TaskRunPayload,
} from '../command.js'
import { COMMAND_STATES, isTerminalCommandState } from '../command.js'
import { createCommandId, createNodeId, createTaskId } from '../identifiers.js'

describe('command types', () => {
  describe('CommandState', () => {
    it('should include all expected states', () => {
      const expected = ['pending', 'leased', 'running', 'completed', 'failed', 'observation_lost']
      expect(COMMAND_STATES).toEqual(expected)
    })

    it('should identify terminal states correctly', () => {
      expect(isTerminalCommandState('completed')).toBe(true)
      expect(isTerminalCommandState('failed')).toBe(true)
      expect(isTerminalCommandState('observation_lost')).toBe(true)
      expect(isTerminalCommandState('pending')).toBe(false)
      expect(isTerminalCommandState('leased')).toBe(false)
      expect(isTerminalCommandState('running')).toBe(false)
    })
  })

  describe('TaskRunPayload', () => {
    it('should construct a payload without sessionIds', () => {
      const payload: TaskRunPayload = {
        taskId: createTaskId('task-001'),
        agentId: 'default',
        goal: 'refactor runtime.ts',
      }
      expect(payload.sessionIds).toBeUndefined()
    })

    it('should construct a payload with sessionIds', () => {
      const payload: TaskRunPayload = {
        taskId: createTaskId('task-001'),
        agentId: 'default',
        goal: 'refactor runtime.ts',
        sessionIds: ['session-a', 'session-b'],
      }
      expect(payload.sessionIds).toHaveLength(2)
    })
  })

  describe('Command', () => {
    it('should construct a task.run command', () => {
      const cmd: Command = {
        commandId: createCommandId('cmd-001'),
        nodeId: createNodeId('node-001'),
        type: 'task.run',
        payload: {
          taskId: createTaskId('task-001'),
          agentId: 'default',
          goal: 'refactor runtime.ts',
        },
        state: 'pending',
        createdAt: Date.now(),
      }
      expect(cmd.type).toBe('task.run')
      expect(cmd.state).toBe('pending')
    })

    it('should allow leased state with leasedAt', () => {
      const cmd: Command = {
        commandId: createCommandId('cmd-001'),
        nodeId: createNodeId('node-001'),
        type: 'task.run',
        payload: {
          taskId: createTaskId('task-001'),
          agentId: 'default',
          goal: 'refactor',
        },
        state: 'leased',
        leasedAt: Date.now(),
        createdAt: Date.now(),
      }
      expect(cmd.state).toBe('leased')
      expect(cmd.leasedAt).toBeDefined()
    })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/shared && pnpm test -- --reporter=verbose command`
Expected: FAIL — 模块 `../command.js` 不存在

- [ ] **Step 3: 创建 command.ts**

创建 `packages/shared/src/command.ts`：

```typescript
/**
 * Command types for V3 control plane → node communication.
 *
 * Command 是控制平面下发给 node 的指令。Node 通过长轮询获取 pending command。
 *
 * @module command
 */

import type { CommandId, NodeId, TaskId } from './identifiers.js'

// ============================================================================
// Command State
// ============================================================================

export const COMMAND_STATES = [
  'pending',
  'leased',
  'running',
  'completed',
  'failed',
  'observation_lost',
] as const

export type CommandState = (typeof COMMAND_STATES)[number]

const TERMINAL_COMMAND_STATES: ReadonlySet<CommandState> = new Set([
  'completed',
  'failed',
  'observation_lost',
])

/** 判断 command 状态是否为终态 */
export function isTerminalCommandState(state: CommandState): boolean {
  return TERMINAL_COMMAND_STATES.has(state)
}

// ============================================================================
// Command Payload
// ============================================================================

/** task.run 指令的 payload */
export interface TaskRunPayload {
  readonly taskId: TaskId
  readonly agentId: string
  readonly goal: string
  /** 可选的已有会话引用；缺失表示 agent 自行创建/选择 session */
  readonly sessionIds?: readonly string[]
}

// ============================================================================
// Command
// ============================================================================

/** 控制平面下发给 node 的指令 */
export interface Command {
  readonly commandId: CommandId
  readonly nodeId: NodeId
  readonly type: 'task.run'
  readonly payload: TaskRunPayload
  readonly state: CommandState
  readonly leasedAt?: number
  readonly completedAt?: number
  readonly createdAt: number
}

/** 长轮询返回给 node 的指令（精简版，不含内部状态字段） */
export interface PollCommandResponse {
  readonly commandId: CommandId
  readonly type: 'task.run'
  readonly payload: TaskRunPayload
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/shared && pnpm test -- --reporter=verbose command`
Expected: ALL PASS

- [ ] **Step 5: 在 index.ts 中导出 command 模块**

在 `packages/shared/src/index.ts` 的 `export * from './task-event.js'` 行之后追加：

```typescript
export * from './command.js'
```

- [ ] **Step 6: 运行 pnpm check 确认无错误**

Run: `pnpm check`
Expected: 无错误

- [ ] **Step 7: 提交**

```bash
git add packages/shared/src/command.ts packages/shared/src/__tests__/command.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): add Command, CommandState, TaskRunPayload types"
```

---

### Task 4: 创建 node-types.ts — Node/Agent 元数据类型

**Files:**
- Create: `packages/shared/src/node-types.ts`
- Create: `packages/shared/src/__tests__/node-types.test.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: 编写 node-types.test.ts**

```typescript
import { describe, expect, it } from 'vitest'
import type {
  AgentInfo,
  NodeExecutionState,
  NodeStatus,
  NodeRegisterRequest,
  NodeRegisterResponse,
  NodeHeartbeatRequest,
} from '../node-types.js'
import { NODE_EXECUTION_STATES, NODE_STATUSES } from '../node-types.js'

describe('node-types', () => {
  describe('NodeExecutionState', () => {
    it('should include idle and busy', () => {
      expect(NODE_EXECUTION_STATES).toEqual(['idle', 'busy'])
    })
  })

  describe('NodeStatus', () => {
    it('should include online and offline', () => {
      expect(NODE_STATUSES).toEqual(['online', 'offline'])
    })
  })

  describe('AgentInfo', () => {
    it('should construct a native agent info', () => {
      const agent: AgentInfo = {
        agentId: 'default',
        type: 'native',
        name: 'default',
        version: '3.0.0',
      }
      expect(agent.type).toBe('native')
    })

    it('should construct a third-party agent info', () => {
      const agent: AgentInfo = {
        agentId: 'claude-code',
        type: 'third-party',
        name: 'Claude Code',
        version: '1.0.0',
      }
      expect(agent.type).toBe('third-party')
    })
  })

  describe('NodeRegisterRequest', () => {
    it('should construct a register request with agent list', () => {
      const req: NodeRegisterRequest = {
        nodeId: 'node-uuid',
        enrollmentToken: 'token-123',
        hostname: 'dev-machine',
        platform: 'linux',
        version: '3.0.0',
        agentList: [
          { agentId: 'default', type: 'native', name: 'default', version: '3.0.0' },
        ],
      }
      expect(req.agentList).toHaveLength(1)
    })
  })

  describe('NodeHeartbeatRequest', () => {
    it('should construct a heartbeat without agent list', () => {
      const req: NodeHeartbeatRequest = {
        executionState: 'idle',
      }
      expect(req.agentList).toBeUndefined()
    })

    it('should construct a heartbeat with agent list update', () => {
      const req: NodeHeartbeatRequest = {
        executionState: 'busy',
        agentList: [
          { agentId: 'default', type: 'native', name: 'default', version: '3.0.0' },
        ],
      }
      expect(req.executionState).toBe('busy')
      expect(req.agentList).toHaveLength(1)
    })
  })

  describe('NodeRegisterResponse', () => {
    it('should construct a register response', () => {
      const res: NodeRegisterResponse = {
        accessToken: 'jwt-token-value',
        expiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000,
      }
      expect(res.accessToken).toBeDefined()
      expect(res.expiresAt).toBeGreaterThan(Date.now())
    })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/shared && pnpm test -- --reporter=verbose node-types`
Expected: FAIL — 模块 `../node-types.js` 不存在

- [ ] **Step 3: 创建 node-types.ts**

创建 `packages/shared/src/node-types.ts`：

```typescript
/**
 * Node and Agent metadata types for V3 distributed architecture.
 *
 * 定义 node 注册、心跳、agent 列表等 node ↔ controlplane 通信的数据结构。
 *
 * @module node-types
 */

// ============================================================================
// Enums
// ============================================================================

export const NODE_EXECUTION_STATES = ['idle', 'busy'] as const
export type NodeExecutionState = (typeof NODE_EXECUTION_STATES)[number]

export const NODE_STATUSES = ['online', 'offline'] as const
export type NodeStatus = (typeof NODE_STATUSES)[number]

// ============================================================================
// Agent Info
// ============================================================================

/** Node 上报的 agent 元数据 */
export interface AgentInfo {
  readonly agentId: string
  readonly type: 'native' | 'third-party'
  readonly name: string
  readonly version: string
}

// ============================================================================
// Node Registration
// ============================================================================

/** Node 注册请求 body */
export interface NodeRegisterRequest {
  readonly nodeId: string
  readonly enrollmentToken: string
  readonly hostname: string
  readonly platform: string
  readonly version: string
  readonly agentList: readonly AgentInfo[]
}

/** Node 注册响应 */
export interface NodeRegisterResponse {
  readonly accessToken: string
  /** Token 过期时间（unix 毫秒） */
  readonly expiresAt: number
}

// ============================================================================
// Heartbeat
// ============================================================================

/** Node 心跳请求 body */
export interface NodeHeartbeatRequest {
  readonly executionState: NodeExecutionState
  /** 仅在本地 agent 配置变更时携带全量快照 */
  readonly agentList?: readonly AgentInfo[]
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/shared && pnpm test -- --reporter=verbose node-types`
Expected: ALL PASS

- [ ] **Step 5: 在 index.ts 中导出 node-types 模块**

在 `packages/shared/src/index.ts` 的 `export * from './command.js'` 行之后追加：

```typescript
export * from './node-types.js'
```

- [ ] **Step 6: 运行 pnpm check 确认无错误**

Run: `pnpm check`
Expected: 无错误

- [ ] **Step 7: 提交**

```bash
git add packages/shared/src/node-types.ts packages/shared/src/__tests__/node-types.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): add Node/Agent metadata types for V3 registration and heartbeat"
```

---

### Task 5: 全量回归测试

**Files:**
- 无新增文件

- [ ] **Step 1: 运行 shared 包全量测试**

Run: `cd packages/shared && pnpm test -- --reporter=verbose`
Expected: ALL PASS（包括所有既有测试 + 4 个新增测试文件）

- [ ] **Step 2: 运行全局 pnpm check**

Run: `pnpm check`
Expected: 无错误、无警告

- [ ] **Step 3: 验证导出完整性**

在 shared 包测试目录运行：

Run: `cd packages/shared && pnpm test -- --reporter=verbose index`
Expected: index.test.ts 通过（验证 re-export 完整性）

如果 `index.test.ts` 中有导出快照测试，可能需要更新快照以包含新导出的类型。

- [ ] **Step 4: 确认构建产物正确**

Run: `cd packages/shared && pnpm build && ls dist/task-event.* dist/command.* dist/node-types.*`
Expected: 每个新模块都有 `.js` 和 `.d.ts` 产物
