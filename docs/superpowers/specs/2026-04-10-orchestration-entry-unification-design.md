# 编排入口统一设计

## 1. 背景与目标

当前有两条调用 agent 的入口：

| 入口 | 链路 |
|------|------|
| CLI chat | `chat.ts → DaemonClient → daemon-server.#handleChat → session.query(prompt)` |
| 控制面 | `controlplane → command → TaskExecutor → InProcessAgentRunner.query → session.query(prompt)` |

两条入口最终汇合在 `AgentSession.query`，走单 agent 单 turn 路径，完全不经过已实现的 orchestration 编排层。

本设计的目标：

1. **删除 `session.query`**，所有入口统一走 `session.queryWithGraph`
2. 实现一个**图加载器**：从 `<configDir>/default-orchestration.json` 读 JSON，展开 agent name 为完整配置，返回 `OrchestrationGraph`
3. 实现一个 **systemPrompt 构建器**：拼接 `SOUL.md` + `<workspace>/AGENTS.md`
4. **RuntimeEvent 透传**：orchestration 执行器把节点内部的 `run.*/message.*/tool.*` 事件转发到外层流

## 2. 设计原则

| 原则 | 说明 |
|------|------|
| 入口收束 | 不保留旧的单 agent 路径，减少并存腐烂 |
| graph-schema 不变 | `OrchestrationGraph` / `AgentNode.agent` 结构不改，executor 不改 |
| 加载阶段展开 | JSON 里写 agent name（字符串），加载阶段查配置展开为完整 `AgentNode.agent` 对象 |
| Let it crash | `default-orchestration.json` 不存在直接报错；AGENTS.md 不存在静默跳过 |

## 3. 新增概念

### 3.1 编排图 JSON 文件

路径：`<configDir>/default-orchestration.json`

格式：与 `OrchestrationGraph` 结构相同，唯一区别是 `AgentNode.agent` 字段写 agent name 字符串而非完整对象。

```typescript
/**
 * JSON 文件中的 agent 节点表示。
 * agent 字段为 agent name，加载阶段展开。
 */
interface RawAgentNode {
  readonly id: string
  readonly type: 'agent'
  readonly agent: string          // ← agent name，如 "default"
  readonly input?: readonly string[]
  readonly output?: readonly string[]
}

/**
 * JSON 文件整体结构。
 * 除 AgentNode.agent 类型不同外，其余与 OrchestrationGraph 一致。
 */
interface RawOrchestrationGraph {
  readonly id: string
  readonly name: string
  readonly version: number
  readonly source: OrchestrationGraphSource
  readonly locked: boolean
  readonly state: Record<string, StateChannelDef>
  readonly nodes: readonly RawGraphNode[]   // RawAgentNode | AcpAgentNode | RouterNode | ...
  readonly edges: readonly GraphEdge[]
}
```

**agent 节点只允许引用 native agent。** 若 JSON 中的 agent name 对应的 `TianjiAgentConfig` 经 `resolveAgentType()` 判定为 `external`，加载阶段直接报错。外部 agent 必须通过 `acp-agent` 节点类型接入编排。

| 场景 | 处理 |
|------|------|
| agent 节点引用 native agent | 允许，正常展开 |
| agent 节点引用 external agent | 报错：`Agent node "${nodeId}" references external agent "${agentName}". Use acp-agent node type instead.` |
| acp-agent 节点 | 不经过 graph-loader 展开，直接透传到 executor |

最基础的单 agent 默认图示例：

```json
{
  "id": "default",
  "name": "default-single-agent",
  "version": 1,
  "source": "static",
  "locked": false,
  "state": {
    "input": { "type": "string" },
    "output": { "type": "string" }
  },
  "nodes": [
    {
      "id": "agent",
      "type": "agent",
      "agent": "default",
      "input": ["input"],
      "output": ["output"]
    }
  ],
  "edges": [
    { "from": "__start__", "to": "agent" },
    { "from": "agent", "to": "__end__" }
  ]
}
```

### 3.2 图加载器（graph-loader）

职责：读 JSON → 校验 → 展开 agent name → 返回 `OrchestrationGraph`

位置：`packages/agent/src/orchestration/graph-loader.ts`

```typescript
interface GraphLoaderOptions {
  /** configDir，用于定位 default-orchestration.json 和各 agent 的 SOUL.md */
  readonly configDir: string
  /** tianji.config.json 中 agents.items 的完整配置 */
  readonly agentConfigs: Record<string, TianjiAgentConfig>
}

/**
 * 加载并展开默认编排图。
 *
 * 1. 读 <configDir>/default-orchestration.json（不存在则报错）
 * 2. 遍历节点，type=agent 的节点：
 *    a. 用 agent name 从 agentConfigs 查出 TianjiAgentConfig
 *    b. 校验：resolveAgentType(config) 必须为 'native'，否则报错
 *    c. 校验：config.model 必须存在，否则报错
 *    d. 调 systemPrompt 构建器拼 SOUL.md + AGENTS.md
 *    e. 展开为 AgentNode.agent 对象（当前只填 model + systemPrompt，
 *       tools/subagents/skills 留 undefined，待 TianjiAgentConfig 扩展后补齐）
 * 3. 其他节点类型（acp-agent / router / human-gate / fork）原样透传
 * 4. 返回 OrchestrationGraph
 */
async function loadDefaultOrchestrationGraph(
  options: GraphLoaderOptions
): Promise<OrchestrationGraph>
```

**展开字段映射：**

| `TianjiAgentConfig` 字段 | `AgentNode.agent` 字段 | 当前映射 |
|---------------------------|------------------------|----------|
| `model` (如 `"openai/glm-latest"`) | `model` | 直接赋值 |
| — (无对应字段) | `systemPrompt` | 由 systemPrompt 构建器生成 |
| — | `tools` | `undefined`（TianjiAgentConfig 当前无此字段） |
| — | `subagents` | `undefined`（TianjiAgentConfig 当前无此字段） |
| — | `skills` | `undefined`（TianjiAgentConfig 当前无此字段） |

### 3.3 systemPrompt 构建器

职责：拼接 `SOUL.md` 内容 + `<workspace>/AGENTS.md` 内容（不存在跳过）

位置：`packages/agent/src/orchestration/system-prompt-builder.ts`

```typescript
interface BuildSystemPromptOptions {
  /** SOUL.md 文件路径（由 getAgentSoulPath(configDir, agentName) 生成） */
  readonly soulPath: string
  /** agent 的工作目录。取值链：TianjiAgentConfig.workspace → 若未配置则 process.cwd() */
  readonly workspace: string
}

/**
 * 构建完整的 systemPrompt。
 *
 * 1. 读 SOUL.md（必须存在，由 loadAgentSoul 保证）
 * 2. 尝试读 <workspace>/AGENTS.md，不存在则跳过
 * 3. 返回结构化拼接结果
 */
async function buildSystemPrompt(options: BuildSystemPromptOptions): Promise<string>
```

**workspace 取值链：**

1. 被引用 agent 的 `TianjiAgentConfig.workspace` 字段
2. 若未配置，退回 `process.cwd()`
3. 构建器只负责读 `<workspace>/AGENTS.md`，不负责猜路径或创建目录

**拼接格式：**

```
<agent_soul>
{SOUL.md 内容}
</agent_soul>

<workspace_agents_md>
{AGENTS.md 内容}
</workspace_agents_md>
```

若 AGENTS.md 不存在，则只输出 `<agent_soul>` 块，不输出 `<workspace_agents_md>` 块。

### 3.4 Executor factory 注入链路

当前 `queryWithGraph` 要求调用方传入 `compileOptions.agentExecutorFactory`。这个 factory 需要从 daemon 启动入口一路注入到各消费者。

**factory 在 daemon-entry 创建，向下注入：**

```
daemon-entry.ts
  ├── 创建 agentExecutorFactory = createDeepagentsExecutorFactory({
  │     resolveModel: (modelRef) => modelRef,   // 生产环境直接透传 model 字符串
  │   })
  ├── 创建 defaultGraph = await loadDefaultOrchestrationGraph(...)
  │
  ├──→ DaemonServer({ session, defaultGraph, executorFactory, ... })
  │     └── #handleChat 使用 this.#defaultGraph + this.#executorFactory
  │
  └──→ controlplane-runtime createRunner 时：
        └── new InProcessAgentRunner({ ..., defaultGraph, executorFactory })
              └── query 使用 this.#defaultGraph + this.#executorFactory
```

**各对象构造函数新增参数：**

| 对象 | 新增构造参数 |
|------|-------------|
| `DaemonServer` | `defaultGraph: OrchestrationGraph`、`executorFactory: AgentExecutorFactory` |
| `InProcessAgentRunner` | `defaultGraph: OrchestrationGraph`、`executorFactory: AgentExecutorFactory` |
| `controlplane-runtime.createControlPlaneRuntime` | `defaultGraph: OrchestrationGraph`、`executorFactory: AgentExecutorFactory`（向下传给 InProcessAgentRunner） |

### 3.5 RuntimeEvent 透传

当前 `deepagents-executor.collectFinalAssistantText` 迭代 runtime 事件流时只提取最终文本，不向外转发，导致上层消费者（chat 需要 `message.delta` 打印、TaskExecutor 需要 `run.started/tool.completed` 等）拿不到事件。

改动点：

1. `NodeExecutorContext`（`executor-types.ts`）新增字段：
   ```typescript
   readonly emitRuntimeEvent?: (event: RuntimeEvent) => void
   ```

2. `graph-runner.ts` 在构建 ctx 时注入 `emitRuntimeEvent`，推入与 `emitGraphEvent` 相同的事件队列。事件队列类型从 `GraphEvent[]` 拓宽为 `RuntimeEvent[]`（`RuntimeEvent` union 已包含 `GraphEvent`）。

3. `OrchestrationRunResult.events` 类型从 `AsyncIterable<GraphEvent>` 拓宽为 `AsyncIterable<RuntimeEvent>`。

4. `deepagents-executor.collectFinalAssistantText` 在迭代事件时调用 `ctx.emitRuntimeEvent(event)` 转发每一个事件。

5. `acp-executor` 透传规则：
   - 透传 `runner.query()` 返回的原始 `RuntimeEvent`，不二次包装
   - 不做额外去重（若 runner 自己有去重逻辑如 `InProcessAgentRunner` 的 `completedSeen`，executor 不再额外处理）
   - 调用时机：在 `for await (const event of runner.query(fullPrompt))` 循环体内，每拿到一个 event 就调 `ctx.emitRuntimeEvent?.(event)`

## 4. 入口改动

### 4.1 `AgentSession` 接口变更

```typescript
// 删除
readonly query: (prompt: string, options?: ChatOptions) => AsyncIterable<RuntimeEvent>

// 保留，queryWithGraph 成为唯一入口
readonly queryWithGraph: (
  graph: OrchestrationGraph,
  options: ChatWithGraphOptions
) => AsyncIterable<RuntimeEvent>
```

### 4.2 `daemon-server.ts`

`#handleChat` 改为：

```typescript
// 之前
for await (const event of this.#session.query(parsed.prompt)) { ... }

// 之后
for await (const event of this.#session.queryWithGraph(this.#defaultGraph, {
  initialState: { input: parsed.prompt },
  compileOptions: { agentExecutorFactory: this.#executorFactory },
})) { ... }
```

DaemonServer 构造函数新增字段（从 daemon-entry 注入）：

```typescript
interface DaemonServerOptions {
  // ...existing fields...
  readonly defaultGraph: OrchestrationGraph
  readonly executorFactory: AgentExecutorFactory
}
```

### 4.3 `InProcessAgentRunner`

```typescript
// 之前
for await (const event of session.query(prompt)) { ... }

// 之后
for await (const event of session.queryWithGraph(this.#defaultGraph, {
  initialState: { input: prompt },
  compileOptions: { agentExecutorFactory: this.#executorFactory },
})) { ... }
```

构造函数新增：

```typescript
constructor(config: {
  // ...existing fields...
  defaultGraph: OrchestrationGraph
  executorFactory: AgentExecutorFactory
})
```

### 4.4 `daemon-entry.ts`

在创建 session 之前，先创建 factory 和加载默认编排图：

```typescript
const executorFactory = createDeepagentsExecutorFactory({
  resolveModel: (modelRef) => modelRef,
})

const defaultGraph = await loadDefaultOrchestrationGraph({
  configDir: context.paths.configDir,
  agentConfigs: context.config.agents?.items ?? {},
})
```

将 `defaultGraph` 和 `executorFactory` 传入 DaemonServer 和 controlplane-runtime。

### 4.5 `controlplane-runtime.ts`

`createControlPlaneRuntime` 接收 `defaultGraph` 和 `executorFactory`，在 `createRunner` 回调中透传给 `InProcessAgentRunner`：

```typescript
export interface ControlPlaneRuntimeConfig {
  // ...existing fields...
  readonly defaultGraph: OrchestrationGraph
  readonly executorFactory: AgentExecutorFactory
}
```

## 5. 数据流

```
用户输入 "hello"
    │
    ▼
daemon-server / InProcessAgentRunner
    │  queryWithGraph(defaultGraph, { initialState: { input: "hello" } })
    ▼
graph-runner
    │  emit graph.started
    │  invoke LangGraph CompiledStateGraph
    ▼
LangGraph 调度 "agent" 节点
    │
    ▼
deepagents-executor
    │  读 state.input → 构造 user message
    │  emit graph.node.started
    │  runtime.createSession → runtime.runTurn
    │  迭代 runtime.streamEvents：
    │    每个 event → ctx.emitRuntimeEvent(event)  ← 透传到外层流
    │  提取最终文本 → 写入 state.output
    │  emit graph.node.completed
    ▼
graph-runner
    │  emit graph.completed
    │  closeStream
    ▼
外层消费者收到完整的 RuntimeEvent 流（graph.* + run.* + message.* + tool.* 混合）
    │  chat: 打印 message.delta
    │  TaskExecutor: 日志 + ndjson
```

## 6. 新增文件清单

| 文件 | 职责 |
|------|------|
| `packages/agent/src/orchestration/graph-loader.ts` | 读 JSON + 展开 agent name |
| `packages/agent/src/orchestration/system-prompt-builder.ts` | 拼接 SOUL.md + AGENTS.md |
| `<configDir>/default-orchestration.json` | 默认编排图（由用户提供） |

## 7. 修改文件清单

| 文件 | 改动 |
|------|------|
| `packages/agent/src/orchestration/executors/executor-types.ts` | `NodeExecutorContext` 新增 `emitRuntimeEvent` |
| `packages/agent/src/orchestration/executors/deepagents-executor.ts` | `collectFinalAssistantText` 透传事件 |
| `packages/agent/src/orchestration/executors/acp-executor.ts` | 事件循环体内透传原始 RuntimeEvent，不二次包装不额外去重 |
| `packages/agent/src/orchestration/graph-runner.ts` | 事件队列类型拓宽 `RuntimeEvent`；注入 `emitRuntimeEvent`；更新 tsdoc 注释 |
| `packages/agent/src/orchestration/index.ts` | 导出 graph-loader、system-prompt-builder；更新 `OrchestrationRunResult` 导出类型注释 |
| `packages/agent/src/session.ts` | 删除 `query` 方法和 `ChatOptions` 类型，`AgentSession` 接口只保留 `queryWithGraph` |
| `packages/agent/src/daemon-server.ts` | 构造函数新增 `defaultGraph` + `executorFactory`；`#handleChat` 改用 `queryWithGraph` |
| `apps/node/src/acp/in-process-runner.ts` | 构造函数新增 `defaultGraph` + `executorFactory`；`query` 改用 `queryWithGraph` |
| `apps/node/src/daemon-entry.ts` | 创建 executorFactory + 加载 defaultGraph，传入 DaemonServer 和 controlplane-runtime |
| `apps/node/src/node-runtime/controlplane-runtime.ts` | config 新增 `defaultGraph` + `executorFactory`，透传给 InProcessAgentRunner |
| `packages/agent/src/__tests__/session.test.ts` | 删除 `session.query` 测试，全部改写为 `queryWithGraph` |
| `packages/agent/src/orchestration/__tests__/graph-runner.e2e.test.ts` | 事件收集类型从 `GraphEvent[]` 改为 `RuntimeEvent[]`；断言适配混合事件流 |
| `packages/agent/src/orchestration/__tests__/deepagents-executor.test.ts` | 补充 RuntimeEvent 透传断言 |

## 8. 不改动的文件

| 文件 | 原因 |
|------|------|
| `packages/agent/src/orchestration/graph-schema.ts` | `OrchestrationGraph` / `AgentNode` 结构不变 |
| `packages/agent/src/orchestration/graph-compiler.ts` | 拿到的已经是展开后的 graph |
| `packages/agent/src/orchestration/graph-validator.ts` | 不变 |
| `packages/agent/src/orchestration/state-channels.ts` | 不变 |
| `packages/agent/src/orchestration/io-mapping.ts` | 不变 |
| `apps/node/src/acp/agent-runner.ts` | ACP 子进程走 ACP 协议，不经过 session.query，不受本次改动影响 |

## 9. 测试覆盖要求

| 测试点 | 位置 | 必须性 |
|--------|------|--------|
| graph-loader 读不存在文件时报错 | `graph-loader.test.ts` | 必须 |
| graph-loader 引用不存在 agent name 报错 | `graph-loader.test.ts` | 必须 |
| graph-loader 引用 external agent 报错 | `graph-loader.test.ts` | 必须 |
| graph-loader 正常展开 native agent | `graph-loader.test.ts` | 必须 |
| systemPrompt builder 在 AGENTS.md 不存在时只返回 soul 块 | `system-prompt-builder.test.ts` | 必须 |
| systemPrompt builder 在 AGENTS.md 存在时正确拼接两个块 | `system-prompt-builder.test.ts` | 必须 |
| deepagents-executor 透传 message/tool/run 事件 | `deepagents-executor.test.ts` | 必须 |
| acp-executor 透传事件 | `acp-executor.test.ts`（新增或扩展） | 必须 |
| graph-runner e2e 事件流包含 RuntimeEvent | `graph-runner.e2e.test.ts` | 必须 |
| daemon chat 经过 defaultGraph 能拿到 message.delta | `daemon-server.test.ts` 或 `daemon-e2e.test.ts` | 必须 |
| in-process runner 经过 defaultGraph 能拿到完整事件流 | `in-process-runner.test.ts` | 必须 |
