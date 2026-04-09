# LLM API 调用录制 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每次 runTurn 结束后（无论成功/失败/取消），将该 turn 中所有 LLM API 调用的完整 request/response 存入 `{snapshotDir}/raws/llm_{runId}.json`。

**Architecture:** 通过 `langchain` 包的 `createMiddleware` 创建 `wrapModelCall` 中间件，拦截每次 LLM 调用的 `ModelRequest`（含 model、messages、systemMessage、tools、toolChoice、modelSettings）和 `AIMessage` 响应（含 content、tool_calls、usage_metadata）。中间件在 `executeDeepagentsRun` 中注入 deepagents agent。调用记录由 `LlmCallRecorder` 类收集，runTurn 结束后由 `LlmRawStore` 写入文件。存储目录通过 `ExecuteDeepagentsRunOptions.llmRawDir` 注入，由 `runtime.ts` 调用方提供，测试时可传临时目录。

**Tech Stack:** TypeScript、Node.js fs/promises、langchain `createMiddleware` + `ModelRequest` + `WrapModelCallHook`、vitest

---

## 文件结构

| 操作 | 文件 | 职责 |
|------|------|------|
| 新建 | `packages/runtime/src/llm-raw-store.ts` | 文件写入层：原子写 `llm_{runId}.json` |
| 新建 | `packages/runtime/src/llm-call-recorder.ts` | 中间件数据收集：序列化 + `createMiddleware` 工厂 |
| 修改 | `packages/runtime/src/engines/deepagents-engine.ts` | 注入录制 middleware、runTurn 结束后持久化 |
| 修改 | `packages/runtime/src/runtime.ts` | 计算 `llmRawDir` 并传入 `executeDeepagentsRun` |
| 修改 | `packages/runtime/src/types.ts` | `SessionRuntimeDeepagentsConfig` 新增 `llmRawDir` 字段 |
| 新建 | `packages/runtime/src/__tests__/llm-raw-store.test.ts` | LlmRawStore 单元测试 |
| 新建 | `packages/runtime/src/__tests__/llm-call-recorder.test.ts` | LlmCallRecorder 单元测试 + 与 LlmRawStore 集成测试 |
| 修改 | `packages/runtime/src/__tests__/helpers/runtime-test-utils.ts` | 测试 helper 传递 llmRawDir |

---

## 已确认的 API（从 node_modules 实际类型定义读取）

**langchain `ModelRequest`**（`langchain/dist/agents/nodes/types.d.ts`）：
```typescript
interface ModelRequest<TState, TContext> {
  model: LanguageModelLike           // Runnable<BaseLanguageModelInput, LanguageModelOutput>
  messages: BaseMessage[]
  systemPrompt: string               // @deprecated, use systemMessage
  systemMessage: SystemMessage
  toolChoice?: "auto" | "none" | "required" | { type: "function"; function: { name: string } }
  tools: (ServerTool | ClientTool)[]
  state: TState & AgentBuiltInState
  runtime: Runtime<TContext>
  modelSettings?: Record<string, unknown>
}
```

**langchain `createMiddleware`**（`langchain/dist/agents/middleware.d.ts`）：
```typescript
function createMiddleware(config: {
  name: string
  wrapModelCall?: WrapModelCallHook
  // ... 其他可选 hooks
}): AgentMiddleware
```

**langchain `WrapModelCallHook`**：
```typescript
type WrapModelCallHook<TSchema, TContext> = (
  request: ModelRequest<NormalizedSchemaInput<TSchema>, TContext>,
  handler: WrapModelCallHandler<TSchema, TContext>
) => PromiseOrValue<AIMessage | Command>
```

**`@langchain/core/messages` BaseMessage**：
- `content: MessageContent`（string | ContentBlock[]）
- `additional_kwargs: Record<string, any>`
- `name?: string`
- `_getType(): MessageType`（返回 "human" | "ai" | "system" | "tool" 等）
- `getType(): MessageType`

**`ToolMessage`** 有 `tool_call_id: string`。

**`AIMessage`**：
- `tool_calls?: ToolCall[]`，每个 ToolCall 有 `id: string`、`name: string`、`args: Record<string, unknown>`
- `usage_metadata?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }`
- `additional_kwargs: Record<string, any>`

---

## Task 1: 创建 `LlmRawStore` — 文件写入层

**Files:**
- Create: `packages/runtime/src/llm-raw-store.ts`
- Test: `packages/runtime/src/__tests__/llm-raw-store.test.ts`

- [ ] **Step 1: 写测试**

```typescript
// packages/runtime/src/__tests__/llm-raw-store.test.ts
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect, afterEach } from 'vitest'
import { LlmRawStore, type LlmRawRecord } from '../llm-raw-store.js'

describe('LlmRawStore', () => {
  let testDir: string

  afterEach(async () => {
    if (testDir !== undefined) {
      await rm(testDir, { recursive: true, force: true })
    }
  })

  it('write 在 raws/ 子目录下创建 llm_{runId}.json', async () => {
    testDir = join(tmpdir(), `llm-raw-test-${Date.now()}`)
    const store = new LlmRawStore(testDir)

    const record: LlmRawRecord = {
      runId: 'run_abc123',
      sessionId: 'sess_xyz',
      createdAt: 1712544000000,
      calls: [
        {
          index: 0,
          request: {
            model: 'gpt-4',
            systemPrompt: 'hello',
            messages: [],
            tools: [],
          },
          response: {
            content: 'Hi!',
            toolCalls: [],
          },
        },
      ],
    }

    await store.write(record)

    const content = await readFile(join(testDir, 'raws', 'llm_run_abc123.json'), 'utf8')
    const parsed = JSON.parse(content)
    expect(parsed.runId).toBe('run_abc123')
    expect(parsed.calls[0].request.model).toBe('gpt-4')
    expect(parsed.calls[0].response.content).toBe('Hi!')
  })

  it('write 同一 runId 覆盖已有文件', async () => {
    testDir = join(tmpdir(), `llm-raw-ow-${Date.now()}`)
    const store = new LlmRawStore(testDir)

    const baseRecord: LlmRawRecord = {
      runId: 'run_ow',
      sessionId: 's1',
      createdAt: 1000,
      calls: [],
    }

    await store.write({ ...baseRecord, createdAt: 1000 })
    await store.write({ ...baseRecord, createdAt: 2000 })

    const content = await readFile(join(testDir, 'raws', 'llm_run_ow.json'), 'utf8')
    expect(JSON.parse(content).createdAt).toBe(2000)
  })

  it('write 空目录自动创建', async () => {
    testDir = join(tmpdir(), `llm-raw-mkdir-${Date.now()}`)
    const store = new LlmRawStore(testDir)

    await store.write({
      runId: 'run_mkdir',
      sessionId: 's1',
      createdAt: 1000,
      calls: [],
    })

    const content = await readFile(join(testDir, 'raws', 'llm_run_mkdir.json'), 'utf8')
    expect(JSON.parse(content).runId).toBe('run_mkdir')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @tianji/runtime test -- src/__tests__/llm-raw-store.test.ts`
Expected: FAIL — 找不到模块 `../llm-raw-store.js`

- [ ] **Step 3: 实现 `LlmRawStore`**

```typescript
// packages/runtime/src/llm-raw-store.ts
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

export interface SerializedMessage {
  readonly role: string
  readonly content: unknown
  readonly name?: string
  readonly toolCallId?: string
  readonly additional_kwargs?: Record<string, unknown>
}

export interface SerializedTool {
  readonly name: string
  readonly description?: string
  readonly schema?: unknown
}

export interface SerializedToolCall {
  readonly id: string
  readonly name: string
  readonly args: unknown
}

export interface LlmCallRequest {
  readonly model: string
  readonly systemPrompt: string
  readonly messages: readonly SerializedMessage[]
  readonly tools: readonly SerializedTool[]
  readonly toolChoice?: unknown
  readonly modelSettings?: Record<string, unknown>
}

export interface LlmCallResponse {
  readonly content: unknown
  readonly toolCalls: readonly SerializedToolCall[]
  readonly usageMetadata?: {
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly totalTokens?: number
  }
  readonly additional_kwargs?: Record<string, unknown>
}

export interface LlmCallRecord {
  readonly index: number
  readonly request: LlmCallRequest
  readonly response: LlmCallResponse
}

export interface LlmRawRecord {
  readonly runId: string
  readonly sessionId: string
  readonly createdAt: number
  readonly calls: readonly LlmCallRecord[]
}

/**
 * 将 LLM 调用记录原子写入 {baseDirectory}/raws/llm_{runId}.json。
 *
 * 写入方式: 先写临时文件再 rename，保证文件内容完整性。
 */
export class LlmRawStore {
  constructor(private readonly baseDirectory: string) {}

  async write(record: LlmRawRecord): Promise<void> {
    const rawsDir = join(this.baseDirectory, 'raws')
    await mkdir(rawsDir, { recursive: true })

    const targetPath = join(rawsDir, `llm_${record.runId}.json`)
    const tmpPath = `${targetPath}.${randomUUID()}.tmp`

    await writeFile(tmpPath, JSON.stringify(record, null, 2), 'utf8')
    await rename(tmpPath, targetPath)
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @tianji/runtime test -- src/__tests__/llm-raw-store.test.ts`
Expected: 3 tests PASS

---

## Task 2: 创建 `LlmCallRecorder` — 序列化 + 中间件工厂

**Files:**
- Create: `packages/runtime/src/llm-call-recorder.ts`
- Test: `packages/runtime/src/__tests__/llm-call-recorder.test.ts`

- [ ] **Step 1: 写测试**

```typescript
// packages/runtime/src/__tests__/llm-call-recorder.test.ts
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, it, expect } from 'vitest'
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages'
import { LlmCallRecorder, createRecordingMiddleware } from '../llm-call-recorder.js'
import { LlmRawStore } from '../llm-raw-store.js'

/**
 * 构造一个最小可用的 ModelRequest 对象。
 *
 * 字段来源：langchain ModelRequest 类型定义
 * (langchain/dist/agents/nodes/types.d.ts)
 */
function makeModelRequest(overrides: Record<string, unknown> = {}) {
  return {
    model: {
      lc: [1, 2],
      _llmType: () => 'openai',
      modelName: 'gpt-4',
    },
    messages: [],
    systemPrompt: '',
    systemMessage: new SystemMessage(''),
    tools: [],
    state: {},
    runtime: {},
    ...overrides,
  }
}

describe('LlmCallRecorder', () => {
  it('recordCall 按序记录 request 和 response', () => {
    const recorder = new LlmCallRecorder()
    recorder.recordCall(
      makeModelRequest({
        systemPrompt: 'test',
        systemMessage: new SystemMessage('test'),
      }),
      new AIMessage({ content: 'Hello!' })
    )

    const calls = recorder.getCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0].index).toBe(0)
    expect(calls[0].request.systemPrompt).toBe('test')
    expect(calls[0].response.content).toBe('Hello!')
  })

  it('多次调用 index 递增', () => {
    const recorder = new LlmCallRecorder()
    recorder.recordCall(makeModelRequest(), new AIMessage({ content: 'a' }))
    recorder.recordCall(makeModelRequest(), new AIMessage({ content: 'b' }))

    expect(recorder.getCalls().map((c) => c.index)).toEqual([0, 1])
  })

  it('toRecord 生成完整 LlmRawRecord', () => {
    const recorder = new LlmCallRecorder()
    recorder.recordCall(makeModelRequest(), new AIMessage({ content: 'x' }))

    const record = recorder.toRecord('run_1', 'sess_1')
    expect(record.runId).toBe('run_1')
    expect(record.sessionId).toBe('sess_1')
    expect(record.createdAt).toBeGreaterThan(0)
    expect(record.calls).toHaveLength(1)
  })

  it('无调用时 toRecord 返回空 calls', () => {
    const recorder = new LlmCallRecorder()
    expect(recorder.toRecord('r', 's').calls).toHaveLength(0)
  })

  it('序列化 tool_calls', () => {
    const recorder = new LlmCallRecorder()
    recorder.recordCall(
      makeModelRequest(),
      new AIMessage({
        content: '',
        tool_calls: [
          { id: 'c1', name: 'read_file', args: { path: '/a' } },
        ],
      })
    )

    const tc = recorder.getCalls()[0].response.toolCalls
    expect(tc).toHaveLength(1)
    expect(tc[0].name).toBe('read_file')
    expect(tc[0].args).toEqual({ path: '/a' })
  })

  it('序列化 usage_metadata', () => {
    const recorder = new LlmCallRecorder()
    recorder.recordCall(
      makeModelRequest(),
      new AIMessage({
        content: 'hi',
        usage_metadata: {
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
        },
      })
    )

    const usage = recorder.getCalls()[0].response.usageMetadata
    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    })
  })

  it('序列化 messages 中的 HumanMessage', () => {
    const recorder = new LlmCallRecorder()
    recorder.recordCall(
      makeModelRequest({
        messages: [new HumanMessage('hello world')],
      }),
      new AIMessage({ content: 'response' })
    )

    const msg = recorder.getCalls()[0].request.messages[0]
    expect(msg.role).toBe('human')
    expect(msg.content).toBe('hello world')
  })

  it('序列化 ToolMessage 带 toolCallId', () => {
    const recorder = new LlmCallRecorder()
    recorder.recordCall(
      makeModelRequest({
        messages: [
          new ToolMessage({
            content: 'file content',
            tool_call_id: 'tc_1',
          }),
        ],
      }),
      new AIMessage({ content: 'done' })
    )

    const msg = recorder.getCalls()[0].request.messages[0]
    expect(msg.role).toBe('tool')
    expect(msg.toolCallId).toBe('tc_1')
  })

  it('从 model 对象提取 modelName', () => {
    const recorder = new LlmCallRecorder()
    recorder.recordCall(
      makeModelRequest({
        model: { modelName: 'claude-3.5-sonnet', lc: [] },
      }),
      new AIMessage({ content: 'ok' })
    )

    expect(recorder.getCalls()[0].request.model).toBe('claude-3.5-sonnet')
  })

  it('从 model 字符串直接提取', () => {
    const recorder = new LlmCallRecorder()
    recorder.recordCall(
      makeModelRequest({
        model: 'gpt-4o',
      }),
      new AIMessage({ content: 'ok' })
    )

    expect(recorder.getCalls()[0].request.model).toBe('gpt-4o')
  })
})

describe('LlmCallRecorder + LlmRawStore 集成', () => {
  it('recorder 产出可被 store 正确写入和读取', async () => {
    const testDir = join(tmpdir(), `llm-int-${Date.now()}`)
    const store = new LlmRawStore(testDir)
    const recorder = new LlmCallRecorder()

    recorder.recordCall(
      makeModelRequest({
        systemPrompt: 'integration',
        systemMessage: new SystemMessage('integration'),
      }),
      new AIMessage({ content: 'resp' })
    )

    await store.write(recorder.toRecord('run_int', 'sess_int'))

    const written = JSON.parse(
      await readFile(join(testDir, 'raws', 'llm_run_int.json'), 'utf8')
    )
    expect(written.calls[0].request.systemPrompt).toBe('integration')
    expect(written.calls[0].response.content).toBe('resp')

    await rm(testDir, { recursive: true, force: true })
  })
})

describe('createRecordingMiddleware', () => {
  it('返回带 name 和 wrapModelCall 的 middleware 对象', () => {
    const recorder = new LlmCallRecorder()
    const middleware = createRecordingMiddleware(recorder)

    expect(middleware.name).toBe('tianji-llm-call-recorder')
    expect(typeof middleware.wrapModelCall).toBe('function')
  })

  it('wrapModelCall 调用 handler 后记录 request/response', async () => {
    const recorder = new LlmCallRecorder()
    const middleware = createRecordingMiddleware(recorder)
    const request = makeModelRequest({ systemPrompt: 'mid-test' })
    const fakeResponse = new AIMessage({ content: 'from handler' })

    const result = await middleware.wrapModelCall!(
      request,
      async () => fakeResponse
    )

    expect(result).toBe(fakeResponse)
    expect(recorder.getCalls()).toHaveLength(1)
    expect(recorder.getCalls()[0].request.systemPrompt).toBe('mid-test')
    expect(recorder.getCalls()[0].response.content).toBe('from handler')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm --filter @tianji/runtime test -- src/__tests__/llm-call-recorder.test.ts`
Expected: FAIL — 找不到模块 `../llm-call-recorder.js`

- [ ] **Step 3: 实现 `LlmCallRecorder`**

```typescript
// packages/runtime/src/llm-call-recorder.ts
import type { AIMessage, BaseMessage } from '@langchain/core/messages'
import type { ToolMessage } from '@langchain/core/messages'
import { createMiddleware, type AgentMiddleware } from 'langchain'
import type {
  LlmCallRecord,
  LlmCallRequest,
  LlmCallResponse,
  LlmRawRecord,
  SerializedMessage,
  SerializedTool,
  SerializedToolCall,
} from './llm-raw-store.js'

/**
 * 在 middleware 的 wrapModelCall 中收集每次 LLM 调用。
 *
 * 用法：runTurn 开始时创建 → wrapModelCall 中调用 recordCall → runTurn 结束后 toRecord。
 */
export class LlmCallRecorder {
  private readonly calls: LlmCallRecord[] = []

  recordCall(request: Record<string, unknown>, response: AIMessage): void {
    this.calls.push({
      index: this.calls.length,
      request: serializeRequest(request),
      response: serializeResponse(response),
    })
  }

  getCalls(): readonly LlmCallRecord[] {
    return this.calls
  }

  toRecord(runId: string, sessionId: string): LlmRawRecord {
    return {
      runId,
      sessionId,
      createdAt: Date.now(),
      calls: [...this.calls],
    }
  }
}

/**
 * 创建录制 LLM API 调用的 middleware。
 * 通过 wrapModelCall hook 拦截每次模型调用的完整 request/response。
 */
export function createRecordingMiddleware(recorder: LlmCallRecorder): AgentMiddleware {
  return createMiddleware({
    name: 'tianji-llm-call-recorder',
    wrapModelCall: async (request, handler) => {
      const response = await handler(request)
      recorder.recordCall(request as Record<string, unknown>, response as AIMessage)
      return response
    },
  })
}

/**
 * 从 ModelRequest 对象提取可序列化的 LlmCallRequest。
 *
 * ModelRequest 的实际类型来自 langchain/dist/agents/nodes/types.d.ts：
 *   model: LanguageModelLike, messages: BaseMessage[], systemPrompt: string,
 *   systemMessage: SystemMessage, tools: (ServerTool|ClientTool)[],
 *   toolChoice?: ..., modelSettings?: Record<string, unknown>
 */
function serializeRequest(request: Record<string, unknown>): LlmCallRequest {
  return {
    model: extractModelName(request.model),
    systemPrompt: typeof request.systemPrompt === 'string'
      ? request.systemPrompt
      : '',
    messages: serializeMessages(request.messages),
    tools: serializeTools(request.tools),
    toolChoice: request.toolChoice,
    modelSettings: typeof request.modelSettings === 'object' && request.modelSettings !== null
      ? request.modelSettings as Record<string, unknown>
      : undefined,
  }
}

function serializeMessages(messages: unknown): SerializedMessage[] {
  if (!Array.isArray(messages)) return []

  return messages.map((msg: BaseMessage) => ({
    role: msg._getType(),
    content: msg.content,
    name: msg.name ?? undefined,
    toolCallId: isToolMessage(msg) ? msg.tool_call_id : undefined,
    additional_kwargs: Object.keys(msg.additional_kwargs ?? {}).length > 0
      ? msg.additional_kwargs as Record<string, unknown>
      : undefined,
  }))
}

function isToolMessage(msg: BaseMessage): msg is ToolMessage {
  return msg._getType() === 'tool'
}

function serializeTools(tools: unknown): SerializedTool[] {
  if (!Array.isArray(tools)) return []

  return tools.map((tool: unknown) => {
    if (typeof tool === 'object' && tool !== null) {
      const obj = tool as Record<string, unknown>
      return {
        name: typeof obj.name === 'string' ? obj.name : String(tool),
        description: typeof obj.description === 'string' ? obj.description : undefined,
        schema: obj.schema,
      }
    }
    return { name: String(tool) }
  })
}

function serializeResponse(response: AIMessage): LlmCallResponse {
  const toolCalls: SerializedToolCall[] = (response.tool_calls ?? []).map(
    (tc: { id?: string; name?: string; args?: unknown }) => ({
      id: tc.id ?? '',
      name: tc.name ?? '',
      args: tc.args,
    })
  )

  const usage = response.usage_metadata as
    | { input_tokens?: number; output_tokens?: number; total_tokens?: number }
    | undefined

  return {
    content: response.content,
    toolCalls,
    usageMetadata: usage !== undefined
      ? {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          totalTokens: usage.total_tokens,
        }
      : undefined,
    additional_kwargs: Object.keys(response.additional_kwargs ?? {}).length > 0
      ? response.additional_kwargs as Record<string, unknown>
      : undefined,
  }
}

/**
 * 从 ModelRequest.model 提取模型名称。
 *
 * LanguageModelLike 是 Runnable<BaseLanguageModelInput, LanguageModelOutput>，
 * 实际运行时通常是 BaseChatModel 子类（如 ChatOpenAI），其上有 modelName 字段。
 * 也可能是字符串（deepagents 简写格式如 'openai:gpt-4'）。
 */
function extractModelName(model: unknown): string {
  if (model === undefined || model === null) return ''
  if (typeof model === 'string') return model
  if (typeof model === 'object') {
    const obj = model as Record<string, unknown>
    if (typeof obj.modelName === 'string') return obj.modelName
    if (typeof obj.model === 'string') return obj.model
    if (typeof obj.name === 'string') return obj.name
  }
  return String(model.constructor?.name ?? 'unknown')
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm --filter @tianji/runtime test -- src/__tests__/llm-call-recorder.test.ts`
Expected: 全部 PASS

---

## Task 3: 类型扩展 — `SessionRuntimeDeepagentsConfig` 增加 `llmRawDir`

**Files:**
- Modify: `packages/runtime/src/types.ts`

- [ ] **Step 1: 修改 `SessionRuntimeDeepagentsConfig`**

在 `packages/runtime/src/types.ts` 的 `SessionRuntimeDeepagentsConfig` 接口中添加 `llmRawDir` 字段：

```typescript
// packages/runtime/src/types.ts — SessionRuntimeDeepagentsConfig 接口追加字段
export interface SessionRuntimeDeepagentsConfig {
  readonly model: string | BaseLanguageModel
  readonly providerConfig?: RuntimeProviderConfig
  readonly middleware?: readonly unknown[]
  readonly backend?: unknown
  readonly checkpointer?: unknown
  readonly store?: unknown
  readonly subagents?: readonly { readonly name: string; [key: string]: unknown }[]
  readonly skills?: readonly string[]
  readonly interruptOn?: Record<string, boolean | InterruptOnConfig>
  readonly llmRawDir?: string
}
```

- [ ] **Step 2: 修改 `ExecuteDeepagentsRunOptions`**

在 `packages/runtime/src/engines/deepagents-engine.ts` 的 `ExecuteDeepagentsRunOptions` 接口中添加 `llmRawDir`：

```typescript
// deepagents-engine.ts ExecuteDeepagentsRunOptions 接口追加字段
interface ExecuteDeepagentsRunOptions {
  // ... 现有字段 ...
  readonly llmRawDir?: string
}
```

---

## Task 4: 注入录制中间件到 `executeDeepagentsRun`

**Files:**
- Modify: `packages/runtime/src/engines/deepagents-engine.ts`

- [ ] **Step 1: 添加 import**

在 `deepagents-engine.ts` 文件顶部的 import 区域添加：

```typescript
import { createRecordingMiddleware, LlmCallRecorder } from '../llm-call-recorder.js'
import { LlmRawStore } from '../llm-raw-store.js'
```

- [ ] **Step 2: 在 `executeDeepagentsRun` 中创建 recorder 和 middleware**

在 `executeDeepagentsRun` 函数中，紧接 `const createUntypedDeepAgent = createDeepAgent as unknown as DeepAgentFactory` 之后（约第 403 行），添加：

```typescript
  const llmRecorder = options.llmRawDir !== undefined ? new LlmCallRecorder() : undefined
  const recordingMiddleware = llmRecorder !== undefined
    ? createRecordingMiddleware(llmRecorder)
    : undefined
```

- [ ] **Step 3: 将 recordingMiddleware 追加到 agent 的 middleware 数组**

修改 agent 创建代码（约第 413-424 行），将：

```typescript
    middleware: resolveDeepagentsMiddleware(options.deepagents.middleware),
```

改为：

```typescript
    middleware: buildMiddlewareList(options.deepagents.middleware, recordingMiddleware),
```

- [ ] **Step 4: 添加 `buildMiddlewareList` 辅助函数**

在 `deepagents-engine.ts` 底部辅助函数区域（`resolveDeepagentsMiddleware` 附近）添加：

```typescript
/**
 * 将用户 middleware 与录制 middleware 合并。
 * 录制 middleware 放在末尾，确保录到的是最终发给模型的请求。
 */
function buildMiddlewareList(
  userMiddleware: SessionRuntimeDeepagentsConfig['middleware'],
  recordingMiddleware: unknown
): unknown[] | undefined {
  const user = resolveDeepagentsMiddleware(userMiddleware)
  if (recordingMiddleware === undefined) {
    return user
  }
  if (user !== undefined) {
    return [...user, recordingMiddleware]
  }
  return [recordingMiddleware]
}
```

- [ ] **Step 5: 在事件循环后持久化调用记录**

将 `executeDeepagentsRun` 中事件循环部分：

```typescript
  for await (const event of events) {
    dispatchStreamEvent(loopState, event, options)
  }

  currentText = loopState.currentText
```

改为：

```typescript
  try {
    for await (const event of events) {
      dispatchStreamEvent(loopState, event, options)
    }
  } finally {
    await persistLlmRaw(options, llmRecorder)
  }

  currentText = loopState.currentText
```

注意：
- `persistLlmRaw` 放在 `finally` 中，确保取消/异常时也能落盘。
- `currentText = loopState.currentText` **必须保持在 `finally` 之外、原来的位置**。如果事件循环抛异常，`loopState.currentText` 可能处于不完整状态，后续 fallback 消息构建不应使用半成品数据。异常场景下 `currentText` 保持为空串，由外层错误处理接管。

- [ ] **Step 6: 在 `ExecuteDeepagentsRunOptions` 中添加可选的 `logger` 字段**

在 `ExecuteDeepagentsRunOptions` 接口中添加：

```typescript
  readonly logger?: ObserverLogger
```

并在文件顶部 import 区域添加：

```typescript
import type { ObserverLogger } from '@tianji/observer'
```

- [ ] **Step 7: 添加 `persistLlmRaw` 辅助函数**

在 `deepagents-engine.ts` 底部辅助函数区域添加：

```typescript
/**
 * 将本次 runTurn 的 LLM 调用记录持久化到 raws/ 目录。
 * 只在配置了 llmRawDir 且有调用记录时才写文件。
 * 持久化失败不阻断主流程，只记录 error 日志。
 */
async function persistLlmRaw(
  options: ExecuteDeepagentsRunOptions,
  recorder: LlmCallRecorder | undefined
): Promise<void> {
  if (recorder === undefined) return

  const record = recorder.toRecord(options.runId, options.sessionId)
  if (record.calls.length === 0) return

  const store = new LlmRawStore(options.llmRawDir!)
  try {
    await store.write(record)
  } catch (error) {
    options.logger?.error(
      ['runtime', 'llm-raw'],
      `failed to persist LLM raw record for run ${options.runId}`,
      { error }
    )
  }
}
```

注意：使用 `options.logger?.error()` 而非 `console.error`，与 `runtime.ts` 中的日志风格保持一致（scope 为 `['runtime', 'llm-raw']`，level 为 `error`）。logger 为可选，未传入时静默跳过。
```

---

## Task 5: 在 `runtime.ts` 调用方计算 `llmRawDir` 并传入

**Files:**
- Modify: `packages/runtime/src/runtime.ts`

- [ ] **Step 1: 添加 import**

在 `runtime.ts` 顶部 import 区域添加（检查 `join` 是否已有导入，如已有则只加 `resolveConfigPaths`）：

```typescript
import { join } from 'node:path'
import { resolveConfigPaths } from './config.js'
```

- [ ] **Step 2: 在 `executeDeepagentsTurn` 中传递 `llmRawDir` 和 `logger`**

在 `runtime.ts` 的 `executeDeepagentsTurn` 方法中，`return executeDeepagentsRun({` 调用处（约第 731 行），在参数对象中追加 `llmRawDir` 和 `logger` 字段：

```typescript
    return executeDeepagentsRun({
      sessionId: activeRun.sessionId,
      runId: activeRun.runId,
      // ... 现有字段 ...
      llmRawDir: this.options.deepagents?.llmRawDir ?? join(resolveConfigPaths().userConfigDir, 'runtime-snapshots'),
      logger: this.options.logger,
      emitEvent: (event) => { ... },
    })
```

使用 `resolveConfigPaths().userConfigDir` 代替硬编码 `~/.config/tianji-ai`，确保与 `config.ts` 中路径计算逻辑保持一致（包括 `XDG_CONFIG_HOME` 等环境变量的支持）。

- [ ] **Step 3: 验证类型一致性**

确认：
- `this.options.deepagents` 的类型是 `SessionRuntimeDeepagentsConfig`，新增的 `llmRawDir` 字段已在 Task 3 中添加。
- `this.options.logger` 的类型是 `ObserverLogger | undefined`（已在 `SessionRuntimeOptions` 中定义）。
- `ExecuteDeepagentsRunOptions` 已在 Task 4 Step 6 中添加了 `logger` 字段。

---

## Task 6: 更新测试 helper 传递 `llmRawDir`

**Files:**
- Modify: `packages/runtime/src/__tests__/helpers/runtime-test-utils.ts`

- [ ] **Step 1: 检查现有 helper**

读取 `runtime-test-utils.ts`，找到 `createSessionRuntime` 调用处，确认 deepagents 配置的构造方式。

- [ ] **Step 2: 不修改现有 helper，仅在新增测试中显式传递 `llmRawDir`**

现有测试不改动。原因：
- `runtime.ts` 的 fallback 路径会通过 `resolveConfigPaths()` 计算，现有测试正常通过 `executeDeepagentsRun`，录制文件会写入 `~/.config/tianji-ai/runtime-snapshots/raws/`，体积极小，不影响 CI。
- 修改 helper 默认传临时目录会影响所有现有测试，风险高于收益。

新增的集成测试（Task 2 中的 `LlmCallRecorder + LlmRawStore 集成` 测试）已经自行创建临时目录并在 `afterEach` 中清理，无需 helper 支持。

---

## Task 7: 运行验证

- [ ] **Step 1: 运行 runtime 包测试**

Run: `pnpm --filter @tianji/runtime test`

Expected: 全部现有测试通过 + 新增测试通过

- [ ] **Step 2: 运行 `pnpm check`**

Run: `pnpm check`

Expected: 无类型错误、无 lint 错误

- [ ] **Step 3: 运行冒烟测试**

Run: `SMOKE_E2E=1 pnpm --filter @tianji/node test:smoke`

Expected: 冒烟测试通过

---

## 关键数据流

```
用户请求
  → runtime.ts executeRun()
    → executeDeepagentsTurn()
      → 计�� llmRawDir (用户配置 ?? resolveConfigPaths().userConfigDir + '/runtime-snapshots')
      → executeDeepagentsRun({ llmRawDir, logger, ... })
        → LlmCallRecorder 创建 (llmRawDir !== undefined)
        → createRecordingMiddleware(recorder) 创建
        → buildMiddlewareList(userMiddleware, recordingMiddleware)
        → createDeepAgent({ middleware: [...] })
        → agent.streamEvents(...)
          → 每次 LLM 调用:
            middleware.wrapModelCall 拦截 request → handler(request) → 拦截 response
            → recorder.recordCall(request, response)
        → finally:
          → persistLlmRaw(options, recorder)
            → recorder.toRecord(runId, sessionId)
            → LlmRawStore.write(record)
            → 失败时: options.logger?.error(['runtime', 'llm-raw'], ...)
            → 文件: {llmRawDir}/raws/llm_{runId}.json
        → currentText = loopState.currentText  (在 finally 之后，保持原位)
```

## 输出文件示例

文件路径: `~/.config/tianji-ai/runtime-snapshots/raws/llm_run_abc123.json`

```json
{
  "runId": "run_abc123",
  "sessionId": "sess_xyz",
  "createdAt": 1712544000000,
  "calls": [
    {
      "index": 0,
      "request": {
        "model": "gpt-4",
        "systemPrompt": "You are helpful.",
        "messages": [
          { "role": "user", "content": "Read src/main.ts" }
        ],
        "tools": [
          { "name": "read_file", "description": "Read file content" }
        ]
      },
      "response": {
        "content": "",
        "toolCalls": [
          { "id": "call_1", "name": "read_file", "args": { "path": "src/main.ts" } }
        ],
        "usageMetadata": {
          "inputTokens": 150,
          "outputTokens": 20,
          "totalTokens": 170
        }
      }
    },
    {
      "index": 1,
      "request": {
        "model": "gpt-4",
        "systemPrompt": "You are helpful.",
        "messages": [
          { "role": "user", "content": "Read src/main.ts" },
          { "role": "ai", "content": "", "toolCalls": [...] },
          { "role": "tool", "content": "import { app }...", "toolCallId": "call_1" }
        ],
        "tools": [...]
      },
      "response": {
        "content": "The file has 42 lines.",
        "toolCalls": [],
        "usageMetadata": {
          "inputTokens": 500,
          "outputTokens": 15,
          "totalTokens": 515
        }
      }
    }
  ]
}
```

---

## 与���计划的差异总结

| 主题 | 原计划 | 修正后 |
|------|--------|--------|
| `createMiddleware` / `ModelRequest` 来源 | 假设存在但未验证 | 已从 `langchain` 包实际 `.d.ts` 确认 |
| `serializeMessage` 用 `(msg as any).tool_call_id` | 猜测 + any | 使用 `isToolMessage` 类型守卫 + `ToolMessage.tool_call_id` |
| `readModelName` 返��� `'unknown'` | 静默降级 | 返回 `String(model.constructor?.name)` 或空串，不吞错 |
| 只在成功后写文件 | 放在事件循环后 | 放在 `finally` 中，失败/取消也落盘 |
| 硬编码 `process.env.TIANJI_CONFIG_DIR` | 在 engine 里拼路径 | 通过 `llmRawDir` 参数注入，由 `runtime.ts` 统一计算 |
| `LlmRawStore` / `LlmCallRecorder` 导出为公�� API | 暴露给外部消费者 | 不导出，仅在 runtime 内部使用 |
| `wrapModelCall` 录制位置 | 未讨论 | 放在末尾（录最终请��），与 `resolveDeepagentsMiddleware` 行��一致 |
| 缺少 `createRecordingMiddleware` 测试 | 无 | 新增 middleware 工厂函数测试 |

### Review 后追加的修正

| 主题 | 修正前 | 修正后 |
|------|--------|--------|
| `finally` 中 `currentText` 赋值 | `currentText = loopState.currentText` 被移入 `finally` | `currentText` 赋值保持原位在 `finally` 块之后，仅 `persistLlmRaw` 在 `finally` 中 |
| 错误日志方式 | `console.error(...)` | 通过 `options.logger?.error(['runtime', 'llm-raw'], ...)` 使用项目 `ObserverLogger` |
| fallback 路径计算 | 硬编码 `join(homedir(), '.config', 'tianji-ai', 'runtime-snapshots')` | 使用 `resolveConfigPaths().userConfigDir`，与 `config.ts` 逻辑保持一致 |
| 测试 helper 改动方案 | 三种方案并列未决 | 明确：不修改现有 helper，仅在新增测试中显式传递 `llmRawDir` |
| `SerializedMessage` readonly 冲突 | 先构造对象再 `serialized.toolCallId = ...` 赋值 | 在对象字面量中直接构造所有字段，避免对 `readonly` 属性赋值 |
| `createRecordingMiddleware` 返回类型 | 无显式标注，依赖 TS 推断 | 显式标注返回 `AgentMiddleware`，导入 `type AgentMiddleware from 'langchain'` |
| `ExecuteDeepagentsRunOptions` 缺少 logger | 无 logger 字段 | 新增 `readonly logger?: ObserverLogger` 字段 |
