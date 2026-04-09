# 多智能体编排架构设计

## 1. 背景与目标

当前 `tianji-ai` 的 agent 执行模型是"单 agent 单 session"。`SessionRuntime` 一次只跑一个 deepagents 实例，所有多 agent 协作要么依赖 deepagents 内置的 subagent 机制（LLM 自主委派，不可控），要么靠控制面级别的独立任务派发（无协调）。

我们要做的是 **Runtime 内部的多智能体编排**：

- 一个任务可以由多个 agent 按图状的拓扑协作完成
- 编排图可以由人类指定，也可以由 LLM 生成
- 编排图可以可视化、可序列化、可持久化
- 编排引擎要兼容未来的扩展模式（蜂群、动态路由等）
- 第三方 agent（例如通过 ACP 协议接入的 Claude Code）也能作为图节点

## 2. 设计原则

| 原则 | 说明 |
|------|------|
| 复用 LangGraph | 不自己造图引擎，直接用 LangGraph 的 StateGraph 作为执行底座 |
| JSON 可持久化 | 编排图用 JSON 表示，运行时编译为 LangGraph CompiledStateGraph |
| 节点执行器统一接口 | deepagents、ACP agent 都是图中的节点类型，对编排层等价 |
| 控制流交给 LangGraph | router、human-gate、fork/join 用 LangGraph 原生原语，不自定义 |
| 不侵入 deepagents | deepagents 当作黑盒节点执行器，内部 subagent 机制保留 |
| Let it crash | 节点执行失败直接抛错，不做兜底降级 |

## 3. 整体架构

### 3.1 分层与依赖

```
┌─ packages/agent ─────────────────────────────────────────┐
│                                                            │
│  orchestration/        ← 新增编排层                        │
│    ├── graph-schema.ts                                    │
│    ├── graph-compiler.ts                                  │
│    ├── graph-serializer.ts                                │
│    ├── node-executors/                                    │
│    │   ├── deepagents-executor.ts                         │
│    │   └── acp-executor.ts                                │
│    ├── state-channels.ts                                  │
│    └── graph-events.ts                                    │
│                                                            │
│  context/  session/  acp/   ← 现有模块                     │
└────────────────────────────────────────────────────────────┘
        │                 │
        ▼                 ▼
┌─ @langchain/langgraph ─┐  ┌─ @tianji/runtime ─┐
│  StateGraph             │  │  SessionRuntime    │
│  Annotation             │  │  DeepagentsEngine  │
│  interrupt / Send       │  │  ToolCatalog       │
└─────────────────────────┘  └────────────────────┘
```

### 3.2 不改动的部分

| 模块 | 原因 |
|------|------|
| `packages/runtime` | `SessionRuntime` 完全复用，作为 deepagents 节点的执行引擎 |
| `packages/agent/acp` | ACP 桥接复用，作为 acp-agent 节点的执行引擎 |
| `packages/agent/context` | agent 上下文加载逻辑不变 |

### 3.3 改动的部分

| 模块 | 改动 |
|------|------|
| `packages/shared` | 新增 `graph.*` 事件类型到 `RuntimeEvent` 联合类型 |
| `packages/agent/session` | `AgentSession.query()` 增加可选 `graphId` 参数 |

### 3.4 向后兼容

无 graphId 时走原有单 agent 路径。编排能力是纯增量。

## 4. 编排图 JSON Schema

### 4.1 顶层结构

```typescript
interface OrchestrationGraph {
  id: string
  name: string
  version: number
  source: 'static' | 'llm' | 'human'
  locked: boolean                        // human 创建 → true，LLM 不可改
  state: Record<string, StateChannelDef>
  nodes: GraphNode[]
  edges: GraphEdge[]
}
```

### 4.2 State Channel 定义

```typescript
interface StateChannelDef {
  type: 'string' | 'number' | 'boolean' | 'list' | 'object'
  default?: unknown
  reducer?: 'append' | 'replace' | 'merge'  // 缺省 replace
}
```

| reducer | 编译为 LangGraph 的 |
|---------|---------------------|
| `replace` 或缺省 | `Annotation<T>()` (LastValue) |
| `append` | `Annotation<T[]>({ reducer: (a, b) => [...a, ...b], default: () => [] })` |
| `merge` | `Annotation<Record>({ reducer: (a, b) => ({...a, ...b}), default: () => ({}) })` |

只支持 3 种 reducer 是为了避免序列化任意函数。

### 4.3 节点类型

```typescript
type GraphNode = AgentNode | AcpAgentNode | RouterNode | HumanGateNode | ForkNode

interface AgentNode {
  id: string
  type: 'agent'
  agent: {
    model: string
    systemPrompt: string
    tools?: string[]                      // 引用 ToolCatalog 中的工具名
    subagents?: SubAgentDef[]             // 复用 deepagents 库的 SubAgent 接口（name/description/systemPrompt/tools/model 等）
    skills?: string[]
  }
  input?: string[]                        // 读取哪些 state channel
  output?: string[]                       // 写回哪些 state channel
}

interface AcpAgentNode {
  id: string
  type: 'acp-agent'
  acp: {
    command?: string                      // 本地启动命令
    args?: string[]
    endpoint?: string                     // 远程 ACP 端点
    auth?: { type: 'bearer'; tokenEnv: string }
    timeout?: number
  }
  input?: string[]
  output?: string[]
}

interface RouterNode {
  id: string
  type: 'router'
  condition: {
    field: string                         // state 中的字段名
    branches: Record<string, string>      // 字段值 → 目标节点 id 或 "__end__"
  }
}

interface HumanGateNode {
  id: string
  type: 'human-gate'
  prompt: string
}

interface ForkNode {
  id: string
  type: 'fork'
  targets: string[]                       // 并行目标节点 id 列表
  join: string                            // 汇合节点 id
}

interface GraphEdge {
  from: string                            // 源节点 id 或 "__start__"
  to: string                              // 目标节点 id 或 "__end__"
}
```

### 4.4 完整示例

```json
{
  "id": "code-review-pipeline",
  "name": "代码审查流水线",
  "version": 1,
  "source": "human",
  "locked": true,

  "state": {
    "messages": { "type": "list", "reducer": "append" },
    "plan": { "type": "string" },
    "code": { "type": "string" },
    "review": { "type": "string" },
    "approved": { "type": "boolean", "default": false }
  },

  "nodes": [
    {
      "id": "planner",
      "type": "agent",
      "agent": {
        "model": "anthropic/claude-sonnet",
        "systemPrompt": "分析需求，输出实现计划",
        "tools": ["read_file", "search"]
      },
      "output": ["plan"]
    },
    {
      "id": "coder",
      "type": "acp-agent",
      "acp": { "command": "claude", "args": ["--agent"] },
      "input": ["plan"],
      "output": ["code"]
    },
    {
      "id": "reviewer",
      "type": "agent",
      "agent": {
        "model": "anthropic/claude-sonnet",
        "systemPrompt": "审查代码质量，输出 review 和 approved"
      },
      "input": ["code"],
      "output": ["review", "approved"]
    },
    {
      "id": "review_check",
      "type": "router",
      "condition": {
        "field": "approved",
        "branches": { "true": "__end__", "false": "coder" }
      }
    }
  ],

  "edges": [
    { "from": "__start__", "to": "planner" },
    { "from": "planner", "to": "coder" },
    { "from": "coder", "to": "reviewer" },
    { "from": "reviewer", "to": "review_check" }
  ]
}
```

## 5. 图编译器

### 5.1 编译流程

```
OrchestrationGraph JSON
  │
  ├── Step 1: validateOrchestrationGraph()
  ├── Step 2: compileState()        → Annotation.Root
  ├── Step 3: compileNodes()        → graph.addNode() (仅 agent/acp-agent/human-gate)
  ├── Step 4: compileEdges()        → graph.addEdge() / addConditionalEdges() / Send
  └── Step 5: graph.compile()       → CompiledStateGraph
```

### 5.2 节点编译规则

| 节点 type | 编译为 |
|-----------|--------|
| `agent` | `graph.addNode(id, deepagentsExecutor(node))` |
| `acp-agent` | `graph.addNode(id, acpExecutor(node))` |
| `human-gate` | `graph.addNode(id, async (state) => { interrupt(prompt); return state })` |
| `router` | 不生成节点，编译为条件边 |
| `fork` | 不生成节点，编译为 Send 调用 |

### 5.3 边编译规则

```
普通边:
  { from: "A", to: "B" }
  → graph.addEdge("A", "B")

指向 router 节点的边:
  { from: "reviewer", to: "review_check" }       // review_check 是 router
  → graph.addConditionalEdges(
      "reviewer",
      (state) => String(state[router.condition.field]),
      router.condition.branches
    )

指向 fork 节点的边:
  { from: "A", to: "parallel_fork" }              // parallel_fork 是 fork
  → graph.addConditionalEdges(
      "A",
      (state) => fork.targets.map(t => new Send(t, state))
    )
  fork.targets 的各节点 → graph.addEdge(target, fork.join)
```

### 5.4 编译选项

```typescript
interface CompileOptions {
  checkpointer?: BaseCheckpointSaver
  store?: BaseStore
  toolCatalog?: ToolCatalog
}

function compileOrchestrationGraph(
  graph: OrchestrationGraph,
  options: CompileOptions
): CompiledStateGraph

function validateOrchestrationGraph(
  graph: OrchestrationGraph
): ValidationResult
```

### 5.5 校验规则

| 规则 | 说明 |
|------|------|
| 必须有且仅有一个 `__start__` 入边 | 图必须有入口 |
| 所有非控制流节点必须可达 | 无孤立节点 |
| router 的 branches 目标都存在 | 不指向不存在的节点 |
| fork 的 targets 和 join 都存在 | fork/join 配对完整 |
| `locked` 图编辑请求必须经过人类授权 | LLM 不可改 locked 图 |
| 节点 id 不能是 `__start__`/`__end__` | 保留字检查 |

## 6. 节点执行器

### 6.1 统一接口

```typescript
interface NodeExecutor<TNode extends GraphNode> {
  (node: TNode, ctx: ExecutorContext): NodeAction
}

interface ExecutorContext {
  toolCatalog: ToolCatalog
  observer: ObserverLogger
  emitGraphEvent: (event: GraphEvent) => void
  abortSignal: AbortSignal
}

type NodeAction = (
  state: Record<string, unknown>,
  config: LangGraphRunnableConfig
) => Promise<Record<string, unknown>>
```

### 6.2 deepagents-executor

复用现有的 `SessionRuntime` 和 `executeDeepagentsRun()`。

```
执行流程:
  1. emit graph.node.started { nodeId, type: "agent" }
  2. 从 state 读取 node.input 字段，构造 user message
  3. sessionRuntime.runTurn() 启动 deepagents run
  4. 消费 streamEvents()，把内部 RuntimeEvent 透传到外层
  5. 等 run 完成，从 turnMessages 提取最终结果
  6. 按 node.output 把结果写回 state
  7. emit graph.node.completed { nodeId, output }
  8. return { [output_field]: result }
```

| 决策 | 原因 |
|------|------|
| 每个节点独立 SessionRuntime 实例 | thread_id 隔离，checkpoint 互不干扰 |
| 复用现有 SessionRuntime 逻辑 | 不重写 deepagents 集成代码 |
| 节点内部 deepagents subagent 仍可用 | LLM 自主委派的能力保留 |
| 节点之间通过 LangGraph state 通信 | 不依赖 deepagents 内部状态共享 |

### 6.3 acp-executor

复用现有的 `AgentRunner` (External ACP)。

```
执行流程:
  1. emit graph.node.started { nodeId, type: "acp-agent" }
  2. 从 state 读取 node.input，构造 prompt 字符串
  3. new AgentRunner(node.acp) → runner.connect()
  4. for await (event of runner.query(prompt)):
       透传到外层 RuntimeEvent 流
       累积 assistant message 文本
  5. runner.disconnect()
  6. emit graph.node.completed { nodeId, output }
  7. return { [output_field]: accumulated_text }
```

| 决策 | 原因 |
|------|------|
| 每次执行启动新的 AgentRunner | ACP 子进程生命周期对应单次节点执行 |
| 输入只能是字符串 prompt | ACP 协议本身就是 prompt 模型 |
| 输出只能是字符串结果 | ACP 返回累积的 assistant message |
| ACP 节点是黑盒 | 内部工具调用对编排层不透明 |

### 6.4 输入/输出映射

**input 单字段**

```typescript
input: ["plan"]
  → userMessage = String(state.plan)
```

**input 多字段**

```typescript
input: ["plan", "requirements"]
  → userMessage = `## plan\n${state.plan}\n\n## requirements\n${state.requirements}`
```

**output 单字段**

```typescript
output: ["code"]
  → return { code: agentResult }
```

**output 多字段**

```typescript
output: ["code", "tests"]
  → systemPrompt 末尾追加: "Return JSON: { code: string, tests: string }"
  → 解析 agent 输出为 JSON，分别写回
```

### 6.5 错误处理

按 Let it crash 原则，executor 不做兜底：

| 情况 | 行为 |
|------|------|
| input 字段不存在于 state | 抛错，停止整个图 |
| ACP 子进程启动失败 | 抛错 |
| agent 输出 JSON 无法解析（多 output 字段时） | 抛错 |
| 节点执行超时（agent 节点用 SessionRuntime 默认超时；ACP 节点用 `acp.timeout`） | 抛错 |
| LangGraph 接收到错误 | 整个 run 进入 failed，发射 `run.failed` |

## 7. 事件模型

### 7.1 新增 RuntimeEvent 类型

本设计范围内只定义首批必要的事件类型（图启动、节点状态变化、图完成）。`graph.mutated` 等运行时图修改相关事件留给 11.3 节的后续扩展。

```typescript
type GraphEvent =
  | GraphStartedEvent
  | GraphNodeStartedEvent
  | GraphNodeCompletedEvent
  | GraphNodeFailedEvent
  | GraphCompletedEvent

interface GraphNodeStartedEvent {
  type: 'graph.node.started'
  runId: RunId
  graphId: string
  nodeId: string
  nodeType: 'agent' | 'acp-agent' | 'human-gate' | 'fork'
  timestamp: number
}

interface GraphNodeCompletedEvent {
  type: 'graph.node.completed'
  runId: RunId
  graphId: string
  nodeId: string
  output: Record<string, unknown>
  timestamp: number
}
```

### 7.2 事件流的层级

编排图执行时，事件流是嵌套的：

```
graph.started
  graph.node.started (planner)
    message.started
    message.delta ...
    tool.started
    tool.completed
    message.completed
  graph.node.completed (planner)
  
  graph.node.started (coder)
    ... (内部事件)
  graph.node.completed (coder)

graph.completed
```

外层消费者（CLI、Web UI）通过 `graphId` + `nodeId` 字段把内部事件归属到对应的节点。

## 8. 图的可视化

`graph-serializer.ts` 提供两个函数：

```typescript
// 把当前 OrchestrationGraph 序列化为 JSON（前端直接渲染）
function serializeGraph(graph: OrchestrationGraph): string

// 从 LangGraph CompiledStateGraph 反推可视化数据
function getRuntimeGraphView(
  compiled: CompiledStateGraph,
  state: StateSnapshot
): GraphViewModel

interface GraphViewModel {
  nodes: Array<{
    id: string
    type: string
    status: 'pending' | 'running' | 'completed' | 'failed'
    output?: unknown
  }>
  edges: Array<{ from: string; to: string; condition?: string }>
  currentNode?: string
}
```

前端通过 SSE 事件流实时更新 `GraphViewModel` 中各节点的 status，渲染编排图的执行进度。

## 9. 图的来源与权限

### 9.1 三种来源

| source | 可变性 | 创建方式 |
|--------|--------|----------|
| `static` | 不可变 | 配置文件预定义 |
| `llm` | 可变（仅 LLM 自身） | LLM 通过结构化输出生成 |
| `human` | 可变（仅人类） | 人类在 UI 编辑或与 LLM 对话编辑后落定 |

### 9.2 修改权限矩阵

| 修改方 \ 图类型 | static | llm | human (locked=true) |
|----------------|--------|-----|---------------------|
| 系统启动加载 | ✓ | - | - |
| LLM 自动修改 | ✗ | ✓ | ✗ |
| 人类显式修改 | ✗ | ✓ | ✓ |

### 9.3 LLM 生成图的接口

```typescript
// LLM Planner 通过 deepagents 的 responseFormat 输出结构化图
const plannerResponseFormat = z.object({
  graph: OrchestrationGraphSchema
})

// 生成的图自动 source = 'llm', locked = false
```

## 10. 与现有 SessionRuntime 的集成

### 10.1 AgentSession 改造

```typescript
interface AgentSession {
  sessionId: SessionId
  
  // 现有：单 agent 路径
  query(prompt: string, options?: ChatOptions): AsyncIterable<RuntimeEvent>
  
  // 新增：编排图路径
  queryWithGraph(
    prompt: string,
    graph: OrchestrationGraph,
    options?: ChatOptions
  ): AsyncIterable<RuntimeEvent>
  
  abort(): void
}
```

### 10.2 图执行的 Run 模型

一次编排图执行是一个 SessionRuntime Run，但内部嵌套多个子 run（每个 agent 节点对应一个）。

```
Session
  └── Run (graph execution)
      ├── parentRunId: undefined
      ├── triggerType: 'new'
      ├── metadata: { graphId, graphVersion }
      ├── 子 Run #1 (planner 节点)
      ├── 子 Run #2 (coder 节点)
      └── 子 Run #3 (reviewer 节点)
```

子 run 通过 `parentRunId` 关联到图的顶层 run，便于回溯和恢复。

## 11. 后续扩展点

### 11.1 蜂群节点

未来可以在 JSON schema 中增加 `swarm` 节点类型：

```typescript
interface SwarmNode {
  id: string
  type: 'swarm'
  agents: AgentNode[]                      // 蜂群成员
  maxRounds: number
  terminationCondition: {
    field: string
    value: unknown
  }
}
```

编译时展开为：N 个并行 agent 节点 + 一个 router 检查终止条件 + 循环回到 swarm 入口。蜂群作为图中的"复合节点"，对外层完全透明。

### 11.2 远程 ACP agent

`AcpAgentNode.acp.endpoint` 字段已经预留了远程 ACP 端点，未来可以支持 HTTP/WebSocket 上的 ACP 通信，把节点部署到不同机器上。

### 11.3 动态图修改

LLM 在执行过程中可以通过特殊工具调用 `mutate_graph(diff)` 修改图（仅 `source: 'llm'` 且 `locked: false` 时）。修改后发射 `graph.mutated` 事件，前端实时刷新可视化。

## 12. 不在本设计范围内

以下能力本设计不覆盖，留待后续 spec：

- 跨节点 / 跨进程的分布式编排（这是 controlplane 层的事）
- 节点级别的细粒度权限控制（哪些工具能用哪些不能）
- 图的版本管理和迁移
- 编排图的可视化编辑器（前端 UI）
- LLM 生成图的 prompt 工程细节
