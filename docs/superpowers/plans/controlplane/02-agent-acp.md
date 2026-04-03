# Agent ACP 适配 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让原生 agent（`@tianji/agent`）实现 ACP `AgentSideConnection`，使其可作为独立进程通过 stdio JSON-RPC 2.0 与任何 ACP client 通信，并可编译为独立可执行文件。

**Architecture:** 在 `packages/agent/src/acp/` 下新建 ACP 桥接层，将 ACP `prompt()` 调用映射到 `AgentSession.chat()`，将 `RuntimeEvent` 流映射为 ACP `sessionUpdate` 通知。新增 `packages/agent/src/acp-entry.ts` 作为 ACP stdio 入口。使用 esbuild bundle 生成独立可执行文件。

**Tech Stack:** TypeScript, `@agentclientprotocol/sdk ^0.18.0`, esbuild, Vitest

**设计文档:** `docs/superpowers/specs/2026-04-03-v3-distributed-node-controlplane-design.md` 第 3.1 节

**前置依赖:** `01-shared-protocol` 完成

---

### Task 1: 安装 @agentclientprotocol/sdk 依赖

**Files:**
- Modify: `packages/agent/package.json`

- [ ] **Step 1: 添加 ACP SDK 依赖**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm --filter @tianji/agent add @agentclientprotocol/sdk@^0.18.0`

- [ ] **Step 2: 验证安装成功**

Run: `cd packages/agent && node -e "import('@agentclientprotocol/sdk').then(m => console.log('OK, version:', Object.keys(m).length, 'exports'))"`
Expected: 输出 OK

- [ ] **Step 3: 运行 pnpm check 确认无破坏**

Run: `pnpm check`
Expected: 无错误

- [ ] **Step 4: 提交**

```bash
git add packages/agent/package.json pnpm-lock.yaml
git commit -m "chore(agent): add @agentclientprotocol/sdk dependency"
```

---

### Task 2: 实现 RuntimeEvent → ACP SessionUpdate 映射

**Files:**
- Create: `packages/agent/src/acp/event-mapper.ts`
- Create: `packages/agent/src/acp/__tests__/event-mapper.test.ts`

- [ ] **Step 1: 编写 event-mapper.test.ts**

```typescript
import { describe, expect, it } from 'vitest'
import type { SessionNotification } from '@agentclientprotocol/sdk'
import { mapRuntimeEventToSessionUpdate } from '../event-mapper.js'
import type {
  MessageDeltaEvent,
  ToolStartedEvent,
  ToolCompletedEvent,
  RunCompletedEvent,
} from '@tianji/shared'
import { createRunId, createSessionId } from '@tianji/shared'

describe('mapRuntimeEventToSessionUpdate', () => {
  const sessionId = 'session-001'
  const runId = createRunId('run-001')

  it('should map message.delta (text channel) to agent_message_chunk', () => {
    const event: MessageDeltaEvent = {
      type: 'message.delta',
      runId,
      messageId: 'msg-1',
      sequence: 0,
      channel: 'text',
      payload: { content: 'Hello world' },
      timestamp: Date.now(),
    }

    const result = mapRuntimeEventToSessionUpdate(sessionId, event)
    expect(result).not.toBeNull()
    expect(result!.sessionId).toBe(sessionId)
    expect(result!.update.sessionUpdate).toBe('agent_message_chunk')
  })

  it('should map message.delta (thinking channel) to agent_thought_chunk', () => {
    const event: MessageDeltaEvent = {
      type: 'message.delta',
      runId,
      messageId: 'msg-1',
      sequence: 0,
      channel: 'thinking',
      payload: { content: 'Let me think...' },
      timestamp: Date.now(),
    }

    const result = mapRuntimeEventToSessionUpdate(sessionId, event)
    expect(result).not.toBeNull()
    expect(result!.update.sessionUpdate).toBe('agent_thought_chunk')
  })

  it('should map tool.started to tool_call with pending status', () => {
    const event: ToolStartedEvent = {
      type: 'tool.started',
      runId,
      toolCallId: 'tc-1',
      invocation: { toolCallId: 'tc-1', toolName: 'read_file', args: { path: '/a.ts' } },
      timestamp: Date.now(),
    }

    const result = mapRuntimeEventToSessionUpdate(sessionId, event)
    expect(result).not.toBeNull()
    expect(result!.update.sessionUpdate).toBe('tool_call')
    if (result!.update.sessionUpdate === 'tool_call') {
      expect(result!.update.toolCallId).toBe('tc-1')
      expect(result!.update.status).toBe('pending')
    }
  })

  it('should map tool.completed to tool_call_update with completed status', () => {
    const event: ToolCompletedEvent = {
      type: 'tool.completed',
      runId,
      toolCallId: 'tc-1',
      result: { toolCallId: 'tc-1', output: 'file contents' },
      timestamp: Date.now(),
    }

    const result = mapRuntimeEventToSessionUpdate(sessionId, event)
    expect(result).not.toBeNull()
    expect(result!.update.sessionUpdate).toBe('tool_call_update')
  })

  it('should return null for run lifecycle events (not mapped to session update)', () => {
    const event: RunCompletedEvent = {
      type: 'run.completed',
      runId,
      sessionId: createSessionId('s'),
      triggerType: 'new',
      timestamp: Date.now(),
    }

    const result = mapRuntimeEventToSessionUpdate(sessionId, event)
    expect(result).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/agent && pnpm test -- --reporter=verbose event-mapper`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 event-mapper.ts**

创建 `packages/agent/src/acp/event-mapper.ts`：

```typescript
/**
 * Maps RuntimeEvent to ACP SessionUpdate notifications.
 *
 * 将 tianji runtime 事件流转换为 ACP 协议的 session/update 通知。
 * Run lifecycle 事件（run.started/completed/failed/cancelled）不映射为 SessionUpdate，
 * 因为 ACP 的 prompt() 返回值已隐含 run 结束语义。
 *
 * @module acp/event-mapper
 */

import type { SessionNotification } from '@agentclientprotocol/sdk'
import type { RuntimeEvent } from '@tianji/shared'

/**
 * 将单个 RuntimeEvent 映射为 ACP SessionUpdate 通知。
 * 不可映射的事件返回 null。
 */
export function mapRuntimeEventToSessionUpdate(
  sessionId: string,
  event: RuntimeEvent,
): SessionNotification | null {
  switch (event.type) {
    case 'message.delta':
      return {
        sessionId,
        update: {
          sessionUpdate:
            event.channel === 'thinking' ? 'agent_thought_chunk' : 'agent_message_chunk',
          content: { type: 'text', text: event.payload.content },
        },
      }

    case 'tool.started':
      return {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: event.toolCallId,
          title: event.invocation.toolName,
          kind: mapToolKind(event.invocation.toolName),
          status: 'pending',
          rawInput: event.invocation.args,
        },
      }

    case 'tool.completed':
      return {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: event.toolCallId,
          status: 'completed',
        },
      }

    case 'tool.failed':
      return {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: event.toolCallId,
          status: 'failed',
        },
      }

    case 'message.started':
    case 'message.completed':
    case 'run.started':
    case 'run.completed':
    case 'run.failed':
    case 'run.cancelled':
      return null

    default:
      return null
  }
}

/** 将 tianji 工具名映射为 ACP ToolKind */
function mapToolKind(toolName: string): 'read' | 'edit' | 'execute' | 'search' | 'other' {
  if (toolName.includes('read') || toolName.includes('Read')) return 'read'
  if (toolName.includes('edit') || toolName.includes('Edit') || toolName.includes('write'))
    return 'edit'
  if (toolName.includes('exec') || toolName.includes('bash') || toolName.includes('shell'))
    return 'execute'
  if (toolName.includes('search') || toolName.includes('grep') || toolName.includes('find'))
    return 'search'
  return 'other'
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/agent && pnpm test -- --reporter=verbose event-mapper`
Expected: ALL PASS

- [ ] **Step 5: 提交**

```bash
git add packages/agent/src/acp/event-mapper.ts packages/agent/src/acp/__tests__/event-mapper.test.ts
git commit -m "feat(agent): implement RuntimeEvent to ACP SessionUpdate mapper"
```

---

### Task 3: 实现 ACP Agent 桥接类

**Files:**
- Create: `packages/agent/src/acp/agent-bridge.ts`
- Create: `packages/agent/src/acp/__tests__/agent-bridge.test.ts`

- [ ] **Step 1: 编写 agent-bridge.test.ts**

```typescript
import { describe, expect, it, vi } from 'vitest'
import { TianjiAcpAgent } from '../agent-bridge.js'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { AgentSideConnection } from '@agentclientprotocol/sdk'
import type { RuntimeEvent, SessionId } from '@tianji/shared'
import { createRunId, createSessionId } from '@tianji/shared'

function createMockConnection(): AgentSideConnection {
  return {
    sessionUpdate: vi.fn().mockResolvedValue(undefined),
    requestPermission: vi.fn(),
    readTextFile: vi.fn(),
    writeTextFile: vi.fn(),
    createTerminal: vi.fn(),
    extMethod: vi.fn(),
    extNotification: vi.fn(),
    signal: new AbortController().signal,
    closed: new Promise(() => {}),
  } as unknown as AgentSideConnection
}

function createMockSessionFactory() {
  const events: RuntimeEvent[] = [
    {
      type: 'message.delta',
      runId: createRunId('run-1'),
      messageId: 'msg-1',
      sequence: 0,
      channel: 'text' as const,
      payload: { content: 'Hello' },
      timestamp: Date.now(),
    },
    {
      type: 'run.completed',
      runId: createRunId('run-1'),
      sessionId: createSessionId('s'),
      triggerType: 'new' as const,
      timestamp: Date.now(),
    },
  ]

  return vi.fn().mockReturnValue({
    sessionId: createSessionId('session-test'),
    async *chat(prompt: string) {
      for (const event of events) {
        yield event
      }
    },
  })
}

describe('TianjiAcpAgent', () => {
  it('should return protocol version on initialize', async () => {
    const conn = createMockConnection()
    const factory = createMockSessionFactory()
    const agent = new TianjiAcpAgent(conn, factory)

    const result = await agent.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    })

    expect(result.protocolVersion).toBe(PROTOCOL_VERSION)
  })

  it('should create a new session via newSession', async () => {
    const conn = createMockConnection()
    const factory = createMockSessionFactory()
    const agent = new TianjiAcpAgent(conn, factory)

    const result = await agent.newSession({ cwd: '/tmp' })
    expect(result.sessionId).toBeDefined()
    expect(typeof result.sessionId).toBe('string')
    expect(factory).toHaveBeenCalled()
  })

  it('should stream events on prompt and return end_turn', async () => {
    const conn = createMockConnection()
    const factory = createMockSessionFactory()
    const agent = new TianjiAcpAgent(conn, factory)

    await agent.newSession({ cwd: '/tmp' })

    const result = await agent.prompt({
      sessionId: 'session-test',
      prompt: [{ type: 'text', text: 'hello' }],
    })

    expect(result.stopReason).toBe('end_turn')
    // message.delta 应触发 sessionUpdate 调用
    expect(conn.sessionUpdate).toHaveBeenCalled()
  })

  it('should handle cancel without error', async () => {
    const conn = createMockConnection()
    const factory = createMockSessionFactory()
    const agent = new TianjiAcpAgent(conn, factory)

    await expect(
      agent.cancel({ sessionId: 'session-test', reason: 'user' })
    ).resolves.not.toThrow()
  })

  it('should handle authenticate', async () => {
    const conn = createMockConnection()
    const factory = createMockSessionFactory()
    const agent = new TianjiAcpAgent(conn, factory)

    const result = await agent.authenticate({})
    expect(result).toEqual({})
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/agent && pnpm test -- --reporter=verbose agent-bridge`
Expected: FAIL — 模块不存在

- [ ] **Step 3: 实现 agent-bridge.ts**

创建 `packages/agent/src/acp/agent-bridge.ts`：

```typescript
/**
 * ACP Agent bridge for tianji native agent.
 *
 * 将 ACP 协议调用桥接到 AgentSession，使原生 agent 可作为 ACP agent 运行。
 *
 * @module acp/agent-bridge
 */

import type {
  AgentSideConnection,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
} from '@agentclientprotocol/sdk'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { RuntimeEvent } from '@tianji/shared'

import type { AgentSession } from '../session.js'
import { mapRuntimeEventToSessionUpdate } from './event-mapper.js'

type SessionFactory = () => AgentSession

export class TianjiAcpAgent {
  readonly #connection: AgentSideConnection
  readonly #sessionFactory: SessionFactory
  #currentSession: AgentSession | null = null
  #abortController: AbortController | null = null

  constructor(connection: AgentSideConnection, sessionFactory: SessionFactory) {
    this.#connection = connection
    this.#sessionFactory = sessionFactory
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
      },
    }
  }

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    this.#currentSession = this.#sessionFactory()
    return {
      sessionId: this.#currentSession.sessionId as string,
    }
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return {}
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    if (!this.#currentSession) {
      throw new Error('No active session. Call newSession first.')
    }

    const promptText = params.prompt
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n')

    if (!promptText) {
      return { stopReason: 'end_turn' }
    }

    this.#abortController = new AbortController()
    const sessionId = params.sessionId

    try {
      for await (const event of this.#currentSession.chat(promptText)) {
        if (this.#abortController.signal.aborted) {
          return { stopReason: 'cancelled' }
        }

        const update = mapRuntimeEventToSessionUpdate(sessionId, event)
        if (update) {
          await this.#connection.sessionUpdate(update)
        }
      }

      return { stopReason: 'end_turn' }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { stopReason: 'end_turn' }
    } finally {
      this.#abortController = null
    }
  }

  async cancel(_params: CancelNotification): Promise<void> {
    this.#abortController?.abort()
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/agent && pnpm test -- --reporter=verbose agent-bridge`
Expected: ALL PASS

- [ ] **Step 5: 提交**

```bash
git add packages/agent/src/acp/agent-bridge.ts packages/agent/src/acp/__tests__/agent-bridge.test.ts
git commit -m "feat(agent): implement TianjiAcpAgent bridge class"
```

---

### Task 4: 创建 ACP stdio 入口

**Files:**
- Create: `packages/agent/src/acp/index.ts`
- Create: `packages/agent/src/acp-entry.ts`

- [ ] **Step 1: 创建 acp/index.ts 模块导出**

创建 `packages/agent/src/acp/index.ts`：

```typescript
export { TianjiAcpAgent } from './agent-bridge.js'
export { mapRuntimeEventToSessionUpdate } from './event-mapper.js'
```

- [ ] **Step 2: 创建 acp-entry.ts stdio 入口**

创建 `packages/agent/src/acp-entry.ts`：

```typescript
/**
 * ACP stdio entry point for tianji native agent.
 *
 * 此文件是原生 agent 作为独立进程运行时的入口。
 * 通过 stdin/stdout 进行 ACP JSON-RPC 2.0 通信。
 *
 * 用法：node dist/acp-entry.js
 * 或编译为独立可执行文件后直接运行。
 *
 * @module acp-entry
 */

import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'
import { Readable, Writable } from 'node:stream'

import { loadAgentContext } from './context.js'
import { createAgentSession } from './session.js'
import { TianjiAcpAgent } from './acp/agent-bridge.js'

/**
 * 启动 ACP agent 进程。
 * 从 stdin 读取 JSON-RPC 请求，通过 stdout 返回响应和通知。
 */
export async function runAcpAgent(): Promise<void> {
  const context = await loadAgentContext()

  const input = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>
  const output = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
  const stream = ndJsonStream(input, output)

  const connection = new AgentSideConnection(
    (conn) => {
      const sessionFactory = () => createAgentSession(context)
      const agent = new TianjiAcpAgent(conn, sessionFactory)
      return agent
    },
    stream,
  )

  await connection.closed
}

// 作为独立进程运行时自动启动
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] &&
  import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))

if (isMain) {
  runAcpAgent().catch((error) => {
    console.error('ACP agent fatal error:', error)
    process.exit(1)
  })
}
```

- [ ] **Step 3: 在 packages/agent/src/index.ts 中追加 ACP 导出**

在 `packages/agent/src/index.ts` 末尾追加：

```typescript
export { TianjiAcpAgent, mapRuntimeEventToSessionUpdate } from './acp/index.js'
export { runAcpAgent } from './acp-entry.js'
```

- [ ] **Step 4: 运行 pnpm check 确认无错误**

Run: `pnpm check`
Expected: 无错误

- [ ] **Step 5: 提交**

```bash
git add packages/agent/src/acp/index.ts packages/agent/src/acp-entry.ts packages/agent/src/index.ts
git commit -m "feat(agent): add ACP stdio entry point for standalone agent process"
```

---

### Task 5: esbuild 打包脚本

**Files:**
- Create: `packages/agent/scripts/build-acp-bundle.ts`
- Modify: `packages/agent/package.json`

- [ ] **Step 1: 安装 esbuild 开发依赖**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm --filter @tianji/agent add -D esbuild`

- [ ] **Step 2: 创建打包脚本**

创建 `packages/agent/scripts/build-acp-bundle.ts`：

```typescript
/**
 * 将 acp-entry.ts 打包为单文件 bundle，用于独立进程分发。
 *
 * 用法：npx tsx scripts/build-acp-bundle.ts
 * 产物：dist/acp-bundle.mjs（单文件，可直接 node 运行）
 */

import { build } from 'esbuild'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

await build({
  entryPoints: [resolve(root, 'src/acp-entry.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: resolve(root, 'dist/acp-bundle.mjs'),
  sourcemap: true,
  external: [],
  banner: {
    js: '#!/usr/bin/env node\n',
  },
  define: {
    'import.meta.url': 'import.meta.url',
  },
})

console.log('ACP bundle built: dist/acp-bundle.mjs')
```

- [ ] **Step 3: 在 package.json 中添加打包脚本**

在 `packages/agent/package.json` 的 `scripts` 中追加：

```json
"build:acp": "tsx scripts/build-acp-bundle.ts"
```

- [ ] **Step 4: 测试打包**

Run: `cd packages/agent && pnpm build && pnpm build:acp && ls -lh dist/acp-bundle.mjs`
Expected: 产物文件存在，大小合理（几百 KB 到几 MB）

- [ ] **Step 5: 验证 bundle 可以加载（不崩溃）**

Run: `cd packages/agent && timeout 3 node dist/acp-bundle.mjs 2>&1 || true`
Expected: 不报模块找不到错误（可能因无 stdin 输入而等待或超时，这是正常的）

- [ ] **Step 6: 运行 pnpm check 确认无错误**

Run: `pnpm check`
Expected: 无错误

- [ ] **Step 7: 提交**

```bash
git add packages/agent/scripts/build-acp-bundle.ts packages/agent/package.json pnpm-lock.yaml
git commit -m "feat(agent): add esbuild script for ACP standalone bundle"
```

---

### Task 6: 全量回归测试

**Files:**
- 无新增文件

- [ ] **Step 1: 运行 agent 包全量测试**

Run: `cd packages/agent && pnpm test -- --reporter=verbose`
Expected: ALL PASS（包括既有测试 + 新增 ACP 测试）

- [ ] **Step 2: 运行全局 pnpm check**

Run: `pnpm check`
Expected: 无错误、无警告

- [ ] **Step 3: 验证构建链完整**

Run: `cd packages/agent && pnpm build && pnpm build:acp`
Expected: tsc 编译成功，esbuild bundle 成功
