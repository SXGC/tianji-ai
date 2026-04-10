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
  /** configDir，用于定位 default-orchestration.json */
  readonly configDir: string
  /** tianji.config.json 中 agents.items 的完整配置 */
  readonly agentConfigs: Record<string, TianjiAgentConfig>
  /** configDir，用于定位各 agent 的 SOUL.md */
  readonly soulDir: string
}

/**
 * 加载并展开默认编排图。
 *
 * 1. 读 <configDir>/default-orchestration.json（不存在则报错）
 * 2. 遍历节点，type=agent 的节点：
 *    a. 用 agent name 从 agentConfigs 查出 model
 *    b. 调 systemPrompt 构建器拼 SOUL.md + AGENTS.md
 *    c. 展开为 { model, systemPrompt } 完整对象
 * 3. 返回 OrchestrationGraph
 */
async function loadDefaultOrchestrationGraph(
  options: GraphLoaderOptions
): Promise<OrchestrationGraph>
```

### 3.3 systemPrompt 构建器

职责：拼接 `SOUL.md` 内容 + `<workspace>/AGENTS.md` 内容（不存在跳过）

位置：`packages/agent/src/orchestration/system-prompt-builder.ts`

```typescript
interface BuildSystemPromptOptions {
  /** SOUL.md 文件路径 */
  readonly soulPath: string
  /** agent 的工作目录（agent.workspace 或 process.cwd()） */
  readonly workspace: string
}

/**
 * 构建完整的 systemPrompt。
 *
 * 1. 读 SOUL.md（必须存在，由 loadAgentSoul 保证）
 * 2. 尝试读 <workspace>/AGENTS.md，不存在则跳过
 * 3. 返回 soulContent + "\n" + agentsContent（或仅 soulContent）
 */
async function buildSystemPrompt(options: BuildSystemPromptOptions): Promise<string>
```

### 3.4 RuntimeEvent 透传

当前 `deepagents-executor.collectFinalAssistantText` 迭代 runtime 事件流时只提取最终文本，不向外转发，导致上层消费者（chat 需要 `message.delta` 打印、TaskExecutor 需要 `run.started/tool.completed` 等）拿不到事件。

改动点：

1. `NodeExecutorContext`（`executor-types.ts`）新增字段：
   ```typescript
   readonly emitRuntimeEvent?: (event: RuntimeEvent) => void
   ```

2. `graph-runner.ts` 在构建 ctx 时注入 `emitRuntimeEvent`，推入与 `emitGraphEvent` 相同的事件队列（`RuntimeEvent` union 已包含 `GraphEvent`）。

3. `OrchestrationRunResult.events` 类型从 `AsyncIterable<GraphEvent>` 拓宽为 `AsyncIterable<RuntimeEvent>`。

4. `deepagents-executor.collectFinalAssistantText` 在迭代事件时调用 `ctx.emitRuntimeEvent(event)` 转发每一个事件。

5. `acp-executor` 同理转发。

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
// daemon 启动时已加载好 defaultGraph
for await (const event of this.#session.queryWithGraph(this.#defaultGraph, {
  initialState: { input: parsed.prompt },
  compileOptions: { agentExecutorFactory: this.#executorFactory },
})) { ... }
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

### 4.4 `daemon-entry.ts`

在创建 session 之前，先加载默认编排图：

```typescript
const defaultGraph = await loadDefaultOrchestrationGraph({
  configDir: context.paths.configDir,
  agentConfigs: context.config.agents?.items ?? {},
  soulDir: context.paths.configDir,
})
```

将 `defaultGraph` 传入 DaemonServer 和 InProcessAgentRunner。

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
外层消费者收到完整的 RuntimeEvent 流
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
| `packages/agent/src/orchestration/executors/acp-executor.ts` | 同上 |
| `packages/agent/src/orchestration/graph-runner.ts` | 事件队列类型拓宽 `RuntimeEvent`；注入 `emitRuntimeEvent` |
| `packages/agent/src/orchestration/index.ts` | 导出新模块 |
| `packages/agent/src/session.ts` | 删除 `query` 方法，`AgentSession` 接口只保留 `queryWithGraph` |
| `packages/agent/src/daemon-server.ts` | `#handleChat` 改用 `queryWithGraph` |
| `apps/node/src/acp/in-process-runner.ts` | `query` 改用 `queryWithGraph` |
| `apps/node/src/daemon-entry.ts` | 启动时加载默认图，传入 DaemonServer |
| `packages/agent/src/__tests__/session.test.ts` | 删除 `session.query` 测试，改写为 `queryWithGraph` |

## 8. 不改动的文件

| 文件 | 原因 |
|------|------|
| `packages/agent/src/orchestration/graph-schema.ts` | `OrchestrationGraph` / `AgentNode` 结构不变 |
| `packages/agent/src/orchestration/graph-compiler.ts` | 拿到的已经是展开后的 graph |
| `packages/agent/src/orchestration/graph-validator.ts` | 不变 |
| `packages/agent/src/orchestration/state-channels.ts` | 不变 |
| `packages/agent/src/orchestration/io-mapping.ts` | 不变 |
