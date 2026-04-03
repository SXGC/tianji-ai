# Node 重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `apps/cli` 重命名为 `apps/node`，接入 ACP 客户端协议管理本地 agent（包括原生和第三方），迁移 Daemon 架构为 ACP subprocess 模式，新增控制平面连接模块（注册、心跳、长轮询、事件上报）和 Node 侧 Task 管理。

**Architecture:** `apps/node` 作为设备级 agent 管理器，通过 `@agentclientprotocol/sdk` 的 `ClientSideConnection` spawn 原生 agent 子进程并通过 ACP stdio 通信。Node 不再直接 import `@tianji/agent` 或 `@tianji/runtime`，仅依赖 `@tianji/shared`（类型）和 `@tianji/observer`（日志）。控制平面连接为可选模块，不启用时仍可本地使用。

**Tech Stack:** TypeScript, `@agentclientprotocol/sdk ^0.18.0`, Vitest

**设计文档:** `docs/superpowers/specs/2026-04-03-v3-distributed-node-controlplane-design.md` 第 3.1、4.2-4.6、5.1-5.4 节

**前置依赖:** `01-shared-protocol` 和 `02-agent-acp` 完成

---

### Task 1: 重命名 apps/cli → apps/node

**Files:**
- Rename: `apps/cli/` → `apps/node/`
- Modify: `apps/node/package.json`（包名 `@tianji/cli` → `@tianji/node`）
- Modify: 根 `package.json`（若有 `scripts` 引用 `@tianji/cli`）

- [ ] **Step 1: 移动目录**

Run: `cd /workspaces/dev_docker/tianji-ai && git mv apps/cli apps/node`

- [ ] **Step 2: 更新 package.json 包名**

修改 `apps/node/package.json`：将 `"name": "@tianji/cli"` 改为 `"name": "@tianji/node"`。

- [ ] **Step 3: 更新根 package.json 中的引用**

查找并替换所有引用 `@tianji/cli` 的地方：

Run: `cd /workspaces/dev_docker/tianji-ai && grep -r "@tianji/cli" --include="*.json" --include="*.ts" --include="*.mjs" -l`

对搜索结果中的每个文件，将 `@tianji/cli` 替换为 `@tianji/node`。

- [ ] **Step 4: 安装依赖确认 workspace 解析正常**

Run: `pnpm install`
Expected: 无报错，workspace 包名正确解析

- [ ] **Step 5: 运行 pnpm check**

Run: `pnpm check`
Expected: 无错误（可能有 import 路径需要调整）

- [ ] **Step 6: 运行既有测试确认不破坏**

Run: `cd apps/node && pnpm test -- --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "refactor: rename apps/cli to apps/node"
```

---

### Task 2: 替换 @tianji/agent 和 @tianji/runtime 依赖，添加 ACP SDK

**Files:**
- Modify: `apps/node/package.json`

根据设计文档依赖矩阵，`apps/node` 只允许依赖 `@tianji/shared`、`@tianji/observer`、`@agentclientprotocol/sdk`。

- [ ] **Step 1: 移除旧依赖，添加新依赖**

Run:
```bash
cd /workspaces/dev_docker/tianji-ai
pnpm --filter @tianji/node remove @tianji/agent @tianji/runtime
pnpm --filter @tianji/node add @agentclientprotocol/sdk@^0.18.0
```

注意：如果 `@tianji/observer` 还未在依赖中，也添加：

Run: `pnpm --filter @tianji/node add @tianji/observer@workspace:*`

- [ ] **Step 2: 确认 package.json 依赖列表正确**

`apps/node/package.json` 的 `dependencies` 应为：
```json
{
  "@tianji/shared": "workspace:*",
  "@tianji/observer": "workspace:*",
  "@agentclientprotocol/sdk": "^0.18.0"
}
```

- [ ] **Step 3: 暂时注释掉所有编译错误的 import**

此步骤会导致大量编译错误（旧代码 import 了 `@tianji/agent`）。将所有直接依赖 `@tianji/agent` 的文件中的相关 import 暂时注释，后续 Task 逐步替换。

涉及文件：
- `apps/node/src/commands/run.ts` — `createAgentSession` import
- `apps/node/src/daemon-entry.ts` — `DaemonServer`, `createAgentSession`, `loadAgentContext` import
- `apps/node/src/commands/daemon.ts` — `DaemonClient` import
- `apps/node/src/commands/chat.ts` — `DaemonClient` import

在每个文件的 `@tianji/agent` import 行上方添加 `// TODO(v3): replace with ACP client`，并注释掉该 import。在函数体中添加 `throw new Error('TODO: migrate to ACP')` 占位。

- [ ] **Step 4: 运行 pnpm check 确认 typecheck 不报模块找不到错误**

Run: `pnpm check`
Expected: 可能有 unused variable 警告，但无 `@tianji/agent` 模块找不到错误

- [ ] **Step 5: 提交**

```bash
git add apps/node/package.json pnpm-lock.yaml apps/node/src/commands/run.ts apps/node/src/daemon-entry.ts apps/node/src/commands/daemon.ts apps/node/src/commands/chat.ts
git commit -m "refactor(node): replace @tianji/agent dependency with ACP SDK"
```

---

### Task 3: 实现 ACP 客户端适配层 — Agent 进程管理

**Files:**
- Create: `apps/node/src/acp/agent-process.ts`
- Create: `apps/node/src/acp/__tests__/agent-process.test.ts`

- [ ] **Step 1: 编写 agent-process.test.ts**

```typescript
import { describe, expect, it, vi, afterEach } from 'vitest'
import type { AgentProcessConfig } from '../agent-process.js'
import { AgentProcessManager } from '../agent-process.js'

describe('AgentProcessManager', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('should store agent config on construction', () => {
    const config: AgentProcessConfig = {
      agentId: 'default',
      binaryPath: '/usr/local/bin/tianji-agent',
      args: [],
    }
    const manager = new AgentProcessManager(config)
    expect(manager.agentId).toBe('default')
    expect(manager.isRunning).toBe(false)
  })

  it('should report not running before spawn', () => {
    const config: AgentProcessConfig = {
      agentId: 'default',
      binaryPath: '/usr/local/bin/tianji-agent',
      args: [],
    }
    const manager = new AgentProcessManager(config)
    expect(manager.isRunning).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/node && pnpm test -- --reporter=verbose agent-process`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 agent-process.ts**

创建 `apps/node/src/acp/agent-process.ts`：

```typescript
/**
 * Agent subprocess manager.
 *
 * 负责 spawn 原生或第三方 ACP agent 子进程，
 * 管理进程生命周期，提供 stdin/stdout stream 给 ACP ClientSideConnection 使用。
 *
 * @module acp/agent-process
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { Readable, Writable } from 'node:stream'

export interface AgentProcessConfig {
  readonly agentId: string
  readonly binaryPath: string
  readonly args?: readonly string[]
  readonly env?: Record<string, string>
}

export class AgentProcessManager {
  readonly agentId: string
  readonly #config: AgentProcessConfig
  #process: ChildProcess | null = null

  constructor(config: AgentProcessConfig) {
    this.agentId = config.agentId
    this.#config = config
  }

  get isRunning(): boolean {
    return this.#process !== null && this.#process.exitCode === null
  }

  /**
   * Spawn agent 子进程，返回 Web ReadableStream/WritableStream 供 ACP ndJsonStream 使用。
   */
  spawn(): { input: ReadableStream<Uint8Array>; output: WritableStream<Uint8Array> } {
    if (this.#process) {
      throw new Error(`Agent ${this.agentId} is already running`)
    }

    this.#process = spawn(this.#config.binaryPath, [...(this.#config.args ?? [])], {
      stdio: ['pipe', 'pipe', 'inherit'],
      env: { ...process.env, ...this.#config.env },
    })

    this.#process.on('exit', () => {
      this.#process = null
    })

    const stdout = this.#process.stdout!
    const stdin = this.#process.stdin!

    return {
      input: Readable.toWeb(stdout) as ReadableStream<Uint8Array>,
      output: Writable.toWeb(stdin) as WritableStream<Uint8Array>,
    }
  }

  /** 终止 agent 子进程 */
  async kill(): Promise<void> {
    if (!this.#process) return
    this.#process.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.#process?.kill('SIGKILL')
        resolve()
      }, 5000)
      this.#process!.on('exit', () => {
        clearTimeout(timeout)
        resolve()
      })
    })
    this.#process = null
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/node && pnpm test -- --reporter=verbose agent-process`
Expected: ALL PASS

- [ ] **Step 5: 提交**

```bash
git add apps/node/src/acp/agent-process.ts apps/node/src/acp/__tests__/agent-process.test.ts
git commit -m "feat(node): implement AgentProcessManager for ACP subprocess lifecycle"
```

---

### Task 4: 实现 ACP ClientSideConnection 桥接

**Files:**
- Create: `apps/node/src/acp/client-bridge.ts`
- Create: `apps/node/src/acp/__tests__/client-bridge.test.ts`
- Create: `apps/node/src/acp/index.ts`

- [ ] **Step 1: 编写 client-bridge.test.ts**

```typescript
import { describe, expect, it, vi } from 'vitest'
import type { SessionNotification, RequestPermissionRequest } from '@agentclientprotocol/sdk'
import { AcpNodeClient } from '../client-bridge.js'
import type { RuntimeEvent } from '@tianji/shared'

describe('AcpNodeClient', () => {
  it('should be constructable', () => {
    const client = new AcpNodeClient()
    expect(client).toBeDefined()
  })

  it('should collect session updates', async () => {
    const client = new AcpNodeClient()
    const updates: SessionNotification[] = []

    client.onSessionUpdate((update) => {
      updates.push(update)
    })

    await client.sessionUpdate({
      sessionId: 'session-1',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'hello' },
      },
    })

    expect(updates).toHaveLength(1)
    expect(updates[0]!.sessionId).toBe('session-1')
  })

  it('should auto-approve permission requests', async () => {
    const client = new AcpNodeClient()

    const result = await client.requestPermission({
      sessionId: 'session-1',
      toolCall: { toolCallId: 'tc-1', title: 'read file', status: 'pending' },
      options: [
        { kind: 'allow_once', name: 'Allow', optionId: 'allow' },
        { kind: 'reject_once', name: 'Reject', optionId: 'reject' },
      ],
    })

    expect(result.optionId).toBe('allow')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/node && pnpm test -- --reporter=verbose client-bridge`
Expected: FAIL

- [ ] **Step 3: 实现 client-bridge.ts**

创建 `apps/node/src/acp/client-bridge.ts`：

```typescript
/**
 * ACP Client implementation for Node.
 *
 * 实现 ACP Client 接口，接收 agent 的 sessionUpdate 通知和 permission 请求。
 * sessionUpdate 事件通过回调分发，供事件映射层消费。
 *
 * @module acp/client-bridge
 */

import type {
  Client,
  SessionNotification,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk'

type SessionUpdateCallback = (update: SessionNotification) => void

export class AcpNodeClient implements Client {
  #sessionUpdateCallbacks: SessionUpdateCallback[] = []

  /** 注册 sessionUpdate 事件回调，返回取消订阅函数 */
  onSessionUpdate(callback: SessionUpdateCallback): () => void {
    this.#sessionUpdateCallbacks.push(callback)
    return () => {
      const idx = this.#sessionUpdateCallbacks.indexOf(callback)
      if (idx >= 0) this.#sessionUpdateCallbacks.splice(idx, 1)
    }
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    for (const callback of this.#sessionUpdateCallbacks) {
      callback(params)
    }
  }

  /**
   * V3 自动批准所有权限请求（受信内网场景）。
   * 选择 options 中第一个 kind 为 'allow_once' 或 'allow_always' 的选项。
   */
  async requestPermission(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const allowOption = params.options.find(
      (opt) => opt.kind === 'allow_once' || opt.kind === 'allow_always',
    )
    return { optionId: allowOption?.optionId ?? params.options[0]!.optionId }
  }
}
```

- [ ] **Step 4: 创建 acp/index.ts**

创建 `apps/node/src/acp/index.ts`：

```typescript
export { AgentProcessManager, type AgentProcessConfig } from './agent-process.js'
export { AcpNodeClient } from './client-bridge.js'
```

- [ ] **Step 5: 运行测试确认通过**

Run: `cd apps/node && pnpm test -- --reporter=verbose client-bridge`
Expected: ALL PASS

- [ ] **Step 6: 提交**

```bash
git add apps/node/src/acp/client-bridge.ts apps/node/src/acp/__tests__/client-bridge.test.ts apps/node/src/acp/index.ts
git commit -m "feat(node): implement AcpNodeClient for session update and permission handling"
```

---

### Task 5: 实现 ACP SessionUpdate → RuntimeEvent 映射

**Files:**
- Create: `apps/node/src/acp/event-adapter.ts`
- Create: `apps/node/src/acp/__tests__/event-adapter.test.ts`

- [ ] **Step 1: 编写 event-adapter.test.ts**

```typescript
import { describe, expect, it } from 'vitest'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import { mapSessionUpdateToRuntimeEvent } from '../event-adapter.js'
import { createRunId } from '@tianji/shared'

describe('mapSessionUpdateToRuntimeEvent', () => {
  const runId = createRunId('run-001')
  const sessionId = 'session-001'

  it('should map agent_message_chunk to message.delta (text)', () => {
    const update: SessionNotification = {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello' },
      },
    }

    const result = mapSessionUpdateToRuntimeEvent(update, runId)
    expect(result).not.toBeNull()
    expect(result!.type).toBe('message.delta')
    if (result!.type === 'message.delta') {
      expect(result!.channel).toBe('text')
      expect(result!.payload.content).toBe('Hello')
    }
  })

  it('should map agent_thought_chunk to message.delta (thinking)', () => {
    const update: SessionNotification = {
      sessionId,
      update: {
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Thinking...' },
      },
    }

    const result = mapSessionUpdateToRuntimeEvent(update, runId)
    expect(result).not.toBeNull()
    if (result!.type === 'message.delta') {
      expect(result!.channel).toBe('thinking')
    }
  })

  it('should map tool_call to tool.started', () => {
    const update: SessionNotification = {
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'read_file',
        kind: 'read',
        status: 'pending',
        rawInput: { path: '/a.ts' },
      },
    }

    const result = mapSessionUpdateToRuntimeEvent(update, runId)
    expect(result).not.toBeNull()
    expect(result!.type).toBe('tool.started')
  })

  it('should return null for unmapped update types', () => {
    const update: SessionNotification = {
      sessionId,
      update: {
        sessionUpdate: 'usage_update',
        inputTokens: 100,
        outputTokens: 50,
      } as any,
    }

    const result = mapSessionUpdateToRuntimeEvent(update, runId)
    expect(result).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/node && pnpm test -- --reporter=verbose event-adapter`
Expected: FAIL

- [ ] **Step 3: 实现 event-adapter.ts**

创建 `apps/node/src/acp/event-adapter.ts`：

```typescript
/**
 * Maps ACP SessionUpdate notifications to RuntimeEvent.
 *
 * 与 agent 侧的 event-mapper.ts 互为逆映射。
 * Node 通过此模块将 ACP agent 的 session/update 通知转换为标准 RuntimeEvent，
 * 使本地 CLI 渲染和控制平面事件上报使用统一的事件格式。
 *
 * @module acp/event-adapter
 */

import type { SessionNotification } from '@agentclientprotocol/sdk'
import type { RuntimeEvent, RunId } from '@tianji/shared'

let _deltaSequence = 0

/** 将 ACP SessionUpdate 通知映射为 RuntimeEvent。不可映射时返回 null。 */
export function mapSessionUpdateToRuntimeEvent(
  notification: SessionNotification,
  runId: RunId,
): RuntimeEvent | null {
  const update = notification.update
  const now = Date.now()

  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return {
        type: 'message.delta',
        runId,
        messageId: `acp_msg_${now}`,
        sequence: _deltaSequence++,
        channel: 'text',
        payload: { content: extractText(update.content) },
        timestamp: now,
      }

    case 'agent_thought_chunk':
      return {
        type: 'message.delta',
        runId,
        messageId: `acp_msg_${now}`,
        sequence: _deltaSequence++,
        channel: 'thinking',
        payload: { content: extractText(update.content) },
        timestamp: now,
      }

    case 'tool_call':
      return {
        type: 'tool.started',
        runId,
        toolCallId: update.toolCallId,
        invocation: {
          toolCallId: update.toolCallId,
          toolName: update.title ?? 'unknown',
          args: update.rawInput ?? {},
        },
        timestamp: now,
      }

    case 'tool_call_update':
      if (update.status === 'completed') {
        return {
          type: 'tool.completed',
          runId,
          toolCallId: update.toolCallId,
          result: {
            toolCallId: update.toolCallId,
            output: '',
          },
          timestamp: now,
        }
      }
      return null

    default:
      return null
  }
}

function extractText(content: { type: string; text?: string }): string {
  return content.type === 'text' && typeof content.text === 'string' ? content.text : ''
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/node && pnpm test -- --reporter=verbose event-adapter`
Expected: ALL PASS

- [ ] **Step 5: 更新 acp/index.ts 导出**

在 `apps/node/src/acp/index.ts` 追加：

```typescript
export { mapSessionUpdateToRuntimeEvent } from './event-adapter.js'
```

- [ ] **Step 6: 提交**

```bash
git add apps/node/src/acp/event-adapter.ts apps/node/src/acp/__tests__/event-adapter.test.ts apps/node/src/acp/index.ts
git commit -m "feat(node): implement ACP SessionUpdate to RuntimeEvent reverse mapper"
```

---

### Task 6: 实现 ACP Agent Runner（整合 spawn + connect + 事件流）

**Files:**
- Create: `apps/node/src/acp/agent-runner.ts`
- Create: `apps/node/src/acp/__tests__/agent-runner.test.ts`

- [ ] **Step 1: 编写 agent-runner.test.ts（单元测试，mock 子进程）**

```typescript
import { describe, expect, it, vi } from 'vitest'
import type { AgentRunnerConfig } from '../agent-runner.js'
import { AgentRunner } from '../agent-runner.js'

describe('AgentRunner', () => {
  it('should be constructable with config', () => {
    const config: AgentRunnerConfig = {
      agentId: 'default',
      binaryPath: '/path/to/agent',
    }
    const runner = new AgentRunner(config)
    expect(runner.agentId).toBe('default')
  })

  it('should expose agentId', () => {
    const runner = new AgentRunner({
      agentId: 'claude-code',
      binaryPath: '/usr/local/bin/claude',
    })
    expect(runner.agentId).toBe('claude-code')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/node && pnpm test -- --reporter=verbose agent-runner`
Expected: FAIL

- [ ] **Step 3: 实现 agent-runner.ts**

创建 `apps/node/src/acp/agent-runner.ts`：

```typescript
/**
 * Agent Runner: spawn + ACP connect + event stream.
 *
 * 整合 AgentProcessManager 和 ACP ClientSideConnection，
 * 提供 `chat(prompt)` 接口返回 AsyncIterable<RuntimeEvent>。
 *
 * @module acp/agent-runner
 */

import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import type { RuntimeEvent, RunId, SessionId } from '@tianji/shared'
import { createRunId, createSessionId } from '@tianji/shared'

import { AgentProcessManager } from './agent-process.js'
import { AcpNodeClient } from './client-bridge.js'
import { mapSessionUpdateToRuntimeEvent } from './event-adapter.js'

export interface AgentRunnerConfig {
  readonly agentId: string
  readonly binaryPath: string
  readonly args?: readonly string[]
  readonly env?: Record<string, string>
}

export class AgentRunner {
  readonly agentId: string
  readonly #config: AgentRunnerConfig
  #processManager: AgentProcessManager | null = null
  #connection: ClientSideConnection | null = null
  #client: AcpNodeClient | null = null
  #acpSessionId: string | null = null

  constructor(config: AgentRunnerConfig) {
    this.agentId = config.agentId
    this.#config = config
  }

  /**
   * Spawn agent 子进程并建立 ACP 连接。
   * 必须在 chat() 之前调用。
   */
  async connect(): Promise<void> {
    this.#processManager = new AgentProcessManager({
      agentId: this.#config.agentId,
      binaryPath: this.#config.binaryPath,
      args: [...(this.#config.args ?? [])],
      env: this.#config.env,
    })

    const streams = this.#processManager.spawn()
    const stream = ndJsonStream(streams.output, streams.input)

    // 保存 client 引用，chat() 中复用同一个实例注册回调
    this.#client = new AcpNodeClient()
    this.#connection = new ClientSideConnection(
      (_agent) => this.#client!,
      stream,
    )

    await this.#connection.initialize({
      protocolVersion: 1,
      clientCapabilities: {},
    })

    const sessionResp = await this.#connection.newSession({
      cwd: process.cwd(),
    })
    this.#acpSessionId = sessionResp.sessionId
  }

  /**
   * 发送 prompt 到 agent，返回 RuntimeEvent 异步迭代器。
   *
   * 关键：使用 connect() 阶段绑定的同一个 AcpNodeClient 实例注册 sessionUpdate 回调，
   * 因为 ACP SDK 会将通知发送到 ClientSideConnection 构造时绑定的 client。
   */
  async *chat(prompt: string): AsyncIterable<RuntimeEvent> {
    if (!this.#connection || !this.#acpSessionId || !this.#client) {
      throw new Error('Not connected. Call connect() first.')
    }

    const runId = createRunId(`run_${Date.now()}`)
    const sessionId = createSessionId(this.#acpSessionId)

    const eventBuffer: RuntimeEvent[] = []

    // 在 connect() 阶段创建的同一个 client 实例上注册回调
    const unsubscribe = this.#client.onSessionUpdate((update) => {
      const event = mapSessionUpdateToRuntimeEvent(update, runId)
      if (event) {
        eventBuffer.push(event)
      }
    })

    try {
      // 启动 prompt — ACP prompt 是阻塞的，在执行期间 agent 通过 sessionUpdate 流式推送
      const promptResult = this.#connection.prompt({
        sessionId: this.#acpSessionId,
        prompt: [{ type: 'text', text: prompt }],
      })

      // 轮询 eventBuffer 直到 prompt 完成
      let promptDone = false
      promptResult.then(() => { promptDone = true }).catch(() => { promptDone = true })

      while (!promptDone || eventBuffer.length > 0) {
        if (eventBuffer.length > 0) {
          yield eventBuffer.shift()!
        } else {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }

      yield {
        type: 'run.completed',
        runId,
        sessionId,
        triggerType: 'new',
        timestamp: Date.now(),
      } satisfies RuntimeEvent
    } finally {
      unsubscribe()
    }
  }

  /** 断开 ACP 连接并终止 agent 子进程 */
  async disconnect(): Promise<void> {
    await this.#processManager?.kill()
    this.#processManager = null
    this.#connection = null
    this.#client = null
    this.#acpSessionId = null
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/node && pnpm test -- --reporter=verbose agent-runner`
Expected: ALL PASS

- [ ] **Step 5: 更新 acp/index.ts 导出**

在 `apps/node/src/acp/index.ts` 追加：

```typescript
export { AgentRunner, type AgentRunnerConfig } from './agent-runner.js'
```

- [ ] **Step 6: 提交**

```bash
git add apps/node/src/acp/agent-runner.ts apps/node/src/acp/__tests__/agent-runner.test.ts apps/node/src/acp/index.ts
git commit -m "feat(node): implement AgentRunner integrating spawn, ACP connect, and event stream"
```

---

### Task 7: 迁移 run 命令到 ACP

**Files:**
- Modify: `apps/node/src/commands/run.ts`

- [ ] **Step 1: 重写 run.ts 使用 AgentRunner**

将 `apps/node/src/commands/run.ts` 中的 `createAgentSession` import 替换为 `AgentRunner`：

```typescript
import { appendFile, mkdir } from 'node:fs/promises'

import type { RunId, RuntimeEvent } from '@tianji/shared'

import { type UserConfigPaths, getUserConfigPaths, loadUserConfigContext } from '../config.js'
import type { CliLogEntry, CliLogScope, CliLogger } from '../logger.js'
import { createCliLogger } from '../logger.js'
import { AgentRunner } from '../acp/index.js'

import type { CommandDefinition } from './types.js'

const CLI_RUN_SCOPE = ['cli', 'run'] as const satisfies CliLogScope
const CLI_RUN_CONFIG_SCOPE = ['cli', 'run', 'config'] as const satisfies CliLogScope
const CLI_RUN_RUNTIME_SCOPE = ['cli', 'run', 'runtime'] as const satisfies CliLogScope
const CLI_RUN_EVENT_SCOPE = ['cli', 'run', 'event'] as const satisfies CliLogScope

export const runCommand: CommandDefinition = {
  name: 'run',
  description: 'cmd.run.description',
  args: [{ name: 'prompt', description: 'cmd.run.arg.prompt', required: true }],
  handler: async ({ args, deps }) => {
    const prompt = args.prompt
    const resolveUserConfigPaths = deps?.getUserConfigPaths ?? getUserConfigPaths
    const paths = resolveUserConfigPaths()
    const logger = createCliLoggerFromPaths(paths)

    await logger.logInfo(CLI_RUN_SCOPE, 'Received run command', {
      promptLength: prompt.length,
    })

    const loadContext = deps?.loadContext ?? loadUserConfigContext
    await logger.logInfo(CLI_RUN_CONFIG_SCOPE, 'Loading user config context')
    const context = await loadContext()
    await logger.logInfo(CLI_RUN_CONFIG_SCOPE, 'Loaded user config context', {
      configPath: context.paths.configFilePath,
      agentName: context.agent.agentName,
    })

    // 从配置中读取默认 agent 的 binary path
    const agentBinaryPath = context.agent.binaryPath ?? 'tianji-agent'

    const runner = new AgentRunner({
      agentId: context.agent.agentName,
      binaryPath: agentBinaryPath,
    })

    await logger.logInfo(CLI_RUN_RUNTIME_SCOPE, 'Connecting to agent via ACP')
    await runner.connect()

    try {
      return await executeRunTurn(runner, prompt, logger)
    } finally {
      await runner.disconnect()
    }
  },
}

async function executeRunTurn(
  runner: AgentRunner,
  prompt: string,
  logger: CliLogger,
): Promise<number> {
  let currentRunId: RunId | undefined

  for await (const event of runner.chat(prompt)) {
    currentRunId = event.runId
    await handleRuntimeEvent(event, logger)
  }

  process.stdout.write('\n')
  await logger.logInfo(CLI_RUN_SCOPE, 'Run command completed', {
    runId: currentRunId === undefined ? undefined : String(currentRunId),
  })

  return 0
}

async function handleRuntimeEvent(event: RuntimeEvent, logger: CliLogger): Promise<void> {
  switch (event.type) {
    case 'message.delta':
      await logger.logDebug(CLI_RUN_EVENT_SCOPE, 'Received runtime event', {
        eventType: event.type,
        runId: String(event.runId),
        channel: event.channel,
      })
      if (event.channel === 'text') {
        process.stdout.write(event.payload.content)
      }
      break
    case 'run.failed':
      await logger.logError(CLI_RUN_EVENT_SCOPE, 'Received runtime failure event', {
        eventType: event.type,
        runId: String(event.runId),
        errorCode: event.error.code,
        errorMessage: event.error.message,
      })
      throw new Error(`Run failed: ${event.error.message}`)
    case 'run.completed':
      await logger.logInfo(CLI_RUN_EVENT_SCOPE, 'Received runtime completion event', {
        eventType: event.type,
        runId: String(event.runId),
      })
      break
  }
}

function createCliLoggerFromPaths(paths: UserConfigPaths): CliLogger {
  return createCliLogger({
    sink: {
      write(entry: CliLogEntry) {
        return appendCliLogEntry(paths, entry)
      },
    },
  })
}

async function appendCliLogEntry(paths: UserConfigPaths, entry: CliLogEntry): Promise<void> {
  await mkdir(paths.logsDir, { recursive: true })
  await appendFile(paths.cliLogFilePath, `${JSON.stringify(entry)}\n`, 'utf8')
}
```

注意：`context.agent.binaryPath` 是新增字段，需要在后续在 shared 配置 schema 中添加。如果暂时不存在，先使用硬编码默认值或从环境变量读取。

- [ ] **Step 2: 运行 pnpm check**

Run: `pnpm check`
Expected: 可能需要调整 `loadUserConfigContext` 的返回类型以包含 `binaryPath`

- [ ] **Step 3: 运行既有 run 命令测试**

Run: `cd apps/node && pnpm test -- --reporter=verbose run`
Expected: 测试可能需要更新 mock（从 `createAgentSession` 改为 `AgentRunner`）

- [ ] **Step 4: 提交**

```bash
git add apps/node/src/commands/run.ts
git commit -m "refactor(node): migrate run command from direct agent import to ACP AgentRunner"
```

---

### Task 8: 实现控制平面连接模块 — 注册与心跳

**Files:**
- Create: `apps/node/src/controlplane/client.ts`
- Create: `apps/node/src/controlplane/__tests__/client.test.ts`

- [ ] **Step 1: 编写 client.test.ts**

```typescript
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ControlPlaneClient } from '../client.js'

describe('ControlPlaneClient', () => {
  it('should be constructable with base URL', () => {
    const client = new ControlPlaneClient({
      baseUrl: 'http://localhost:3000',
      nodeId: 'node-001',
    })
    expect(client).toBeDefined()
  })

  it('should store access token after setAccessToken', () => {
    const client = new ControlPlaneClient({
      baseUrl: 'http://localhost:3000',
      nodeId: 'node-001',
    })
    client.setAccessToken('token-abc')
    // 内部状态，通过 isAuthenticated 验证
    expect(client.isAuthenticated).toBe(true)
  })

  it('should report not authenticated before registration', () => {
    const client = new ControlPlaneClient({
      baseUrl: 'http://localhost:3000',
      nodeId: 'node-001',
    })
    expect(client.isAuthenticated).toBe(false)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/node && pnpm test -- --reporter=verbose controlplane`
Expected: FAIL

- [ ] **Step 3: 实现 client.ts**

创建 `apps/node/src/controlplane/client.ts`：

```typescript
/**
 * Control Plane HTTP client.
 *
 * Node 侧与 controlplane 通信的客户端，负责注册、心跳、长轮询、事件上报。
 *
 * @module controlplane/client
 */

import type {
  NodeRegisterRequest,
  NodeRegisterResponse,
  NodeHeartbeatRequest,
  NodeExecutionState,
  AgentInfo,
  PollCommandResponse,
} from '@tianji/shared'

export interface ControlPlaneClientConfig {
  readonly baseUrl: string
  readonly nodeId: string
}

export class ControlPlaneClient {
  readonly #baseUrl: string
  readonly #nodeId: string
  #accessToken: string | null = null

  constructor(config: ControlPlaneClientConfig) {
    this.#baseUrl = config.baseUrl.replace(/\/$/, '')
    this.#nodeId = config.nodeId
  }

  get isAuthenticated(): boolean {
    return this.#accessToken !== null
  }

  setAccessToken(token: string): void {
    this.#accessToken = token
  }

  /** POST /api/nodes/register */
  async register(request: NodeRegisterRequest): Promise<NodeRegisterResponse> {
    const resp = await this.#fetch('/api/nodes/register', {
      method: 'POST',
      body: JSON.stringify(request),
    })

    if (!resp.ok) {
      throw new Error(`Registration failed: ${resp.status} ${await resp.text()}`)
    }

    const data = (await resp.json()) as NodeRegisterResponse
    this.#accessToken = data.accessToken
    return data
  }

  /** POST /api/nodes/:nodeId/heartbeat */
  async heartbeat(executionState: NodeExecutionState, agentList?: readonly AgentInfo[]): Promise<void> {
    const body: NodeHeartbeatRequest = { executionState, agentList }

    const resp = await this.#fetchAuth(`/api/nodes/${this.#nodeId}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify(body),
    })

    if (resp.status === 401) {
      throw new ControlPlaneAuthError('Heartbeat rejected: token expired or revoked')
    }

    if (!resp.ok) {
      throw new Error(`Heartbeat failed: ${resp.status}`)
    }
  }

  /** GET /api/nodes/:nodeId/commands/poll?timeout=30000 */
  async pollCommand(timeout = 30000): Promise<PollCommandResponse | null> {
    const resp = await this.#fetchAuth(
      `/api/nodes/${this.#nodeId}/commands/poll?timeout=${timeout}`,
      { method: 'GET', signal: AbortSignal.timeout(timeout + 5000) },
    )

    if (resp.status === 204) return null
    if (resp.status === 401) {
      throw new ControlPlaneAuthError('Poll rejected: token expired or revoked')
    }
    if (!resp.ok) {
      throw new Error(`Poll failed: ${resp.status}`)
    }

    return (await resp.json()) as PollCommandResponse
  }

  /**
   * POST /api/tasks/:taskId/events
   * 返回可写的 NDJSON body writer。
   */
  async openEventStream(taskId: string): Promise<NdjsonWriter> {
    const url = `${this.#baseUrl}/api/tasks/${taskId}/events`
    const controller = new AbortController()

    // 使用 TransformStream 实现 chunked POST body
    const { readable, writable } = new TransformStream<string, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(new TextEncoder().encode(chunk))
      },
    })

    const fetchPromise = fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-ndjson',
        Authorization: `Bearer ${this.#accessToken}`,
      },
      body: readable,
      signal: controller.signal,
      duplex: 'half' as any,
    })

    const writer = writable.getWriter()

    return {
      async write(json: string): Promise<void> {
        await writer.write(json + '\n')
      },
      async writeKeepalive(): Promise<void> {
        await writer.write('\n')
      },
      async close(): Promise<void> {
        await writer.close()
        await fetchPromise
      },
      abort(): void {
        controller.abort()
      },
    }
  }

  #fetch(path: string, init: RequestInit): Promise<Response> {
    return fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init.headers,
      },
    })
  }

  #fetchAuth(path: string, init: RequestInit): Promise<Response> {
    if (!this.#accessToken) {
      throw new Error('Not authenticated. Call register() first.')
    }
    return fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.#accessToken}`,
        ...init.headers,
      },
    })
  }
}

export interface NdjsonWriter {
  write(json: string): Promise<void>
  writeKeepalive(): Promise<void>
  close(): Promise<void>
  abort(): void
}

export class ControlPlaneAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ControlPlaneAuthError'
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/node && pnpm test -- --reporter=verbose controlplane`
Expected: ALL PASS

- [ ] **Step 5: 提交**

```bash
git add apps/node/src/controlplane/client.ts apps/node/src/controlplane/__tests__/client.test.ts
git commit -m "feat(node): implement ControlPlaneClient with register, heartbeat, poll, and event stream"
```

---

### Task 9: 实现控制平面连接循环（注册 + 心跳 + 长轮询）

**Files:**
- Create: `apps/node/src/controlplane/connection-loop.ts`
- Create: `apps/node/src/controlplane/__tests__/connection-loop.test.ts`
- Create: `apps/node/src/controlplane/index.ts`

- [ ] **Step 1: 编写 connection-loop.test.ts（行为验证）**

```typescript
import { describe, expect, it, vi } from 'vitest'
import type { ControlPlaneConnectionConfig } from '../connection-loop.js'

describe('ControlPlaneConnectionConfig', () => {
  it('should define required fields', () => {
    const config: ControlPlaneConnectionConfig = {
      baseUrl: 'http://localhost:3000',
      nodeId: 'node-001',
      enrollmentToken: 'token-abc',
      hostname: 'dev-machine',
      platform: 'linux',
      version: '3.0.0',
      agentList: [],
      heartbeatIntervalMs: 30000,
      onCommand: vi.fn(),
    }
    expect(config.heartbeatIntervalMs).toBe(30000)
  })
})
```

- [ ] **Step 2: 实现 connection-loop.ts**

创建 `apps/node/src/controlplane/connection-loop.ts`：

```typescript
/**
 * Control Plane connection lifecycle loop.
 *
 * 管理 Node 与 controlplane 的完整连接生命周期：
 * 1. 注册（首次或 token 过期时）
 * 2. 心跳（每 30s）
 * 3. 长轮询指令（持续循环）
 *
 * @module controlplane/connection-loop
 */

import type { AgentInfo, NodeExecutionState, PollCommandResponse } from '@tianji/shared'
import { ControlPlaneClient, ControlPlaneAuthError } from './client.js'

export interface ControlPlaneConnectionConfig {
  readonly baseUrl: string
  readonly nodeId: string
  readonly enrollmentToken: string
  readonly hostname: string
  readonly platform: string
  readonly version: string
  readonly agentList: readonly AgentInfo[]
  readonly heartbeatIntervalMs?: number
  readonly onCommand: (command: PollCommandResponse) => void
}

export class ControlPlaneConnection {
  readonly #config: ControlPlaneConnectionConfig
  readonly #client: ControlPlaneClient
  #heartbeatTimer: ReturnType<typeof setInterval> | null = null
  #pollAbort: AbortController | null = null
  #running = false
  #executionState: NodeExecutionState = 'idle'

  constructor(config: ControlPlaneConnectionConfig) {
    this.#config = config
    this.#client = new ControlPlaneClient({
      baseUrl: config.baseUrl,
      nodeId: config.nodeId,
    })
  }

  get client(): ControlPlaneClient {
    return this.#client
  }

  /** 设置当前 node 执行状态（心跳上报用） */
  setExecutionState(state: NodeExecutionState): void {
    this.#executionState = state
  }

  /** 启动连接循环：注册 → 心跳 → 长轮询 */
  async start(): Promise<void> {
    this.#running = true

    await this.#register()
    this.#startHeartbeat()
    void this.#pollLoop()
  }

  /** 停止连接循环 */
  stop(): void {
    this.#running = false
    if (this.#heartbeatTimer) {
      clearInterval(this.#heartbeatTimer)
      this.#heartbeatTimer = null
    }
    this.#pollAbort?.abort()
  }

  async #register(): Promise<void> {
    await this.#client.register({
      nodeId: this.#config.nodeId,
      enrollmentToken: this.#config.enrollmentToken,
      hostname: this.#config.hostname,
      platform: this.#config.platform,
      version: this.#config.version,
      agentList: this.#config.agentList,
    })
  }

  #startHeartbeat(): void {
    const interval = this.#config.heartbeatIntervalMs ?? 30000
    this.#heartbeatTimer = setInterval(async () => {
      try {
        await this.#client.heartbeat(this.#executionState)
      } catch (error) {
        if (error instanceof ControlPlaneAuthError) {
          await this.#reRegister()
        }
      }
    }, interval)
  }

  async #pollLoop(): Promise<void> {
    while (this.#running) {
      try {
        const command = await this.#client.pollCommand(30000)
        if (command) {
          this.#config.onCommand(command)
        }
      } catch (error) {
        if (error instanceof ControlPlaneAuthError) {
          await this.#reRegister()
        } else {
          // 非认证错误，退避重试
          await sleep(1000)
        }
      }
    }
  }

  async #reRegister(): Promise<void> {
    try {
      await this.#register()
    } catch {
      // 重注册失败，1s 后重试
      await sleep(1000)
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
```

- [ ] **Step 3: 创建 controlplane/index.ts**

创建 `apps/node/src/controlplane/index.ts`：

```typescript
export { ControlPlaneClient, ControlPlaneAuthError, type NdjsonWriter } from './client.js'
export { ControlPlaneConnection, type ControlPlaneConnectionConfig } from './connection-loop.js'
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/node && pnpm test -- --reporter=verbose connection-loop`
Expected: ALL PASS

- [ ] **Step 5: 提交**

```bash
git add apps/node/src/controlplane/connection-loop.ts apps/node/src/controlplane/__tests__/connection-loop.test.ts apps/node/src/controlplane/index.ts
git commit -m "feat(node): implement ControlPlaneConnection lifecycle loop"
```

---

### Task 10: 实现 Node 侧 Task 管理

**Files:**
- Create: `apps/node/src/task/task-executor.ts`
- Create: `apps/node/src/task/__tests__/task-executor.test.ts`

- [ ] **Step 1: 编写 task-executor.test.ts**

```typescript
import { describe, expect, it, vi } from 'vitest'
import type { TaskExecutorConfig } from '../task-executor.js'
import { TaskExecutor } from '../task-executor.js'

describe('TaskExecutor', () => {
  it('should be constructable', () => {
    const executor = new TaskExecutor({
      stateFilePath: '/tmp/test-current-command',
    })
    expect(executor).toBeDefined()
  })

  it('should report idle when no task is running', () => {
    const executor = new TaskExecutor({
      stateFilePath: '/tmp/test-current-command',
    })
    expect(executor.isIdle).toBe(true)
    expect(executor.currentTaskId).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/node && pnpm test -- --reporter=verbose task-executor`
Expected: FAIL

- [ ] **Step 3: 实现 task-executor.ts**

创建 `apps/node/src/task/task-executor.ts`：

```typescript
/**
 * Node-side Task executor.
 *
 * 管理 task 的执行生命周期：接收 command → 持久化状态文件 → spawn agent →
 * 上报 TaskEvent → 清理状态文件。
 *
 * @module task/task-executor
 */

import { writeFile, unlink, readFile } from 'node:fs/promises'
import type { PollCommandResponse, TaskEvent, TaskLifecycleEvent } from '@tianji/shared'
import type { RuntimeEvent } from '@tianji/shared'
import { createSessionId, createRunId } from '@tianji/shared'
import type { TaskId } from '@tianji/shared'

import type { AgentRunner } from '../acp/agent-runner.js'
import type { NdjsonWriter } from '../controlplane/client.js'

export interface TaskExecutorConfig {
  readonly stateFilePath: string
}

export class TaskExecutor {
  readonly #stateFilePath: string
  #currentTaskId: string | null = null
  #sequence = 0

  constructor(config: TaskExecutorConfig) {
    this.#stateFilePath = config.stateFilePath
  }

  get isIdle(): boolean {
    return this.#currentTaskId === null
  }

  get currentTaskId(): string | null {
    return this.#currentTaskId
  }

  /**
   * 执行一个 task command。
   *
   * @param command - 从 controlplane poll 得到的指令
   * @param runner - 已连接的 AgentRunner
   * @param eventWriter - NDJSON 事件上报 writer
   */
  async execute(
    command: PollCommandResponse,
    runner: AgentRunner,
    eventWriter: NdjsonWriter,
  ): Promise<void> {
    const { taskId, agentId, goal } = command.payload
    this.#currentTaskId = taskId as string
    this.#sequence = 0

    // 持久化 commandId 到状态文件（崩溃恢复用）
    await writeFile(this.#stateFilePath, JSON.stringify({
      commandId: command.commandId,
      taskId,
    }), 'utf8')

    try {
      // 上报 task.started
      await this.#emitLifecycle(eventWriter, taskId as string, 'task.started', {
        summary: `Starting: ${goal}`,
      })

      // 通过 ACP 执行 agent prompt
      const runId = createRunId(`run_${Date.now()}`)
      const sessionId = createSessionId(`session_${Date.now()}`)

      // 上报 task.session.attached
      await this.#emitLifecycle(eventWriter, taskId as string, 'task.session.attached', {
        sessionId: sessionId as string,
      })

      for await (const event of runner.chat(goal)) {
        await this.#emitAgentEvent(eventWriter, taskId as string, sessionId as string, runId as string, event)
      }

      // 上报 task.completed
      await this.#emitLifecycle(eventWriter, taskId as string, 'task.completed', {
        summary: 'Task completed',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.#emitLifecycle(eventWriter, taskId as string, 'task.failed', {
        error: message,
      })
    } finally {
      // 清理状态文件
      await unlink(this.#stateFilePath).catch(() => {})
      this.#currentTaskId = null
    }
  }

  /** 检查崩溃恢复状态 */
  async checkCrashRecovery(): Promise<{ commandId: string; taskId: string } | null> {
    try {
      const content = await readFile(this.#stateFilePath, 'utf8')
      return JSON.parse(content) as { commandId: string; taskId: string }
    } catch {
      return null
    }
  }

  async #emitLifecycle(
    writer: NdjsonWriter,
    taskId: string,
    type: string,
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    const event: TaskLifecycleEvent = {
      kind: 'lifecycle',
      taskId: taskId as TaskId,
      type: type as TaskLifecycleEvent['type'],
      sequence: this.#sequence++,
      timestamp: Date.now(),
      ...extra,
    } as TaskLifecycleEvent

    await writer.write(JSON.stringify(event))
  }

  async #emitAgentEvent(
    writer: NdjsonWriter,
    taskId: string,
    sessionId: string,
    runId: string,
    event: RuntimeEvent,
  ): Promise<void> {
    const taskEvent = {
      kind: 'agent' as const,
      taskId,
      sequence: this.#sequence++,
      sessionId,
      runId,
      event,
    }
    await writer.write(JSON.stringify(taskEvent))
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd apps/node && pnpm test -- --reporter=verbose task-executor`
Expected: ALL PASS

- [ ] **Step 5: 创建 task/index.ts**

创建 `apps/node/src/task/index.ts`：

```typescript
export { TaskExecutor, type TaskExecutorConfig } from './task-executor.js'
```

- [ ] **Step 6: 提交**

```bash
git add apps/node/src/task/task-executor.ts apps/node/src/task/__tests__/task-executor.test.ts apps/node/src/task/index.ts
git commit -m "feat(node): implement TaskExecutor with lifecycle events and crash recovery"
```

---

### Task 11: 迁移 Daemon 架构为 ACP subprocess 模式

**Files:**
- Modify: `apps/node/src/daemon-entry.ts`
- Modify: `apps/node/src/commands/daemon.ts`
- Modify: `apps/node/src/commands/chat.ts`

- [ ] **Step 1: 重写 daemon-entry.ts**

Daemon 不再直接 import `@tianji/agent`，改为管理 ACP agent 子进程和（可选的）controlplane 连接：

```typescript
import { pathToFileURL } from 'node:url'
import { loadUserConfigContext } from './config.js'
import { createI18n, detectLocale } from './i18n/index.js'
import { AgentRunner } from './acp/index.js'

/**
 * V3 Daemon entry point.
 *
 * Daemon 职责：
 * 1. 管理 ACP agent 子进程
 * 2. 提供 HTTP API 供 CLI chat 命令使用
 * 3. （可选）连接 controlplane 执行远程 task
 */
export async function runDaemonEntry(): Promise<void> {
  const context = await loadUserConfigContext()
  const i18n = createI18n(detectLocale(context.config))

  // V3: 通过 ACP subprocess 管理 agent
  const agentBinaryPath = context.agent.binaryPath ?? 'tianji-agent'
  const runner = new AgentRunner({
    agentId: context.agent.agentName,
    binaryPath: agentBinaryPath,
  })

  await runner.connect()

  // TODO(v3): 替换 DaemonServer 为新的 HTTP server
  // 暂时保持 daemon 的 HTTP API 供 chat 命令使用
  // 后续 Task 实现新的 daemon HTTP server

  process.stdout.write(`${i18n.t('daemon.listening', { port: 0 })}\n`)

  const shutdown = async () => {
    await runner.disconnect()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

const _isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (_isMain) {
  void runDaemonEntry()
}
```

- [ ] **Step 2: 更新 daemon.ts 命令**

移除对 `DaemonClient` 的 import（来自 `@tianji/agent`），改为使用本地 HTTP 客户端或暂时标记为 TODO。

- [ ] **Step 3: 更新 chat.ts 命令**

同样移除 `DaemonClient` import，使用本地 HTTP 客户端。

- [ ] **Step 4: 运行 pnpm check**

Run: `pnpm check`
Expected: 无 `@tianji/agent` import 错误

- [ ] **Step 5: 提交**

```bash
git add apps/node/src/daemon-entry.ts apps/node/src/commands/daemon.ts apps/node/src/commands/chat.ts
git commit -m "refactor(node): migrate daemon to ACP subprocess model, remove @tianji/agent dependency"
```

---

### Task 12: 全量回归测试与 pnpm check

**Files:**
- 无新增文件

- [ ] **Step 1: 运行 node 包全量测试**

Run: `cd apps/node && pnpm test -- --reporter=verbose`
Expected: ALL PASS

- [ ] **Step 2: 运行全局 pnpm check**

Run: `pnpm check`
Expected: 无错误

- [ ] **Step 3: 确认 apps/node 无 @tianji/agent 或 @tianji/runtime import**

Run: `grep -r "@tianji/agent\|@tianji/runtime" apps/node/src/ --include="*.ts" | grep -v "TODO\|__tests__"`
Expected: 无匹配（所有旧 import 已移除）

- [ ] **Step 4: 运行构建确认产物正确**

Run: `cd apps/node && pnpm build`
Expected: 编译成功
