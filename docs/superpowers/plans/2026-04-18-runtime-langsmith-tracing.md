# Runtime LangSmith Tracing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `@tianji/runtime` 增加基于文件配置的 LangSmith tracing，并在运行时显式注入 `LangChainTracer`，不依赖环境变量。

**Architecture:** 配置层在 `@tianji/shared` 的 `runtime` schema 中新增 `tracing.langsmith` 配置块，由 `loadResolvedConfig` 统一加载、校验和占位符解析。运行时层在 `createSessionRuntime` 归一化配置后创建 LangSmith client/tracer，并在每次 deepagents 执行时显式通过 LangChain `callbacks`/`RunnableConfig` 注入，同时继续保留现有 `LlmCallRecorder` 作为本地 raw 记录能力。

**Tech Stack:** TypeScript, Zod, LangChain, LangSmith SDK, deepagents, Vitest, pnpm workspaces

---

## File Structure

- Modify: `packages/shared/src/config.ts`
  责任：扩展共享配置 schema，新增 `runtime.tracing.langsmith` 类型、默认值与导出类型。
- Modify: `packages/runtime/src/runtime/types.ts`
  责任：在 `SessionRuntimeOptions` 中加入显式 tracing 配置类型。
- Modify: `packages/runtime/src/types.ts`
  责任：补 runtime 内部会传给 deepagents 的 tracing 配置类型。
- Create: `packages/runtime/src/langsmith.ts`
  责任：封装 LangSmith client、tracer 创建和 run config 拼装，避免逻辑散落在 session-runtime / engine。
- Modify: `packages/runtime/src/runtime/session-runtime.ts`
  责任：初始化并归一化 tracing 配置，把它挂进每次 run 的执行参数。
- Modify: `packages/runtime/src/engines/deepagents/types.ts`
  责任：扩展 `ExecuteDeepagentsRunOptions`，容纳 tracing tracer 与 metadata/tags。
- Modify: `packages/runtime/src/engines/deepagents-engine.ts`
  责任：在 `agent.streamEvents` 调用处显式注入 LangChain callbacks 与 run config。
- Modify: `packages/runtime/src/__tests__/config-loader.test.ts`
  责任：校验 `runtime.tracing.langsmith` 的文件配置合并、占位符解析和缺字段报错。
- Create: `packages/runtime/src/__tests__/langsmith.test.ts`
  责任：校验 runtime 会创建 LangChainTracer，并向 deepagents 调用透传 tags / metadata / runName。
- Modify: `packages/runtime/src/__tests__/runtime-public-api.test.ts`
  责任：更新公开 API 类型断言，确保 `SessionRuntimeOptions` 暴露 tracing 配置。
- Modify: `packages/runtime/README.md`
  责任：补 runtime 文件配置与 API 用法说明。

### Task 1: 扩展共享配置 schema

**Files:**
- Modify: `packages/shared/src/config.ts`
- Test: `packages/runtime/src/__tests__/config-loader.test.ts`

- [ ] **Step 1: 先写配置加载测试，定义 LangSmith 配置的合并和占位符行为**

```ts
it('merges runtime.langsmith tracing config from user/workspace layers', async () => {
  process.env.LANGSMITH_API_KEY = 'ls-key'

  await writeJson(userConfigPath, {
    runtime: {
      tracing: {
        langsmith: {
          enabled: true,
          project: 'user-project',
          apiKey: '${env:LANGSMITH_API_KEY}',
          tags: ['user'],
        },
      },
    },
  })

  await writeJson(workspaceConfigPath, {
    runtime: {
      tracing: {
        langsmith: {
          project: 'workspace-project',
          metadata: { source: 'workspace' },
        },
      },
    },
  })

  const result = await loadResolvedConfig({ workspaceRoot, userHomeDir: homeDir })

  expect(result.config.runtime?.tracing?.langsmith).toEqual({
    enabled: true,
    project: 'workspace-project',
    apiKey: 'ls-key',
    tags: ['user'],
    metadata: { source: 'workspace' },
  })
})
```

- [ ] **Step 2: 再写缺字段失败测试，要求 `enabled: true` 时必须有 `project` 和 `apiKey`**

```ts
it('fails when langsmith tracing is enabled without required fields', async () => {
  await writeJson(userConfigPath, {
    runtime: {
      tracing: {
        langsmith: {
          enabled: true,
        },
      },
    },
  })

  await expect(loadResolvedConfig({ workspaceRoot, userHomeDir: homeDir })).rejects.toMatchObject({
    code: 'config.schema_error',
    details: {
      layer: 'user',
      phase: 'schema',
    },
  })
})
```

- [ ] **Step 3: 在 `packages/shared/src/config.ts` 中新增 schema 和类型**

```ts
export const LangsmithTracingConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    project: z.string().min(1).optional(),
    apiKey: z.string().min(1).optional(),
    apiUrl: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.enabled !== true) return
    if (value.project === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'runtime.tracing.langsmith.project is required when LangSmith tracing is enabled' })
    }
    if (value.apiKey === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'runtime.tracing.langsmith.apiKey is required when LangSmith tracing is enabled' })
    }
  })

export const RuntimeTracingConfigSchema = z.object({
  langsmith: LangsmithTracingConfigSchema.optional(),
})

export const RuntimeConfigSchema = z.object({
  retry: RetryConfigSchema.optional(),
  tool: ToolConfigSchema.optional(),
  tracing: RuntimeTracingConfigSchema.optional(),
})
```

- [ ] **Step 4: 运行配置测试，确认 schema 行为符合预期**

Run: `pnpm --filter @tianji/runtime test -- config-loader.test.ts`
Expected: PASS，新增 LangSmith 配置测试通过，旧配置测试不回退。

### Task 2: 在 runtime 内新增 LangSmith tracer 封装

**Files:**
- Create: `packages/runtime/src/langsmith.ts`
- Modify: `packages/runtime/src/runtime/types.ts`
- Modify: `packages/runtime/src/types.ts`
- Test: `packages/runtime/src/__tests__/langsmith.test.ts`
- Test: `packages/runtime/src/__tests__/runtime-public-api.test.ts`

- [ ] **Step 1: 先写 runtime 单测，定义 tracer 创建与注入行为**

```ts
it('creates a LangChainTracer from explicit runtime config', () => {
  const runtime = createSessionRuntime({
    deepagents: { model: fakeModel().respond(new AIMessage('ok')) },
    tracing: {
      langsmith: {
        enabled: true,
        project: 'tianji-test',
        apiKey: 'ls-key',
        apiUrl: 'https://api.smith.langchain.com',
        tags: ['runtime'],
        metadata: { service: 'tianji' },
      },
    },
  })

  expect(runtime).toBeDefined()
  expect(createClientSpy).toHaveBeenCalledWith({
    apiKey: 'ls-key',
    apiUrl: 'https://api.smith.langchain.com',
  })
  expect(createTracerSpy).toHaveBeenCalled()
})
```

- [ ] **Step 2: 在 `packages/runtime/src/types.ts` 和 `packages/runtime/src/runtime/types.ts` 中增加 tracing 类型**

```ts
export interface RuntimeLangsmithTracingConfig {
  readonly enabled: boolean
  readonly project: string
  readonly apiKey: string
  readonly apiUrl?: string
  readonly tags?: readonly string[]
  readonly metadata?: Record<string, unknown>
}

export interface SessionRuntimeTracingConfig {
  readonly langsmith?: RuntimeLangsmithTracingConfig
}

export interface SessionRuntimeOptions {
  readonly engine?: Extract<SessionRuntimeEngine, 'deepagents'>
  readonly deepagents?: SessionRuntimeDeepagentsConfig
  readonly tracing?: SessionRuntimeTracingConfig
  readonly logger?: ObserverLogger
  readonly snapshotStore?: SnapshotStore
  readonly toolCatalog?: ToolCatalog | ToolRegistry | readonly RuntimeToolDefinition[]
}
```

- [ ] **Step 3: 新建 `packages/runtime/src/langsmith.ts`，集中封装 client/tracer/run-config**

```ts
export function createLangsmithTracing(config?: SessionRuntimeTracingConfig): RuntimeTracingState {
  const langsmith = config?.langsmith
  if (langsmith?.enabled !== true) return {}

  const client = new Client({
    apiKey: langsmith.apiKey,
    apiUrl: langsmith.apiUrl,
  })

  return {
    langsmith: {
      tracer: new LangChainTracer({
        client,
        projectName: langsmith.project,
      }),
      tags: [...(langsmith.tags ?? [])],
      metadata: langsmith.metadata === undefined ? undefined : { ...langsmith.metadata },
      project: langsmith.project,
    },
  }
}
```

- [ ] **Step 4: 更新公开 API 类型测试**

Run: `pnpm --filter @tianji/runtime test -- runtime-public-api.test.ts langsmith.test.ts`
Expected: PASS，公开类型断言包含 `tracing`，LangSmith tracer 封装测试通过。

### Task 3: 把 tracer 显式注入到 deepagents 执行链路

**Files:**
- Modify: `packages/runtime/src/runtime/session-runtime.ts`
- Modify: `packages/runtime/src/engines/deepagents/types.ts`
- Modify: `packages/runtime/src/engines/deepagents-engine.ts`
- Test: `packages/runtime/src/__tests__/langsmith.test.ts`

- [ ] **Step 1: 先写 failing test，要求 run 时把 callbacks / tags / metadata 显式传给 deepagents**

```ts
it('passes LangChain callbacks and RunnableConfig to deepagents streamEvents', async () => {
  const agent = { streamEvents: vi.fn().mockResolvedValue(emptyAsyncIterable()) }
  vi.mocked(createDeepAgent).mockReturnValue(agent as never)

  const runtime = createSessionRuntime({
    deepagents: { model: fakeModel().respond(new AIMessage('done')) },
    tracing: {
      langsmith: {
        enabled: true,
        project: 'runtime-project',
        apiKey: 'ls-key',
        tags: ['tianji'],
        metadata: { environment: 'test' },
      },
    },
  })

  const session = await runtime.createSession()
  await runtime.runTurn({
    sessionId: session.sessionId,
    message: createUserMessage('msg-1', 'hello'),
  })

  expect(agent.streamEvents).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      callbacks: [expect.any(LangChainTracer)],
      tags: ['tianji', 'trigger:new'],
      metadata: expect.objectContaining({ environment: 'test' }),
    }),
  )
})
```

- [ ] **Step 2: 在 `session-runtime.ts` 归一化 tracing 配置并生成每次 run 的基础 metadata**

```ts
const tracing = createLangsmithTracing(options.tracing)

return executeDeepagentsRun({
  ...baseOptions,
  tracing,
  tracingContext: {
    tags: ['tianji', `trigger:${input.triggerType}`],
    metadata: {
      sessionId: input.sessionSnapshot.sessionId,
      runId: input.runId,
      triggerType: input.triggerType,
      parentRunId: input.parentRunId,
      model: typeof deepagents.model === 'string' ? deepagents.model : deepagents.model.constructor?.name,
    },
  },
})
```

- [ ] **Step 3: 在 `deepagents-engine.ts` 中把 LangSmith tracer 通过 `agent.streamEvents(..., config)` 显式传入**

```ts
const runConfig = buildLangchainRunConfig({
  threadId,
  checkpointId: options.checkpointId,
  tracing: options.tracing,
  tracingContext: options.tracingContext,
  signal: options.signal,
})

const events = await agent.streamEvents(readDeepagentsInput(options), runConfig)
```

- [ ] **Step 4: 运行与 tracing 相关的单测，确认没有破坏现有 deepagents 流程**

Run: `pnpm --filter @tianji/runtime test -- langsmith.test.ts runtime-deepagents-bootstrap.test.ts`
Expected: PASS，LangSmith 注入测试通过，现有 deepagents bootstrap 测试不回退。

### Task 4: 文档与回归验证

**Files:**
- Modify: `packages/runtime/README.md`
- Modify: `docs/development/03 - RUNTIME_DESIGN.md`

- [ ] **Step 1: 更新 README，用最小示例说明文件配置和 API 注入边界**

```json
{
  "runtime": {
    "tracing": {
      "langsmith": {
        "enabled": true,
        "project": "tianji-dev",
        "apiKey": "${env:LANGSMITH_API_KEY}",
        "apiUrl": "https://api.smith.langchain.com",
        "tags": ["tianji", "runtime"],
        "metadata": {
          "service": "tianji-node"
        }
      }
    }
  }
}
```

- [ ] **Step 2: 更新设计文档，明确 observer 与 LangSmith 的边界**

```md
- `observer` 继续负责通用日志与 OTel span。
- `runtime.tracing.langsmith` 仅在 runtime 执行层创建 `LangChainTracer`。
- LangSmith 依赖 LangChain callbacks / RunnableConfig 语义，因此不下沉到 observer。
```

- [ ] **Step 3: 运行包级测试与仓库检查**

Run: `pnpm --filter @tianji/runtime test`
Expected: PASS

Run: `pnpm check`
Expected: PASS，无 error / warning / info 残留。

- [ ] **Step 4: 复查文档、类型和测试命名，确认没有占位项**

Expected review:
- 所有新增字段名在 schema / types / README / tests 中一致使用 `runtime.tracing.langsmith`
- 没有环境变量自动启用逻辑
- 没有把 LangSmith 逻辑塞进 `@tianji/observer`
