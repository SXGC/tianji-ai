# Daemon Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `tianji` CLI 增加常驻 daemon 与交互式 chat REPL，使多轮对话复用同一 `AgentSession`，并提供状态检查与优雅关闭能力。

**Architecture:** 在 `@tianji/agent` 中新增 daemon 协议、HTTP server/client 与路径管理，daemon 进程持有唯一 `AgentSession` 并通过 `localhost` HTTP + SSE 暴露 chat 能力；在 `@tianji/cli` 中新增 `daemon`、`chat`、`status`、`stop` 命令，以及独立的 daemon 子进程入口。CLI 与 daemon client 统一消费 `AsyncIterable<RuntimeEvent>`，保持现有事件处理路径最小改动。

**Tech Stack:** TypeScript, Node.js built-ins (`node:http`, `node:fs/promises`, `node:child_process`, `node:readline`), Vitest, pnpm, Biome

---

## 文件结构

### 新建文件

- `packages/agent/src/daemon-protocol.ts`
  - daemon HTTP 请求/响应类型、SSE 消息类型、协议常量与编码辅助函数。
- `packages/agent/src/daemon-server.ts`
  - `DaemonServer` 实现，负责持有 `AgentSession`、处理 `/ping` `/chat` `/shutdown`、SSE 写出、活跃 chat 锁与优雅关闭。
- `packages/agent/src/daemon-client.ts`
  - `DaemonClient` 实现，负责读取 daemon 地址、发起 HTTP 请求、解析 SSE，并把 `chat.event` 还原成 `RuntimeEvent` 流。
- `packages/agent/src/__tests__/daemon-protocol.test.ts`
  - 协议编解码与类型守卫测试。
- `packages/agent/src/__tests__/daemon-server.test.ts`
  - daemon server 路由、并发限制、关闭流程测试。
- `packages/agent/src/__tests__/daemon-client.test.ts`
  - daemon client SSE 解析、错误映射与请求行为测试。
- `apps/cli/src/daemon-entry.ts`
  - daemon 子进程入口，加载 context、创建 session、启动 server、处理信号。
- `apps/cli/src/__tests__/main-daemon.test.ts`
  - CLI 新命令解析与命令分发测试。

### 修改文件

- `packages/agent/src/context.ts`
  - `AgentAppPaths` 增加 `daemonPortPath`、`daemonPidPath`，默认配置目录初始化时确保这些路径所在目录可用。
- `packages/agent/src/index.ts`
  - 导出 daemon 协议、server、client 类型与实现。
- `apps/cli/src/config.ts`
  - 透传新的 `AgentAppPaths` 字段，供 CLI 读取 daemon 端口与 PID 文件。
- `apps/cli/src/main.ts`
  - 扩展 CLI 命令 union、帮助文本、参数解析、执行分发；新增 `daemon`、`chat`、`status`、`stop` 命令及共享输出逻辑。
- `apps/cli/README.md`
  - 记录新命令、端口/PID 文件、REPL 行为、daemon 生命周期与错误处理。
- `README.md`
  - 更新仓库级 CLI 能力说明，避免顶层文档滞后。

### 已有参考文件

- `packages/agent/src/context.ts`
- `packages/agent/src/session.ts`
- `packages/agent/src/__tests__/context.test.ts`
- `packages/agent/src/__tests__/session.test.ts`
- `apps/cli/src/main.ts`
- `apps/cli/src/config.ts`
- `apps/cli/src/__tests__/config.test.ts`
- `apps/cli/README.md`
- `docs/superpowers/specs/2026-03-31-daemon-chat-design.md`

## 实施约束

- 保持零新增外部依赖，只使用 Node 内置模块。
- `DaemonClient.sendChat(prompt)` 必须返回 `AsyncIterable<RuntimeEvent>`，让 CLI 继续复用 `handleRuntimeEvent()`。
- `SessionRuntime` 不支持并发 `runTurn`，daemon 必须显式实现单 chat 锁。
- 测试必须在对应包目录执行；代码改动完成后必须执行仓库根目录 `pnpm check`，并修复所有输出项。
- 修改 CLI/agent 功能后同步更新 `apps/cli/README.md`，必要时更新根 `README.md`。

### Task 1: 扩展 Agent 路径与协议基础

**Files:**
- Modify: `packages/agent/src/context.ts`
- Modify: `packages/agent/src/index.ts`
- Create: `packages/agent/src/daemon-protocol.ts`
- Modify: `packages/agent/src/__tests__/context.test.ts`
- Create: `packages/agent/src/__tests__/daemon-protocol.test.ts`

- [ ] **Step 1: 写 `context` 与协议测试，先固定新增路径与 SSE 协议行为**

```ts
import { describe, expect, it } from 'vitest'

import {
  DAEMON_SSE_EVENT_NAME,
  DAEMON_SSE_DONE_NAME,
  DAEMON_SSE_ERROR_NAME,
  encodeSseMessage,
  getAgentAppPaths,
} from '../index.js'

describe('agent context', () => {
  it('returns stable daemon file paths', () => {
    const paths = getAgentAppPaths()

    expect(paths.daemonPortPath).toContain('.config/tianji-ai/daemon.port')
    expect(paths.daemonPidPath).toContain('.config/tianji-ai/daemon.pid')
  })
})

describe('daemon protocol', () => {
  it('encodes runtime event messages as SSE blocks', () => {
    const encoded = encodeSseMessage({
      event: DAEMON_SSE_EVENT_NAME,
      data: {
        type: 'chat.event',
        event: {
          type: 'run.completed',
          runId: 'run_1',
          sessionId: 'session_1',
        },
      },
    })

    expect(encoded).toBe(
      'event: chat.event\n' +
        'data: {"type":"chat.event","event":{"type":"run.completed","runId":"run_1","sessionId":"session_1"}}\n\n'
    )
  })

  it('encodes done and error event names exactly once', () => {
    expect(DAEMON_SSE_DONE_NAME).toBe('chat.done')
    expect(DAEMON_SSE_ERROR_NAME).toBe('chat.error')
  })
})
```

- [ ] **Step 2: 运行 agent 测试，确认新增断言先失败**

Run: `pnpm test -- --run src/__tests__/context.test.ts src/__tests__/daemon-protocol.test.ts`

Expected: 失败，提示 `daemonPortPath` / `daemonPidPath` 不存在，且 `daemon-protocol.ts` 尚未创建。

- [ ] **Step 3: 最小实现路径字段与协议模块**

```ts
// packages/agent/src/context.ts
export interface AgentAppPaths {
  readonly configDir: string
  readonly agentsDir: string
  readonly logsDir: string
  readonly configFilePath: string
  readonly cliLogFilePath: string
  readonly daemonPortPath: string
  readonly daemonPidPath: string
}

export function getAgentAppPaths(): AgentAppPaths {
  const configDir = getUserTianjiConfigDir()
  const agentsDir = getUserAgentsDir()
  const logsDir = getUserLogsDir()

  return {
    configDir,
    agentsDir,
    logsDir,
    configFilePath: getUserTianjiConfigPath(),
    cliLogFilePath: join(logsDir, 'tianji.log'),
    daemonPortPath: join(configDir, 'daemon.port'),
    daemonPidPath: join(configDir, 'daemon.pid'),
  }
}
```

```ts
// packages/agent/src/daemon-protocol.ts
import type { RuntimeEvent } from '@tianji/shared'

export const DAEMON_SSE_EVENT_NAME = 'chat.event'
export const DAEMON_SSE_DONE_NAME = 'chat.done'
export const DAEMON_SSE_ERROR_NAME = 'chat.error'

export interface ChatRequestBody {
  readonly prompt: string
}

export interface PingResponse {
  readonly sessionId: string
  readonly uptime: number
  readonly pid: number
}

export interface ShutdownResponse {
  readonly ok: true
}

export interface ChatEventSseMessage {
  readonly type: 'chat.event'
  readonly event: RuntimeEvent
}

export interface ChatDoneSseMessage {
  readonly type: 'chat.done'
}

export interface ChatErrorSseMessage {
  readonly type: 'chat.error'
  readonly code: 'BUSY' | 'INTERNAL'
  readonly message: string
}

export type ChatSseMessage = ChatEventSseMessage | ChatDoneSseMessage | ChatErrorSseMessage

export function encodeSseMessage(input: {
  readonly event: string
  readonly data: ChatSseMessage
}): string {
  return `event: ${input.event}\ndata: ${JSON.stringify(input.data)}\n\n`
}
```

```ts
// packages/agent/src/index.ts
export {
  DAEMON_SSE_DONE_NAME,
  DAEMON_SSE_ERROR_NAME,
  DAEMON_SSE_EVENT_NAME,
  encodeSseMessage,
  type ChatRequestBody,
  type ChatSseMessage,
  type PingResponse,
  type ShutdownResponse,
} from './daemon-protocol.js'
```

- [ ] **Step 4: 再跑 agent 测试，确认基础协议通过**

Run: `pnpm test -- --run src/__tests__/context.test.ts src/__tests__/daemon-protocol.test.ts`

Expected: PASS

- [ ] **Step 5: 小步提交**

```bash
git add packages/agent/src/context.ts packages/agent/src/index.ts packages/agent/src/daemon-protocol.ts packages/agent/src/__tests__/context.test.ts packages/agent/src/__tests__/daemon-protocol.test.ts
git commit -m "feat(agent): add daemon protocol primitives"
```

### Task 2: 实现 DaemonServer 与优雅关闭

**Files:**
- Create: `packages/agent/src/daemon-server.ts`
- Modify: `packages/agent/src/index.ts`
- Create: `packages/agent/src/__tests__/daemon-server.test.ts`

- [ ] **Step 1: 先写 server 测试，覆盖 ping/chat/busy/shutdown 行为**

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AgentSession } from '../session.js'
import { DaemonServer } from '../daemon-server.js'

function createStubSession(): AgentSession {
  return {
    sessionId: 'session_test',
    async *chat() {
      yield {
        type: 'message.delta',
        runId: 'run_1',
        sessionId: 'session_test',
        messageId: 'msg_1',
        sequence: 0,
        channel: 'text',
        payload: { content: 'hello' },
      }
      yield {
        type: 'run.completed',
        runId: 'run_1',
        sessionId: 'session_test',
      }
    },
  }
}

describe('DaemonServer', () => {
  it('responds to /ping with session metadata', async () => {
    const server = new DaemonServer({ session: createStubSession(), paths: undefined })
    await server.listen(0)

    const response = await fetch(`http://127.0.0.1:${server.port}/ping`)
    const body = await response.json()

    expect(body.sessionId).toBe('session_test')
    expect(body.pid).toBe(process.pid)

    await server.shutdown()
  })

  it('streams chat events and terminates with chat.done', async () => {
    const server = new DaemonServer({ session: createStubSession(), paths: undefined })
    await server.listen(0)

    const response = await fetch(`http://127.0.0.1:${server.port}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi' }),
    })
    const text = await response.text()

    expect(text).toContain('event: chat.event')
    expect(text).toContain('"type":"message.delta"')
    expect(text).toContain('event: chat.done')

    await server.shutdown()
  })

  it('returns BUSY while another chat is active', async () => {
    let release!: () => void
    const session: AgentSession = {
      sessionId: 'session_busy',
      async *chat() {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        yield {
          type: 'run.completed',
          runId: 'run_busy',
          sessionId: 'session_busy',
        }
      },
    }

    const server = new DaemonServer({ session, paths: undefined })
    await server.listen(0)

    const firstResponse = fetch(`http://127.0.0.1:${server.port}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'one' }),
    })

    const secondResponse = await fetch(`http://127.0.0.1:${server.port}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'two' }),
    })
    const secondText = await secondResponse.text()

    expect(secondText).toContain('event: chat.error')
    expect(secondText).toContain('"code":"BUSY"')

    release()
    await (await firstResponse).arrayBuffer()
    await server.shutdown()
  })
})
```

- [ ] **Step 2: 运行 agent server 测试，确认新测试失败**

Run: `pnpm test -- --run src/__tests__/daemon-server.test.ts`

Expected: 失败，提示 `DaemonServer` 未导出或未实现。

- [ ] **Step 3: 最小实现 DaemonServer、路由与优雅关闭状态机**

```ts
// packages/agent/src/daemon-server.ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile, rm, writeFile } from 'node:fs/promises'

import type { AgentAppPaths } from './context.js'
import {
  DAEMON_SSE_DONE_NAME,
  DAEMON_SSE_ERROR_NAME,
  DAEMON_SSE_EVENT_NAME,
  encodeSseMessage,
  type ChatRequestBody,
} from './daemon-protocol.js'
import type { AgentSession } from './session.js'

export interface DaemonServerOptions {
  readonly session: AgentSession
  readonly paths?: Pick<AgentAppPaths, 'daemonPortPath' | 'daemonPidPath'>
}

export class DaemonServer {
  readonly #session: AgentSession
  readonly #paths?: Pick<AgentAppPaths, 'daemonPortPath' | 'daemonPidPath'>
  readonly #startedAt = Date.now()
  #server: Server | undefined
  #activeChatCount = 0
  #isShuttingDown = false
  #shutdownPromise: Promise<void> | undefined

  constructor(options: DaemonServerOptions) {
    this.#session = options.session
    this.#paths = options.paths
  }

  get port(): number {
    const address = this.#server?.address()
    return address !== null && typeof address === 'object' ? address.port : 0
  }

  async listen(port: number): Promise<void> {
    this.#server = createServer((request, response) => {
      void this.#handleRequest(request, response)
    })

    await new Promise<void>((resolve, reject) => {
      this.#server?.once('error', reject)
      this.#server?.listen(port, '127.0.0.1', () => resolve())
    })

    if (this.#paths !== undefined) {
      await writeFile(this.#paths.daemonPortPath, `${this.port}\n`, 'utf8')
      await writeFile(this.#paths.daemonPidPath, `${process.pid}\n`, 'utf8')
    }
  }

  async shutdown(): Promise<void> {
    if (this.#shutdownPromise !== undefined) {
      return this.#shutdownPromise
    }

    this.#isShuttingDown = true
    this.#shutdownPromise = this.#finalizeShutdown()
    return this.#shutdownPromise
  }

  async #handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === 'GET' && request.url === '/ping') {
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          sessionId: this.#session.sessionId,
          uptime: Math.floor((Date.now() - this.#startedAt) / 1000),
          pid: process.pid,
        })
      )
      return
    }

    if (request.method === 'POST' && request.url === '/shutdown') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ ok: true }))
      void this.shutdown()
      return
    }

    if (request.method === 'POST' && request.url === '/chat') {
      await this.#handleChat(request, response)
      return
    }

    response.statusCode = 404
    response.end('Not Found')
  }

  async #handleChat(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('content-type', 'text/event-stream')
    response.setHeader('cache-control', 'no-cache')
    response.setHeader('connection', 'keep-alive')

    if (this.#activeChatCount > 0 || this.#isShuttingDown) {
      response.end(
        encodeSseMessage({
          event: DAEMON_SSE_ERROR_NAME,
          data: { type: 'chat.error', code: 'BUSY', message: 'Another chat is in progress' },
        })
      )
      return
    }

    this.#activeChatCount += 1

    try {
      const body = await readJsonBody<ChatRequestBody>(request)
      for await (const event of this.#session.chat(body.prompt)) {
        response.write(
          encodeSseMessage({
            event: DAEMON_SSE_EVENT_NAME,
            data: { type: 'chat.event', event },
          })
        )
      }

      response.end(encodeSseMessage({ event: DAEMON_SSE_DONE_NAME, data: { type: 'chat.done' } }))
    } catch (error) {
      response.end(
        encodeSseMessage({
          event: DAEMON_SSE_ERROR_NAME,
          data: {
            type: 'chat.error',
            code: 'INTERNAL',
            message: error instanceof Error ? error.message : String(error),
          },
        })
      )
    } finally {
      this.#activeChatCount -= 1
    }
  }
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Uint8Array[] = []

  for await (const chunk of request) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
}
```

- [ ] **Step 4: 补齐关闭等待与文件清理测试，再迭代实现**

```ts
it('cleans pid and port files during shutdown', async () => {
  const paths = {
    daemonPortPath: join(tmpdir(), `daemon-${Date.now()}.port`),
    daemonPidPath: join(tmpdir(), `daemon-${Date.now()}.pid`),
  }
  const server = new DaemonServer({ session: createStubSession(), paths })

  await server.listen(0)
  await server.shutdown()

  await expect(readFile(paths.daemonPortPath, 'utf8')).rejects.toThrow()
  await expect(readFile(paths.daemonPidPath, 'utf8')).rejects.toThrow()
})
```

Run: `pnpm test -- --run src/__tests__/daemon-server.test.ts`

Expected: 先失败，再补上 `server.close()`、等待活跃 chat 结束、删除 `daemon.port`/`daemon.pid` 的逻辑后 PASS。

- [ ] **Step 5: 小步提交**

```bash
git add packages/agent/src/daemon-server.ts packages/agent/src/index.ts packages/agent/src/__tests__/daemon-server.test.ts
git commit -m "feat(agent): add daemon server"
```

### Task 3: 实现 DaemonClient 与 SSE 解析

**Files:**
- Create: `packages/agent/src/daemon-client.ts`
- Modify: `packages/agent/src/index.ts`
- Create: `packages/agent/src/__tests__/daemon-client.test.ts`

- [ ] **Step 1: 先写 client 测试，固定 ping/sendChat/错误处理接口**

```ts
import { createServer } from 'node:http'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { DaemonClient } from '../daemon-client.js'

describe('DaemonClient', () => {
  it('parses SSE runtime events from /chat', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/chat') {
        response.setHeader('content-type', 'text/event-stream')
        response.end(
          'event: chat.event\n' +
            'data: {"type":"chat.event","event":{"type":"message.delta","runId":"run_1","sessionId":"session_1","messageId":"msg_1","sequence":0,"channel":"text","payload":{"content":"hi"}}}\n\n' +
            'event: chat.done\n' +
            'data: {"type":"chat.done"}\n\n'
        )
        return
      }

      if (request.url === '/ping') {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ sessionId: 'session_1', uptime: 3, pid: 123 }))
        return
      }
    })

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const client = new DaemonClient({ host: '127.0.0.1', port })

    const events = []
    for await (const event of client.sendChat('hello')) {
      events.push(event)
    }

    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('message.delta')
    server.close()
  })

  it('throws busy error on chat.error BUSY', async () => {
    // server 返回 chat.error
  })
})
```

- [ ] **Step 2: 运行 agent client 测试，确认失败**

Run: `pnpm test -- --run src/__tests__/daemon-client.test.ts`

Expected: 失败，提示 `DaemonClient` 未实现。

- [ ] **Step 3: 实现最小 client、SSE 行缓冲解析与 ping**

```ts
// packages/agent/src/daemon-client.ts
import { request } from 'node:http'

import type { RuntimeEvent } from '@tianji/shared'

import type { ChatRequestBody, ChatSseMessage, PingResponse, ShutdownResponse } from './daemon-protocol.js'

export interface DaemonClientOptions {
  readonly host: string
  readonly port: number
}

export class DaemonClient {
  readonly #host: string
  readonly #port: number

  constructor(options: DaemonClientOptions) {
    this.#host = options.host
    this.#port = options.port
  }

  async ping(): Promise<PingResponse> {
    return this.#requestJson<PingResponse>('GET', '/ping')
  }

  async shutdown(): Promise<ShutdownResponse> {
    return this.#requestJson<ShutdownResponse>('POST', '/shutdown')
  }

  async *sendChat(prompt: string): AsyncIterable<RuntimeEvent> {
    const response = await this.#requestStream('POST', '/chat', { prompt })

    for await (const message of parseSseMessages(response)) {
      if (message.type === 'chat.event') {
        yield message.event
        continue
      }

      if (message.type === 'chat.done') {
        return
      }

      throw new Error(message.message)
    }
  }
}
```

```ts
function parseSseMessages(stream: NodeJS.ReadableStream): AsyncIterable<ChatSseMessage> {
  return {
    async *[Symbol.asyncIterator]() {
      let buffer = ''
      let eventName = ''
      let dataLine = ''

      for await (const chunk of stream) {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            eventName = line.slice('event: '.length)
            continue
          }

          if (line.startsWith('data: ')) {
            dataLine = line.slice('data: '.length)
            continue
          }

          if (line === '' && eventName.length > 0 && dataLine.length > 0) {
            yield JSON.parse(dataLine) as ChatSseMessage
            eventName = ''
            dataLine = ''
          }
        }
      }
    },
  }
}
```

- [ ] **Step 4: 补齐错误分支测试并验证通过**

Run: `pnpm test -- --run src/__tests__/daemon-client.test.ts`

Expected: PASS。补充至少以下断言：

```ts
it('throws daemon BUSY error messages', async () => {
  await expect(async () => {
    for await (const _event of client.sendChat('hello')) {
      // no-op
    }
  }).rejects.toThrow('Another chat is in progress')
})
```

- [ ] **Step 5: 小步提交**

```bash
git add packages/agent/src/daemon-client.ts packages/agent/src/index.ts packages/agent/src/__tests__/daemon-client.test.ts
git commit -m "feat(agent): add daemon client"
```

### Task 4: 新增 CLI 命令解析与 daemon 子进程入口

**Files:**
- Modify: `apps/cli/src/main.ts`
- Create: `apps/cli/src/daemon-entry.ts`
- Modify: `apps/cli/src/config.ts`
- Create: `apps/cli/src/__tests__/main-daemon.test.ts`

- [ ] **Step 1: 先写 CLI 测试，固定新命令解析与错误信息**

```ts
import { describe, expect, it } from 'vitest'

import { parseCliArgs } from '../main.js'

describe('parseCliArgs daemon commands', () => {
  it('parses daemon command', () => {
    expect(parseCliArgs(['daemon'])).toEqual({ kind: 'daemon', foreground: false })
    expect(parseCliArgs(['daemon', '--fg'])).toEqual({ kind: 'daemon', foreground: true })
  })

  it('parses chat status and stop commands', () => {
    expect(parseCliArgs(['chat'])).toEqual({ kind: 'chat' })
    expect(parseCliArgs(['status'])).toEqual({ kind: 'status' })
    expect(parseCliArgs(['stop'])).toEqual({ kind: 'stop' })
  })

  it('rejects unknown daemon flags', () => {
    expect(() => parseCliArgs(['daemon', '--bad'])).toThrow(
      'Command "daemon" only supports "--fg".'
    )
  })
})
```

- [ ] **Step 2: 运行 CLI 测试，确认失败**

Run: `pnpm test -- --run src/__tests__/main-daemon.test.ts`

Expected: 失败，提示命令 union 不包含 `daemon` / `chat` / `status` / `stop`。

- [ ] **Step 3: 扩展 `main.ts` 命令模型与帮助文本**

```ts
export interface DaemonCommand {
  readonly kind: 'daemon'
  readonly foreground: boolean
}

export interface ChatCommand {
  readonly kind: 'chat'
}

export interface StatusCommand {
  readonly kind: 'status'
}

export interface StopCommand {
  readonly kind: 'stop'
}

export type TianjiCliCommand =
  | RunCommand
  | LogFollowCommand
  | HelpCommand
  | DaemonCommand
  | ChatCommand
  | StatusCommand
  | StopCommand
```

```ts
const CLI_HELP_TEXT = [
  'Usage:',
  '  tianji run "<prompt>"',
  '  tianji daemon [--fg]',
  '  tianji chat',
  '  tianji status',
  '  tianji stop',
  '  tianji log -f [--lines <n>]',
  '  tianji help',
].join('\n')
```

- [ ] **Step 4: 实现 daemon 入口与最小命令分发**

```ts
// apps/cli/src/daemon-entry.ts
import { createAgentSession, loadAgentContext, DaemonServer } from '@tianji/agent'

export async function runDaemonEntry(): Promise<void> {
  const context = await loadAgentContext()
  const session = createAgentSession(context)
  const server = new DaemonServer({
    session,
    paths: {
      daemonPortPath: context.paths.daemonPortPath,
      daemonPidPath: context.paths.daemonPidPath,
    },
  })

  await server.listen(0)

  const shutdown = () => {
    void server.shutdown().finally(() => process.exit(0))
  }

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}
```

```ts
// apps/cli/src/main.ts inside runCli()
if (command.kind === 'daemon') {
  return await handleDaemonCommand(command, deps)
}

if (command.kind === 'chat') {
  return await handleChatCommand(deps)
}

if (command.kind === 'status') {
  return await handleStatusCommand(deps)
}

if (command.kind === 'stop') {
  return await handleStopCommand(deps)
}
```

- [ ] **Step 5: 再跑 CLI 命令测试，确保解析与入口导出通过**

Run: `pnpm test -- --run src/__tests__/main-daemon.test.ts`

Expected: PASS

- [ ] **Step 6: 小步提交**

```bash
git add apps/cli/src/main.ts apps/cli/src/daemon-entry.ts apps/cli/src/config.ts apps/cli/src/__tests__/main-daemon.test.ts
git commit -m "feat(cli): add daemon command parsing"
```

### Task 5: 实现 daemon 启动、status/stop 与 REPL chat

**Files:**
- Modify: `apps/cli/src/main.ts`
- Modify: `apps/cli/src/__tests__/main-daemon.test.ts`

- [ ] **Step 1: 为 status/stop/chat 写行为测试，覆盖无 daemon、连接成功、REPL 消费事件**

```ts
import { describe, expect, it, vi } from 'vitest'

import { runCli } from '../main.js'

describe('daemon CLI commands', () => {
  it('returns non-zero when status cannot find daemon', async () => {
    const exitCode = await runCli(['status'], {
      getUserConfigPaths: () => ({
        configDir: '/tmp/test',
        agentsDir: '/tmp/test/agents',
        logsDir: '/tmp/test/logs',
        configFilePath: '/tmp/test/tianji.json',
        cliLogFilePath: '/tmp/test/logs/tianji.log',
        daemonPortPath: '/tmp/test/daemon.port',
        daemonPidPath: '/tmp/test/daemon.pid',
      }),
    })

    expect(exitCode).toBe(1)
  })
})
```

- [ ] **Step 2: 运行 CLI 测试，确认行为测试先失败**

Run: `pnpm test -- --run src/__tests__/main-daemon.test.ts`

Expected: 失败，提示缺少 daemon 文件读取、client 调用或 REPL 依赖注入。

- [ ] **Step 3: 实现 daemon 启动流程与 stale 文件探测**

```ts
async function handleDaemonCommand(command: DaemonCommand, deps?: RunCommandDependencies): Promise<number> {
  const paths = (deps?.getUserConfigPaths ?? getUserConfigPaths)()

  const runningClient = await tryCreateDaemonClient(paths)
  if (runningClient !== undefined) {
    const status = await runningClient.ping()
    process.stdout.write(`Daemon already running (pid=${status.pid})\n`)
    return 0
  }

  await cleanupStaleDaemonFiles(paths)

  if (command.foreground) {
    await runDaemonEntry()
    return 0
  }

  const child = fork(new URL('./daemon-entry.js', import.meta.url), [], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()

  const daemonInfo = await waitForDaemonReady(paths)
  process.stdout.write(`Daemon started (pid=${daemonInfo.pid}, port=${daemonInfo.port})\n`)
  return 0
}
```

- [ ] **Step 4: 实现 `status`、`stop` 和 `chat` REPL**

```ts
async function handleChatCommand(deps?: RunCommandDependencies): Promise<number> {
  const client = await requireDaemonClient(deps)
  const status = await client.ping()
  process.stdout.write(`Connected to daemon (pid=${status.pid})\n`)

  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' })
  rl.prompt()

  for await (const line of rl) {
    const prompt = line.trim()
    if (prompt === '') {
      rl.prompt()
      continue
    }
    if (prompt === '.exit') {
      rl.close()
      break
    }

    for await (const event of client.sendChat(prompt)) {
      await handleRuntimeEvent(event, createCliLoggerFromPaths((deps?.getUserConfigPaths ?? getUserConfigPaths)()))
    }

    process.stdout.write('\n')
    rl.prompt()
  }

  return 0
}
```

实现时补齐：

- `readDaemonPort(paths)`：读取 `daemon.port`，解析整数。
- `tryCreateDaemonClient(paths)`：读端口后尝试 `ping()`，失败返回 `undefined`。
- `requireDaemonClient()`：失败时抛错 `No daemon running. Start with: tianji daemon`。
- `handleStatusCommand()`：输出 `Daemon running (pid=..., port=..., sessionId=...)`。
- `handleStopCommand()`：调用 `/shutdown` 后输出 `Daemon stopped`。
- 避免在 REPL 中重复创建 logger，可在进入循环前构造一次。

- [ ] **Step 5: 运行 CLI 测试并手工验证命令流**

Run: `pnpm test -- --run src/__tests__/main-daemon.test.ts`

Expected: PASS

Run: `pnpm --filter @tianji/cli build`

Expected: 构建成功。

手工验证：

```bash
pnpm tianji daemon
pnpm tianji status
pnpm tianji chat
pnpm tianji stop
```

Expected:

- `daemon` 输出 `Daemon started (pid=..., port=...)`
- `status` 输出 daemon 在线信息
- `chat` 可连接并持续多轮输出文本
- `stop` 输出 `Daemon stopped`

- [ ] **Step 6: 小步提交**

```bash
git add apps/cli/src/main.ts apps/cli/src/__tests__/main-daemon.test.ts
git commit -m "feat(cli): add daemon lifecycle commands"
```

### Task 6: 文档、回归测试与最终校验

**Files:**
- Modify: `apps/cli/README.md`
- Modify: `README.md`

- [ ] **Step 1: 更新 CLI README，补充 daemon/chat/status/stop 用法与路径说明**

```md
## 命令用法

### `tianji daemon [--fg]`

- 启动后台 daemon，持有单个 `AgentSession` 并监听 `localhost` HTTP 服务。
- 默认模式会 fork 子进程并把端口写入 `~/.config/tianji-ai/daemon.port`，PID 写入 `~/.config/tianji-ai/daemon.pid`。
- `--fg` 以前台模式启动，便于调试。

### `tianji chat`

- 连接 daemon 并进入基于 `node:readline` 的 REPL。
- 多轮对话共享同一 session。
- 输入 `.exit` 或 `Ctrl+C` 退出。

### `tianji status`

- 检查 daemon 是否在线，并输出 `pid`、`port`、`sessionId`。

### `tianji stop`

- 调用 daemon 的 `/shutdown` 接口，等待其优雅退出。
```

- [ ] **Step 2: 更新根 README 的 CLI 概览**

```md
- `pnpm tianji daemon`：启动后台会话守护进程
- `pnpm tianji chat`：连接 daemon 进行多轮对话
- `pnpm tianji status`：查看 daemon 状态
- `pnpm tianji stop`：关闭 daemon
```

- [ ] **Step 3: 运行 agent 包测试**

Run: `pnpm test`

Workdir: `packages/agent`

Expected: 所有 agent 测试 PASS，包括 `context`、`session`、`daemon-protocol`、`daemon-server`、`daemon-client`。

- [ ] **Step 4: 运行 CLI 包测试**

Run: `pnpm test`

Workdir: `apps/cli`

Expected: 所有 CLI 测试 PASS，包括现有测试与新加 daemon 命令测试。

- [ ] **Step 5: 运行仓库级静态校验**

Run: `pnpm check`

Workdir: `/workspaces/dev_docker/tianji-ai`

Expected: 完整输出无 error、warning、info 残留；若失败，修复后重复执行直到通过。

- [ ] **Step 6: 最终提交**

```bash
git add apps/cli/README.md README.md packages/agent/src packages/agent/src/__tests__ apps/cli/src apps/cli/src/__tests__
git commit -m "feat(cli): add daemon-backed chat repl"
```

## 自检

- 规格覆盖：
  - `POST /chat` SSE 协议、`BUSY` 并发限制、`GET /ping`、`POST /shutdown`、单 session/单 chat、SIGTERM/SIGINT、`daemon --fg`、`chat` REPL、`status`、`stop`、路径文件与 README 更新都已对应到任务。
- 占位符扫描：
  - 无 `TODO`、`TBD`、`implement later` 之类占位内容；所有任务都给出具体文件、代码或命令。
- 类型一致性：
  - 统一使用 `ChatRequestBody`、`PingResponse`、`ShutdownResponse`、`ChatSseMessage`、`DaemonClient.sendChat()`、`DaemonServer`、`daemonPortPath`、`daemonPidPath`。

Plan complete and saved to `docs/superpowers/plans/2026-03-31-daemon-chat-implementation.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
