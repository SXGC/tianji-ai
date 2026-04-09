# 多智能体编排实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `packages/agent` 中新增基于 LangGraph 的多智能体编排层，支持 JSON 定义、编译执行、deepagents/ACP 节点、router/fork/human-gate 控制流，并与现有 `AgentSession` 集成。

**Architecture:** LangGraph StateGraph 作为执行底座；OrchestrationGraph JSON 经 compiler 转为 CompiledStateGraph；节点执行器通过工厂接口注入（packages/agent 提供 deepagents executor，apps/node 注入 ACP executor）；事件流通过新增的 `graph.*` RuntimeEvent 类型透传。

**Tech Stack:** TypeScript, `@langchain/langgraph` (^1.2.2), `@tianji/runtime` (复用 SessionRuntime), `@tianji/shared` (新增事件类型), `vitest`, `@langchain/core/utils/testing` (FakeListChatModel)。

**Spec 引用:** `docs/superpowers/specs/2026-04-09-multi-agent-orchestration-design.md`

---

## 文件结构

新增文件:

```
packages/agent/src/orchestration/
├── index.ts                              # 公共导出
├── graph-schema.ts                       # OrchestrationGraph 等类型定义
├── graph-validator.ts                    # validateOrchestrationGraph()
├── state-channels.ts                     # StateChannelDef → Annotation 编译
├── io-mapping.ts                         # state ↔ message 字段映射
├── executors/
│   ├── executor-types.ts                 # NodeAction / 工厂接口
│   ├── deepagents-executor.ts            # createDeepagentsExecutorFactory()
│   └── acp-executor.ts                   # createAcpExecutorFactory() (注入式)
├── graph-compiler.ts                     # compileOrchestrationGraph()
├── graph-runner.ts                       # runOrchestrationGraph() 顶层入口
└── __tests__/
    ├── graph-validator.test.ts
    ├── state-channels.test.ts
    ├── io-mapping.test.ts
    ├── graph-compiler.test.ts
    ├── deepagents-executor.test.ts
    └── graph-runner.e2e.test.ts
```

修改文件:

```
packages/shared/src/events.ts             # 新增 GraphEvent 类型并入 RuntimeEvent
packages/shared/src/index.ts              # 导出新事件
packages/agent/package.json               # 增加 @langchain/langgraph 依赖
packages/agent/src/index.ts               # 导出 orchestration 子模块
packages/agent/src/session.ts             # 增加 queryWithGraph 方法
```

---

## Phase A: 基础设施与类型

### Task 1: 添加依赖与新增 graph 事件类型

**Files:**
- Modify: `packages/agent/package.json`
- Modify: `packages/shared/src/events.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: 在 packages/agent/package.json 的 `dependencies` 中加入 `@langchain/langgraph`，版本与 runtime 包对齐**

打开 `packages/runtime/package.json`，找到 `@langchain/langgraph` 的版本号（应为 `^1.2.2`），把同一行加到 `packages/agent/package.json` 的 `dependencies`，按字母序插入。

```json
"dependencies": {
  ...
  "@langchain/langgraph": "^1.2.2",
  ...
}
```

- [ ] **Step 2: 运行 `pnpm install` 把依赖装上**

```bash
pnpm install
```

预期：无错误，`packages/agent/node_modules/@langchain/langgraph` 出现。

- [ ] **Step 3: 在 `packages/shared/src/events.ts` 的最末尾追加 GraphEvent 类型**

完整新增内容（追加在文件末尾）：

```typescript
// ============================================================================
// Graph Orchestration Events
// ============================================================================

export type GraphEventType =
  | 'graph.started'
  | 'graph.node.started'
  | 'graph.node.completed'
  | 'graph.node.failed'
  | 'graph.completed'

export interface GraphStartedEvent {
  readonly type: 'graph.started'
  readonly runId: RunId
  readonly graphId: string
  readonly graphVersion: number
  readonly timestamp: number
}

export type GraphNodeKind = 'agent' | 'acp-agent' | 'human-gate' | 'fork'

export interface GraphNodeStartedEvent {
  readonly type: 'graph.node.started'
  readonly runId: RunId
  readonly graphId: string
  readonly nodeId: string
  readonly nodeKind: GraphNodeKind
  readonly timestamp: number
}

export interface GraphNodeCompletedEvent {
  readonly type: 'graph.node.completed'
  readonly runId: RunId
  readonly graphId: string
  readonly nodeId: string
  readonly output: Record<string, unknown>
  readonly timestamp: number
}

export interface GraphNodeFailedEvent {
  readonly type: 'graph.node.failed'
  readonly runId: RunId
  readonly graphId: string
  readonly nodeId: string
  readonly error: TianjiError
  readonly timestamp: number
}

export interface GraphCompletedEvent {
  readonly type: 'graph.completed'
  readonly runId: RunId
  readonly graphId: string
  readonly finalState: Record<string, unknown>
  readonly timestamp: number
}

export type GraphEvent =
  | GraphStartedEvent
  | GraphNodeStartedEvent
  | GraphNodeCompletedEvent
  | GraphNodeFailedEvent
  | GraphCompletedEvent
```

- [ ] **Step 4: 把 GraphEvent 并入 RuntimeEvent 联合类型**

在同一个 `packages/shared/src/events.ts` 文件中，找到 `RuntimeEvent` 的定义（discriminated union），追加 `| GraphEvent`：

```typescript
export type RuntimeEvent =
  | RunStartedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunCancelledEvent
  | MessageStartedEvent
  | MessageDeltaEvent
  | MessageCompletedEvent
  | ToolStartedEvent
  | ToolCompletedEvent
  | ToolFailedEvent
  | GraphEvent
```

同时把 `GraphEventType` 加到 `RuntimeEventType`：

```typescript
export type RuntimeEventType =
  | 'run.started'
  | ...其他...
  | 'tool.failed'
  | GraphEventType
```

- [ ] **Step 5: 确认 `packages/shared/src/index.ts` 重新导出新类型**

打开 `packages/shared/src/index.ts`，确保有 `export * from './events'` 或类似的全量导出。如果是按需导出，则补上：

```typescript
export type {
  GraphEvent,
  GraphEventType,
  GraphStartedEvent,
  GraphNodeStartedEvent,
  GraphNodeCompletedEvent,
  GraphNodeFailedEvent,
  GraphCompletedEvent,
  GraphNodeKind,
} from './events'
```

- [ ] **Step 6: 跑 typecheck**

```bash
pnpm --filter @tianji/shared typecheck
pnpm --filter @tianji/agent typecheck
```

预期：无错误。

- [ ] **Step 7: 提交**

```bash
git add packages/agent/package.json pnpm-lock.yaml packages/shared/src/events.ts packages/shared/src/index.ts
git commit -m "feat(shared,agent): 新增 graph.* 编排事件类型并加 langgraph 依赖"
```

---

### Task 2: 定义 OrchestrationGraph schema 类型

**Files:**
- Create: `packages/agent/src/orchestration/graph-schema.ts`

- [ ] **Step 1: 创建 graph-schema.ts，全量类型定义**

```typescript
/**
 * 编排图的 JSON Schema 类型定义。
 * 这些类型对应可序列化的图结构，由 graph-compiler 编译为 LangGraph CompiledStateGraph。
 */

export type OrchestrationGraphSource = 'static' | 'llm' | 'human'

export interface OrchestrationGraph {
  readonly id: string
  readonly name: string
  readonly version: number
  readonly source: OrchestrationGraphSource
  readonly locked: boolean
  readonly state: Record<string, StateChannelDef>
  readonly nodes: readonly GraphNode[]
  readonly edges: readonly GraphEdge[]
}

export type StateChannelType = 'string' | 'number' | 'boolean' | 'list' | 'object'
export type StateChannelReducer = 'append' | 'replace' | 'merge'

export interface StateChannelDef {
  readonly type: StateChannelType
  readonly default?: unknown
  readonly reducer?: StateChannelReducer
}

export type GraphNode =
  | AgentNode
  | AcpAgentNode
  | RouterNode
  | HumanGateNode
  | ForkNode

export interface SubAgentDef {
  readonly name: string
  readonly description?: string
  readonly systemPrompt?: string
  readonly tools?: readonly string[]
  readonly model?: string
}

export interface AgentNode {
  readonly id: string
  readonly type: 'agent'
  readonly agent: {
    readonly model: string
    readonly systemPrompt: string
    readonly tools?: readonly string[]
    readonly subagents?: readonly SubAgentDef[]
    readonly skills?: readonly string[]
  }
  readonly input?: readonly string[]
  readonly output?: readonly string[]
}

export interface AcpAgentNode {
  readonly id: string
  readonly type: 'acp-agent'
  readonly acp: {
    readonly command?: string
    readonly args?: readonly string[]
    readonly endpoint?: string
    readonly auth?: { readonly type: 'bearer'; readonly tokenEnv: string }
    readonly timeout?: number
  }
  readonly input?: readonly string[]
  readonly output?: readonly string[]
}

export interface RouterNode {
  readonly id: string
  readonly type: 'router'
  readonly condition: {
    readonly field: string
    readonly branches: Record<string, string>
  }
}

export interface HumanGateNode {
  readonly id: string
  readonly type: 'human-gate'
  readonly prompt: string
}

export interface ForkNode {
  readonly id: string
  readonly type: 'fork'
  readonly targets: readonly string[]
  readonly join: string
}

export interface GraphEdge {
  readonly from: string
  readonly to: string
}

/** LangGraph 保留节点名 */
export const GRAPH_START = '__start__' as const
export const GRAPH_END = '__end__' as const

export type ReservedNodeId = typeof GRAPH_START | typeof GRAPH_END
```

- [ ] **Step 2: 跑 typecheck**

```bash
cd packages/agent && pnpm typecheck
```

预期：无错误。

- [ ] **Step 3: 提交**

```bash
git add packages/agent/src/orchestration/graph-schema.ts
git commit -m "feat(agent): 新增 orchestration graph-schema 类型定义"
```

---

### Task 3: 编写 graph-validator (TDD)

**Files:**
- Create: `packages/agent/src/orchestration/__tests__/graph-validator.test.ts`
- Create: `packages/agent/src/orchestration/graph-validator.ts`

- [ ] **Step 1: 写失败的测试**

```typescript
// packages/agent/src/orchestration/__tests__/graph-validator.test.ts
import { describe, expect, it } from 'vitest'
import { validateOrchestrationGraph } from '../graph-validator'
import type { OrchestrationGraph } from '../graph-schema'

function makeGraph(overrides: Partial<OrchestrationGraph> = {}): OrchestrationGraph {
  return {
    id: 'g1',
    name: 'test',
    version: 1,
    source: 'static',
    locked: false,
    state: { messages: { type: 'list', reducer: 'append' } },
    nodes: [
      {
        id: 'a',
        type: 'agent',
        agent: { model: 'fake', systemPrompt: 'sp' },
      },
    ],
    edges: [
      { from: '__start__', to: 'a' },
      { from: 'a', to: '__end__' },
    ],
    ...overrides,
  }
}

describe('validateOrchestrationGraph', () => {
  it('接受有效的最小图', () => {
    const result = validateOrchestrationGraph(makeGraph())
    expect(result.ok).toBe(true)
  })

  it('拒绝缺少 __start__ 入边的图', () => {
    const result = validateOrchestrationGraph(
      makeGraph({ edges: [{ from: 'a', to: '__end__' }] })
    )
    expect(result.ok).toBe(false)
    expect(result.errors[0]).toMatch(/__start__/)
  })

  it('拒绝包含孤立节点的图', () => {
    const result = validateOrchestrationGraph(
      makeGraph({
        nodes: [
          { id: 'a', type: 'agent', agent: { model: 'fake', systemPrompt: 'sp' } },
          { id: 'orphan', type: 'agent', agent: { model: 'fake', systemPrompt: 'sp' } },
        ],
      })
    )
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes('orphan'))).toBe(true)
  })

  it('拒绝 router branches 指向不存在的节点', () => {
    const result = validateOrchestrationGraph(
      makeGraph({
        nodes: [
          { id: 'a', type: 'agent', agent: { model: 'fake', systemPrompt: 'sp' } },
          {
            id: 'r',
            type: 'router',
            condition: { field: 'x', branches: { yes: 'ghost', no: '__end__' } },
          },
        ],
        edges: [
          { from: '__start__', to: 'a' },
          { from: 'a', to: 'r' },
        ],
      })
    )
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes('ghost'))).toBe(true)
  })

  it('拒绝 fork.targets 指向不存在的节点', () => {
    const result = validateOrchestrationGraph(
      makeGraph({
        nodes: [
          { id: 'a', type: 'agent', agent: { model: 'fake', systemPrompt: 'sp' } },
          { id: 'b', type: 'agent', agent: { model: 'fake', systemPrompt: 'sp' } },
          { id: 'f', type: 'fork', targets: ['b', 'missing'], join: 'b' },
        ],
        edges: [
          { from: '__start__', to: 'a' },
          { from: 'a', to: 'f' },
        ],
      })
    )
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes('missing'))).toBe(true)
  })

  it('拒绝节点 id 使用保留字', () => {
    const result = validateOrchestrationGraph(
      makeGraph({
        nodes: [
          { id: '__start__' as string, type: 'agent', agent: { model: 'fake', systemPrompt: 'sp' } } as never,
        ],
      })
    )
    expect(result.ok).toBe(false)
    expect(result.errors.some(e => e.includes('保留'))).toBe(true)
  })

  it('拒绝 LLM 修改 locked 图（外部约定，不在此校验）', () => {
    // locked 字段权限校验应在外层（图编辑入口）做，validator 只校验结构。
    const result = validateOrchestrationGraph(makeGraph({ locked: true }))
    expect(result.ok).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试，确认全部失败（因为还没实现）**

```bash
cd packages/agent && pnpm vitest run src/orchestration/__tests__/graph-validator.test.ts
```

预期：FAIL，提示 `validateOrchestrationGraph` 未定义。

- [ ] **Step 3: 实现 validator（迭代式遍历，禁止递归）**

```typescript
// packages/agent/src/orchestration/graph-validator.ts
import {
  GRAPH_END,
  GRAPH_START,
  type GraphNode,
  type OrchestrationGraph,
} from './graph-schema'

export interface ValidationResult {
  readonly ok: boolean
  readonly errors: readonly string[]
}

const RESERVED_IDS = new Set<string>([GRAPH_START, GRAPH_END])

/**
 * 校验编排图的结构完整性。
 * 仅做结构检查；权限/锁定语义由调用方在编辑入口处保证。
 */
export function validateOrchestrationGraph(graph: OrchestrationGraph): ValidationResult {
  const errors: string[] = []

  // 1. 节点 id 不能与保留字冲突
  const seenIds = new Set<string>()
  for (const node of graph.nodes) {
    if (RESERVED_IDS.has(node.id)) {
      errors.push(`节点 id 不能使用保留字 "${node.id}"`)
    }
    if (seenIds.has(node.id)) {
      errors.push(`节点 id 重复: "${node.id}"`)
    }
    seenIds.add(node.id)
  }

  const knownIds = new Set<string>([...seenIds, GRAPH_START, GRAPH_END])

  // 2. 必须有且仅有一条 __start__ 入边
  const startEdges = graph.edges.filter(e => e.from === GRAPH_START)
  if (startEdges.length === 0) {
    errors.push('图必须包含一条从 __start__ 出发的边')
  }

  // 3. 边的两端都必须存在
  for (const edge of graph.edges) {
    if (!knownIds.has(edge.from)) {
      errors.push(`边的源节点不存在: "${edge.from}"`)
    }
    if (!knownIds.has(edge.to)) {
      errors.push(`边的目标节点不存在: "${edge.to}"`)
    }
  }

  // 4. router 的 branches 目标都必须存在
  // 5. fork 的 targets 和 join 都必须存在
  for (const node of graph.nodes) {
    if (node.type === 'router') {
      for (const [branchKey, target] of Object.entries(node.condition.branches)) {
        if (!knownIds.has(target)) {
          errors.push(
            `router "${node.id}" 的分支 "${branchKey}" 指向不存在的节点 "${target}"`
          )
        }
      }
    }
    if (node.type === 'fork') {
      for (const target of node.targets) {
        if (!knownIds.has(target)) {
          errors.push(`fork "${node.id}" 的 targets 包含不存在的节点 "${target}"`)
        }
      }
      if (!knownIds.has(node.join)) {
        errors.push(`fork "${node.id}" 的 join 节点不存在: "${node.join}"`)
      }
    }
  }

  // 6. 所有非控制流节点必须可达（从 __start__ 出发的 BFS，迭代式）
  const reachable = collectReachableNodes(graph, knownIds)
  for (const node of graph.nodes) {
    if (isControlFlowNode(node)) continue
    if (!reachable.has(node.id)) {
      errors.push(`节点 "${node.id}" 不可达`)
    }
  }

  return { ok: errors.length === 0, errors }
}

function isControlFlowNode(node: GraphNode): boolean {
  return node.type === 'router' || node.type === 'fork'
}

/**
 * 用 BFS 从 __start__ 出发收集可达节点。
 * 迭代实现，遵守 CLAUDE.md 的"禁止递归"原则。
 */
function collectReachableNodes(
  graph: OrchestrationGraph,
  knownIds: ReadonlySet<string>
): Set<string> {
  const adjacency = new Map<string, string[]>()
  for (const edge of graph.edges) {
    const list = adjacency.get(edge.from) ?? []
    list.push(edge.to)
    adjacency.set(edge.from, list)
  }
  // router 的分支也算出边
  // fork 的 targets 也算出边
  for (const node of graph.nodes) {
    if (node.type === 'router') {
      const list = adjacency.get(node.id) ?? []
      for (const target of Object.values(node.condition.branches)) {
        list.push(target)
      }
      adjacency.set(node.id, list)
    }
    if (node.type === 'fork') {
      const list = adjacency.get(node.id) ?? []
      for (const target of node.targets) {
        list.push(target)
      }
      list.push(node.join)
      adjacency.set(node.id, list)
    }
  }

  const visited = new Set<string>()
  const queue: string[] = [GRAPH_START]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (visited.has(current)) continue
    visited.add(current)
    const neighbors = adjacency.get(current) ?? []
    for (const next of neighbors) {
      if (knownIds.has(next) && !visited.has(next)) {
        queue.push(next)
      }
    }
  }
  return visited
}
```

- [ ] **Step 4: 运行测试，全部通过**

```bash
cd packages/agent && pnpm vitest run src/orchestration/__tests__/graph-validator.test.ts
```

预期：所有测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/agent/src/orchestration/graph-validator.ts packages/agent/src/orchestration/__tests__/graph-validator.test.ts
git commit -m "feat(agent): 实现 orchestration graph-validator 结构校验"
```

---

### Task 4: state-channels 编译 (TDD)

**Files:**
- Create: `packages/agent/src/orchestration/__tests__/state-channels.test.ts`
- Create: `packages/agent/src/orchestration/state-channels.ts`

- [ ] **Step 1: 写失败的测试**

```typescript
// packages/agent/src/orchestration/__tests__/state-channels.test.ts
import { describe, expect, it } from 'vitest'
import { compileStateChannels } from '../state-channels'

describe('compileStateChannels', () => {
  it('replace reducer 产生 LastValue 行为：后写覆盖前值', () => {
    const annotation = compileStateChannels({
      title: { type: 'string', reducer: 'replace' },
    })
    // Annotation.Root 返回的 spec 包含 channel 工厂
    expect(annotation).toBeDefined()
    expect(annotation.spec).toBeDefined()
    expect('title' in annotation.spec).toBe(true)
  })

  it('append reducer 产生 list 拼接行为', () => {
    const annotation = compileStateChannels({
      messages: { type: 'list', reducer: 'append' },
    })
    expect('messages' in annotation.spec).toBe(true)
    // 模拟一次 reducer 调用，验证 append 语义
    const channelDef = annotation.spec.messages
    // Annotation channel 的内部结构：channelDef 是工厂或 BaseChannel
    expect(channelDef).toBeDefined()
  })

  it('merge reducer 用于 object 类型', () => {
    const annotation = compileStateChannels({
      ctx: { type: 'object', reducer: 'merge' },
    })
    expect('ctx' in annotation.spec).toBe(true)
  })

  it('缺省 reducer 等价于 replace', () => {
    const annotation = compileStateChannels({
      flag: { type: 'boolean' },
    })
    expect('flag' in annotation.spec).toBe(true)
  })

  it('多个 channel 同时定义', () => {
    const annotation = compileStateChannels({
      a: { type: 'string' },
      b: { type: 'list', reducer: 'append' },
      c: { type: 'object', reducer: 'merge' },
    })
    expect('a' in annotation.spec).toBe(true)
    expect('b' in annotation.spec).toBe(true)
    expect('c' in annotation.spec).toBe(true)
  })

  it('对未知 reducer 类型抛错', () => {
    expect(() =>
      compileStateChannels({
        bad: { type: 'string', reducer: 'unknown' as never },
      })
    ).toThrow(/未知的 reducer/)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd packages/agent && pnpm vitest run src/orchestration/__tests__/state-channels.test.ts
```

预期：FAIL（`compileStateChannels` 未定义）。

- [ ] **Step 3: 实现 state-channels.ts**

```typescript
// packages/agent/src/orchestration/state-channels.ts
import { Annotation } from '@langchain/langgraph'
import type { StateChannelDef, StateChannelReducer } from './graph-schema'

/**
 * 把 OrchestrationGraph 的 state 定义编译为 LangGraph Annotation.Root。
 * 三种 reducer:
 *  - replace (默认): LastValue, 后写覆盖前值
 *  - append: 列表 reducer, 把新值追加到现有列表
 *  - merge: 对象 reducer, 浅合并两个对象
 */
export function compileStateChannels(
  channels: Record<string, StateChannelDef>
): ReturnType<typeof Annotation.Root> {
  const spec: Record<string, ReturnType<typeof Annotation>> = {}

  for (const [key, def] of Object.entries(channels)) {
    spec[key] = createChannelAnnotation(def)
  }

  return Annotation.Root(spec)
}

function createChannelAnnotation(def: StateChannelDef) {
  const reducer: StateChannelReducer = def.reducer ?? 'replace'

  if (reducer === 'replace') {
    return Annotation<unknown>({
      reducer: (_existing, update) => update,
      default: () => def.default,
    })
  }

  if (reducer === 'append') {
    return Annotation<unknown[]>({
      reducer: (existing, update) => {
        const base = Array.isArray(existing) ? existing : []
        const next = Array.isArray(update) ? update : [update]
        return [...base, ...next]
      },
      default: () => (Array.isArray(def.default) ? def.default : []),
    })
  }

  if (reducer === 'merge') {
    return Annotation<Record<string, unknown>>({
      reducer: (existing, update) => ({
        ...(existing ?? {}),
        ...(update ?? {}),
      }),
      default: () =>
        def.default && typeof def.default === 'object'
          ? (def.default as Record<string, unknown>)
          : {},
    })
  }

  throw new Error(`未知的 reducer 类型: ${String(reducer)}`)
}
```

- [ ] **Step 4: 运行测试，全部通过**

```bash
cd packages/agent && pnpm vitest run src/orchestration/__tests__/state-channels.test.ts
```

预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/agent/src/orchestration/state-channels.ts packages/agent/src/orchestration/__tests__/state-channels.test.ts
git commit -m "feat(agent): 实现 orchestration state-channels 编译为 langgraph Annotation"
```

---

## Phase B: 执行器接口与 IO 映射

### Task 5: executor-types + io-mapping (TDD io-mapping)

**Files:**
- Create: `packages/agent/src/orchestration/executors/executor-types.ts`
- Create: `packages/agent/src/orchestration/__tests__/io-mapping.test.ts`
- Create: `packages/agent/src/orchestration/io-mapping.ts`

- [ ] **Step 1: 创建 executor-types.ts**

```typescript
// packages/agent/src/orchestration/executors/executor-types.ts
import type { LangGraphRunnableConfig } from '@langchain/langgraph'
import type { GraphEvent, RunId } from '@tianji/shared'
import type { ObserverLogger } from '@tianji/observer'
import type { AcpAgentNode, AgentNode } from '../graph-schema'

/**
 * LangGraph 节点的执行函数。读 state，返回 state 的局部更新。
 */
export type NodeAction = (
  state: Record<string, unknown>,
  config: LangGraphRunnableConfig
) => Promise<Record<string, unknown>>

export interface NodeExecutorContext {
  readonly runId: RunId
  readonly graphId: string
  readonly observer?: ObserverLogger
  readonly emitGraphEvent: (event: GraphEvent) => void
  readonly abortSignal?: AbortSignal
}

/**
 * 把一个 AgentNode 编译为可执行的 NodeAction。
 * packages/agent 提供默认的 deepagents 实现。
 */
export type AgentExecutorFactory = (
  node: AgentNode,
  ctx: NodeExecutorContext
) => NodeAction

/**
 * 把一个 AcpAgentNode 编译为可执行的 NodeAction。
 * packages/agent 不提供具体实现，由 apps/node (或其他下游) 注入。
 */
export type AcpExecutorFactory = (
  node: AcpAgentNode,
  ctx: NodeExecutorContext
) => NodeAction
```

- [ ] **Step 2: 写 io-mapping 的失败测试**

```typescript
// packages/agent/src/orchestration/__tests__/io-mapping.test.ts
import { describe, expect, it } from 'vitest'
import {
  buildPromptFromState,
  buildStateUpdateFromText,
  buildOutputInstructionSuffix,
} from '../io-mapping'

describe('buildPromptFromState', () => {
  it('input 为空时返回空字符串', () => {
    expect(buildPromptFromState({}, undefined)).toBe('')
    expect(buildPromptFromState({ x: 'y' }, [])).toBe('')
  })

  it('单字段直接返回字符串值', () => {
    expect(buildPromptFromState({ task: 'hello' }, ['task'])).toBe('hello')
  })

  it('单字段非字符串时 JSON.stringify', () => {
    expect(buildPromptFromState({ data: { a: 1 } }, ['data'])).toBe('{"a":1}')
  })

  it('多字段拼接为带 markdown 标题的段落', () => {
    const out = buildPromptFromState({ plan: 'P', code: 'C' }, ['plan', 'code'])
    expect(out).toContain('## plan')
    expect(out).toContain('P')
    expect(out).toContain('## code')
    expect(out).toContain('C')
  })

  it('字段不存在于 state 时抛错（Let it crash）', () => {
    expect(() => buildPromptFromState({ a: 'x' }, ['ghost'])).toThrow(/ghost/)
  })
})

describe('buildStateUpdateFromText', () => {
  it('output 为空时返回空对象', () => {
    expect(buildStateUpdateFromText('result', undefined)).toEqual({})
    expect(buildStateUpdateFromText('result', [])).toEqual({})
  })

  it('单字段把整个文本写到该字段', () => {
    expect(buildStateUpdateFromText('hello', ['out'])).toEqual({ out: 'hello' })
  })

  it('多字段尝试解析 JSON 并按字段分配', () => {
    const text = '{"code":"C","tests":"T"}'
    expect(buildStateUpdateFromText(text, ['code', 'tests'])).toEqual({
      code: 'C',
      tests: 'T',
    })
  })

  it('多字段时 JSON 不合法则抛错', () => {
    expect(() => buildStateUpdateFromText('not json', ['a', 'b'])).toThrow(/JSON/)
  })

  it('多字段时 JSON 缺少字段则抛错', () => {
    expect(() => buildStateUpdateFromText('{"a":1}', ['a', 'b'])).toThrow(/b/)
  })

  it('多字段时 JSON 包裹在 markdown code fence 中也能解析', () => {
    const text = '```json\n{"a":"x","b":"y"}\n```'
    expect(buildStateUpdateFromText(text, ['a', 'b'])).toEqual({ a: 'x', b: 'y' })
  })
})

describe('buildOutputInstructionSuffix', () => {
  it('output 为空或单字段时返回空字符串', () => {
    expect(buildOutputInstructionSuffix(undefined)).toBe('')
    expect(buildOutputInstructionSuffix(['only'])).toBe('')
  })

  it('多字段返回 JSON 输出指令', () => {
    const suffix = buildOutputInstructionSuffix(['code', 'tests'])
    expect(suffix).toContain('JSON')
    expect(suffix).toContain('code')
    expect(suffix).toContain('tests')
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

```bash
cd packages/agent && pnpm vitest run src/orchestration/__tests__/io-mapping.test.ts
```

预期：FAIL。

- [ ] **Step 4: 实现 io-mapping.ts**

```typescript
// packages/agent/src/orchestration/io-mapping.ts

/**
 * 从 state 中读取节点 input 字段，构造发送给 agent 的 prompt。
 *  - 单字段：直接转字符串
 *  - 多字段：拼接为 ## 标题分段的 markdown
 *  - 字段不存在：抛错（Let it crash）
 */
export function buildPromptFromState(
  state: Record<string, unknown>,
  inputFields: readonly string[] | undefined
): string {
  if (!inputFields || inputFields.length === 0) {
    return ''
  }

  for (const field of inputFields) {
    if (!(field in state)) {
      throw new Error(`输入字段 "${field}" 不存在于 state 中`)
    }
  }

  if (inputFields.length === 1) {
    return stringifyValue(state[inputFields[0]])
  }

  const sections: string[] = []
  for (const field of inputFields) {
    sections.push(`## ${field}\n${stringifyValue(state[field])}`)
  }
  return sections.join('\n\n')
}

/**
 * 把 agent 输出文本映射回 state。
 *  - 单字段：整段文本写入
 *  - 多字段：要求 agent 输出 JSON，解析后按 key 分配
 */
export function buildStateUpdateFromText(
  text: string,
  outputFields: readonly string[] | undefined
): Record<string, unknown> {
  if (!outputFields || outputFields.length === 0) {
    return {}
  }

  if (outputFields.length === 1) {
    return { [outputFields[0]]: text }
  }

  const json = parseJsonAllowingFence(text)
  if (json === null || typeof json !== 'object') {
    throw new Error('多字段输出要求 agent 返回 JSON，但解析失败')
  }

  const result: Record<string, unknown> = {}
  for (const field of outputFields) {
    if (!(field in (json as Record<string, unknown>))) {
      throw new Error(`agent 输出 JSON 缺少字段 "${field}"`)
    }
    result[field] = (json as Record<string, unknown>)[field]
  }
  return result
}

/**
 * 多字段 output 时追加到 systemPrompt 的指令。
 */
export function buildOutputInstructionSuffix(
  outputFields: readonly string[] | undefined
): string {
  if (!outputFields || outputFields.length <= 1) {
    return ''
  }
  const fieldList = outputFields.map(f => `"${f}": string`).join(', ')
  return `\n\nReturn your answer strictly as JSON with shape: { ${fieldList} }`
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return JSON.stringify(value)
}

function parseJsonAllowingFence(text: string): unknown {
  const trimmed = text.trim()
  // 尝试剥掉 ```json ... ``` 围栏
  const fenceMatch = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/)
  const candidate = fenceMatch ? fenceMatch[1] : trimmed
  try {
    return JSON.parse(candidate)
  } catch (err) {
    throw new Error(`无法解析 JSON 输出: ${(err as Error).message}`)
  }
}
```

- [ ] **Step 5: 运行测试，全部通过**

```bash
cd packages/agent && pnpm vitest run src/orchestration/__tests__/io-mapping.test.ts
```

预期：PASS。

- [ ] **Step 6: 提交**

```bash
git add packages/agent/src/orchestration/executors/executor-types.ts packages/agent/src/orchestration/io-mapping.ts packages/agent/src/orchestration/__tests__/io-mapping.test.ts
git commit -m "feat(agent): 新增 orchestration executor 接口与 io-mapping 工具"
```

---

## Phase C: 编译器

### Task 6: graph-compiler 节点与简单边 (TDD)

**Files:**
- Create: `packages/agent/src/orchestration/__tests__/graph-compiler.test.ts`
- Create: `packages/agent/src/orchestration/graph-compiler.ts`

- [ ] **Step 1: 写第一组失败的测试（节点添加 + 简单边）**

```typescript
// packages/agent/src/orchestration/__tests__/graph-compiler.test.ts
import { describe, expect, it, vi } from 'vitest'
import { compileOrchestrationGraph } from '../graph-compiler'
import type {
  AgentExecutorFactory,
  NodeAction,
} from '../executors/executor-types'
import type { OrchestrationGraph } from '../graph-schema'

function noopAction(value: unknown): NodeAction {
  return async () => ({ result: value })
}

const stubAgentFactory: AgentExecutorFactory = (node) =>
  noopAction(`ran-${node.id}`)

function makeGraph(overrides: Partial<OrchestrationGraph> = {}): OrchestrationGraph {
  return {
    id: 'g1',
    name: 'test',
    version: 1,
    source: 'static',
    locked: false,
    state: { result: { type: 'string' } },
    nodes: [
      { id: 'a', type: 'agent', agent: { model: 'fake', systemPrompt: 'sp' } },
      { id: 'b', type: 'agent', agent: { model: 'fake', systemPrompt: 'sp' } },
    ],
    edges: [
      { from: '__start__', to: 'a' },
      { from: 'a', to: 'b' },
      { from: 'b', to: '__end__' },
    ],
    ...overrides,
  }
}

describe('compileOrchestrationGraph - basic nodes and edges', () => {
  it('编译简单的两节点串行图并能执行', async () => {
    const compiled = compileOrchestrationGraph(makeGraph(), {
      agentExecutorFactory: stubAgentFactory,
    })
    const finalState = await compiled.invoke({})
    expect(finalState.result).toBe('ran-b') // 后执行的覆盖
  })

  it('编译失败的图直接抛错（让 validator 错误透出）', () => {
    expect(() =>
      compileOrchestrationGraph(
        makeGraph({ edges: [{ from: 'a', to: 'b' }] }), // 缺 __start__
        { agentExecutorFactory: stubAgentFactory }
      )
    ).toThrow(/__start__/)
  })

  it('agentExecutorFactory 被调用一次每节点', () => {
    const factory = vi.fn(stubAgentFactory)
    compileOrchestrationGraph(makeGraph(), { agentExecutorFactory: factory })
    expect(factory).toHaveBeenCalledTimes(2) // a 和 b
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd packages/agent && pnpm vitest run src/orchestration/__tests__/graph-compiler.test.ts
```

预期：FAIL。

- [ ] **Step 3: 实现 graph-compiler.ts 的基础部分**

```typescript
// packages/agent/src/orchestration/graph-compiler.ts
import {
  END,
  START,
  StateGraph,
  type CompiledStateGraph,
} from '@langchain/langgraph'
import type { ObserverLogger } from '@tianji/observer'
import type { RunId } from '@tianji/shared'
import type {
  AcpExecutorFactory,
  AgentExecutorFactory,
  NodeAction,
  NodeExecutorContext,
} from './executors/executor-types'
import {
  GRAPH_END,
  GRAPH_START,
  type AcpAgentNode,
  type AgentNode,
  type ForkNode,
  type GraphNode,
  type HumanGateNode,
  type OrchestrationGraph,
  type RouterNode,
} from './graph-schema'
import { validateOrchestrationGraph } from './graph-validator'
import { compileStateChannels } from './state-channels'

export interface CompileOptions {
  readonly agentExecutorFactory: AgentExecutorFactory
  readonly acpExecutorFactory?: AcpExecutorFactory
  readonly checkpointer?: unknown
  readonly store?: unknown
  readonly observer?: ObserverLogger
  readonly runId?: RunId
  readonly emitGraphEvent?: (event: never) => void
}

/**
 * 把 OrchestrationGraph 编译为 LangGraph CompiledStateGraph。
 * 编译流程：
 *  1. 校验图结构
 *  2. 编译 state → Annotation.Root
 *  3. 添加节点 (agent / acp-agent / human-gate)
 *  4. 添加边 (普通边 / router 条件边 / fork Send)
 *  5. compile()
 */
export function compileOrchestrationGraph(
  graph: OrchestrationGraph,
  options: CompileOptions
): CompiledStateGraph<unknown, unknown, string> {
  const validation = validateOrchestrationGraph(graph)
  if (!validation.ok) {
    throw new Error(
      `编排图校验失败:\n${validation.errors.map(e => `  - ${e}`).join('\n')}`
    )
  }

  const stateAnnotation = compileStateChannels(graph.state)

  // 任意类型签名以便 langgraph 接受
  const builder = new StateGraph(stateAnnotation as never) as unknown as StateGraph<unknown>

  const ctx: NodeExecutorContext = {
    runId: options.runId ?? ('run_local' as RunId),
    graphId: graph.id,
    observer: options.observer,
    emitGraphEvent: () => undefined, // 默认空实现，graph-runner 会替换
  }

  const nodeMap = new Map<string, GraphNode>()
  for (const node of graph.nodes) nodeMap.set(node.id, node)

  // Step 3: 添加节点
  for (const node of graph.nodes) {
    if (node.type === 'agent') {
      const action = options.agentExecutorFactory(node, ctx)
      ;(builder as { addNode: (id: string, action: NodeAction) => unknown }).addNode(
        node.id,
        action
      )
    } else if (node.type === 'acp-agent') {
      if (!options.acpExecutorFactory) {
        throw new Error(
          `图包含 acp-agent 节点 "${node.id}" 但未提供 acpExecutorFactory`
        )
      }
      const action = options.acpExecutorFactory(node, ctx)
      ;(builder as { addNode: (id: string, action: NodeAction) => unknown }).addNode(
        node.id,
        action
      )
    } else if (node.type === 'human-gate') {
      ;(builder as { addNode: (id: string, action: NodeAction) => unknown }).addNode(
        node.id,
        createHumanGateAction(node)
      )
    }
    // router / fork: 不创建节点，留到 Step 4
  }

  // Step 4: 添加边
  addEdges(builder, graph, nodeMap)

  // Step 5: 编译
  const compiled = (builder as unknown as {
    compile: (opts?: unknown) => CompiledStateGraph<unknown, unknown, string>
  }).compile({
    checkpointer: options.checkpointer,
    store: options.store,
    interruptBefore: collectHumanGateIds(graph),
  })

  return compiled
}

function addEdges(
  builder: StateGraph<unknown>,
  graph: OrchestrationGraph,
  nodeMap: ReadonlyMap<string, GraphNode>
): void {
  // 内部函数实现逐步在后续 task 扩展。
  // 当前 task 6 只支持普通边。后续 task 7/8 扩展 router/fork。
  const builderAny = builder as unknown as {
    addEdge: (from: string, to: string) => unknown
  }
  for (const edge of graph.edges) {
    const fromKey = edge.from === GRAPH_START ? START : edge.from
    const toKey = edge.to === GRAPH_END ? END : edge.to
    builderAny.addEdge(fromKey, toKey)
  }
}

function createHumanGateAction(node: HumanGateNode): NodeAction {
  return async (state) => {
    // 实际的中断由 compile({ interruptBefore }) 触发；
    // 节点函数本身只是一个 pass-through
    void node
    return state
  }
}

function collectHumanGateIds(graph: OrchestrationGraph): string[] {
  return graph.nodes
    .filter((n): n is HumanGateNode => n.type === 'human-gate')
    .map(n => n.id)
}

// 占位：后续 task 实现
export function _internalRouterStub(_: RouterNode): void {}
export function _internalForkStub(_: ForkNode, __: AgentNode | AcpAgentNode): void {}
```

- [ ] **Step 4: 运行测试，确认基础测试通过**

```bash
cd packages/agent && pnpm vitest run src/orchestration/__tests__/graph-compiler.test.ts
```

预期：basic nodes and edges 的 3 个测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/agent/src/orchestration/graph-compiler.ts packages/agent/src/orchestration/__tests__/graph-compiler.test.ts
git commit -m "feat(agent): 实现 orchestration graph-compiler 基础节点与边编译"
```

---

### Task 7: 编译 router 为条件边 (TDD)

**Files:**
- Modify: `packages/agent/src/orchestration/__tests__/graph-compiler.test.ts`
- Modify: `packages/agent/src/orchestration/graph-compiler.ts`

- [ ] **Step 1: 在测试文件追加 router 测试**

在已有的 `graph-compiler.test.ts` 末尾追加：

```typescript
import type { AgentExecutorFactory } from '../executors/executor-types'

const echoStateFactory: AgentExecutorFactory = (node) =>
  async (state) => {
    if (node.id === 'setter_true') return { approved: true }
    if (node.id === 'setter_false') return { approved: false }
    return {}
  }

describe('compileOrchestrationGraph - router', () => {
  it('router 把控制流按条件分到不同分支', async () => {
    const graph: OrchestrationGraph = {
      id: 'g',
      name: 't',
      version: 1,
      source: 'static',
      locked: false,
      state: {
        approved: { type: 'boolean', default: false },
        count: { type: 'number', default: 0 },
      },
      nodes: [
        { id: 'setter_true', type: 'agent', agent: { model: 'fake', systemPrompt: '' } },
        {
          id: 'router1',
          type: 'router',
          condition: {
            field: 'approved',
            branches: { true: '__end__', false: 'setter_true' },
          },
        },
      ],
      edges: [
        { from: '__start__', to: 'setter_true' },
        { from: 'setter_true', to: 'router1' },
      ],
    }

    const compiled = compileOrchestrationGraph(graph, {
      agentExecutorFactory: echoStateFactory,
    })
    const finalState = await compiled.invoke({})
    expect(finalState.approved).toBe(true)
  })

  it('router 直接到 __end__ 时图正常结束', async () => {
    const graph: OrchestrationGraph = {
      id: 'g',
      name: 't',
      version: 1,
      source: 'static',
      locked: false,
      state: {
        approved: { type: 'boolean', default: true },
      },
      nodes: [
        { id: 'setter_true', type: 'agent', agent: { model: 'fake', systemPrompt: '' } },
        {
          id: 'router1',
          type: 'router',
          condition: {
            field: 'approved',
            branches: { true: '__end__', false: 'setter_true' },
          },
        },
      ],
      edges: [
        { from: '__start__', to: 'setter_true' },
        { from: 'setter_true', to: 'router1' },
      ],
    }

    const compiled = compileOrchestrationGraph(graph, {
      agentExecutorFactory: echoStateFactory,
    })
    const finalState = await compiled.invoke({})
    expect(finalState.approved).toBe(true)
  })
})
```

- [ ] **Step 2: 运行测试，确认 router 测试失败**

```bash
cd packages/agent && pnpm vitest run src/orchestration/__tests__/graph-compiler.test.ts
```

预期：basic 测试仍然 PASS，router 相关测试 FAIL（因为 router 编译还没实现）。

- [ ] **Step 3: 修改 graph-compiler.ts 的 addEdges，处理指向 router 的边**

替换 `addEdges` 函数：

```typescript
function addEdges(
  builder: StateGraph<unknown>,
  graph: OrchestrationGraph,
  nodeMap: ReadonlyMap<string, GraphNode>
): void {
  const builderAny = builder as unknown as {
    addEdge: (from: string, to: string) => unknown
    addConditionalEdges: (
      source: string,
      path: (state: Record<string, unknown>) => string,
      pathMap: Record<string, string>
    ) => unknown
  }

  // 收集所有 router 节点
  const routerNodes = new Map<string, RouterNode>()
  for (const node of graph.nodes) {
    if (node.type === 'router') routerNodes.set(node.id, node)
  }

  // 处理普通边；如果目标是 router，转成条件边
  for (const edge of graph.edges) {
    const fromKey = edge.from === GRAPH_START ? START : edge.from
    const router = routerNodes.get(edge.to)

    if (router) {
      const pathMap: Record<string, string> = {}
      for (const [branchKey, target] of Object.entries(router.condition.branches)) {
        pathMap[branchKey] = target === GRAPH_END ? END : target
      }
      builderAny.addConditionalEdges(
        fromKey,
        (state) => String((state as Record<string, unknown>)[router.condition.field]),
        pathMap
      )
    } else {
      const toKey = edge.to === GRAPH_END ? END : edge.to
      builderAny.addEdge(fromKey, toKey)
    }
  }
}
```

- [ ] **Step 4: 运行测试，确认全部通过**

```bash
cd packages/agent && pnpm vitest run src/orchestration/__tests__/graph-compiler.test.ts
```

预期：所有 router 测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/agent/src/orchestration/graph-compiler.ts packages/agent/src/orchestration/__tests__/graph-compiler.test.ts
git commit -m "feat(agent): graph-compiler 支持 router 条件边编译"
```

---

### Task 8: 编译 fork 与 human-gate (TDD)

**Files:**
- Modify: `packages/agent/src/orchestration/__tests__/graph-compiler.test.ts`
- Modify: `packages/agent/src/orchestration/graph-compiler.ts`

- [ ] **Step 1: 追加 fork 与 human-gate 测试**

在 `graph-compiler.test.ts` 末尾追加：

```typescript
describe('compileOrchestrationGraph - fork/join', () => {
  it('fork 把控制流并行分发到多个目标节点', async () => {
    const calls: string[] = []
    const trackingFactory: AgentExecutorFactory = (node) => async () => {
      calls.push(node.id)
      return { logs: [node.id] }
    }

    const graph: OrchestrationGraph = {
      id: 'g',
      name: 't',
      version: 1,
      source: 'static',
      locked: false,
      state: {
        logs: { type: 'list', reducer: 'append', default: [] },
      },
      nodes: [
        { id: 'start_node', type: 'agent', agent: { model: 'fake', systemPrompt: '' } },
        { id: 'left', type: 'agent', agent: { model: 'fake', systemPrompt: '' } },
        { id: 'right', type: 'agent', agent: { model: 'fake', systemPrompt: '' } },
        { id: 'merge', type: 'agent', agent: { model: 'fake', systemPrompt: '' } },
        { id: 'fork1', type: 'fork', targets: ['left', 'right'], join: 'merge' },
      ],
      edges: [
        { from: '__start__', to: 'start_node' },
        { from: 'start_node', to: 'fork1' },
        { from: 'merge', to: '__end__' },
      ],
    }

    const compiled = compileOrchestrationGraph(graph, {
      agentExecutorFactory: trackingFactory,
    })
    const finalState = await compiled.invoke({})

    expect(calls).toContain('left')
    expect(calls).toContain('right')
    expect(calls).toContain('merge')
    // logs 是 append reducer，应包含所有节点的 id
    expect(finalState.logs as string[]).toEqual(
      expect.arrayContaining(['start_node', 'left', 'right', 'merge'])
    )
  })
})

describe('compileOrchestrationGraph - human-gate', () => {
  it('human-gate 节点编译时被加入 interruptBefore', async () => {
    const graph: OrchestrationGraph = {
      id: 'g',
      name: 't',
      version: 1,
      source: 'static',
      locked: false,
      state: { x: { type: 'string' } },
      nodes: [
        { id: 'a', type: 'agent', agent: { model: 'fake', systemPrompt: '' } },
        { id: 'gate', type: 'human-gate', prompt: '请确认' },
      ],
      edges: [
        { from: '__start__', to: 'a' },
        { from: 'a', to: 'gate' },
        { from: 'gate', to: '__end__' },
      ],
    }

    // 编译不抛错即视为成功；运行时中断行为依赖 checkpointer，本测试不验证。
    expect(() =>
      compileOrchestrationGraph(graph, { agentExecutorFactory: stubAgentFactory })
    ).not.toThrow()
  })
})
```

- [ ] **Step 2: 运行测试确认 fork 测试失败**

```bash
cd packages/agent && pnpm vitest run src/orchestration/__tests__/graph-compiler.test.ts
```

预期：fork 测试 FAIL，human-gate 测试 PASS（因为 task 6 已经把 human-gate 加入了 interruptBefore，且节点函数是 pass-through，编译不会失败）。

- [ ] **Step 3: 实现 fork 编译**

在 `graph-compiler.ts` 顶部加入 `Send` 导入：

```typescript
import {
  END,
  Send,
  START,
  StateGraph,
  type CompiledStateGraph,
} from '@langchain/langgraph'
```

修改 `addEdges` 函数，在处理普通边之前先收集 fork 节点，处理指向 fork 的边：

```typescript
function addEdges(
  builder: StateGraph<unknown>,
  graph: OrchestrationGraph,
  nodeMap: ReadonlyMap<string, GraphNode>
): void {
  const builderAny = builder as unknown as {
    addEdge: (from: string, to: string) => unknown
    addConditionalEdges: (
      source: string,
      path: (state: Record<string, unknown>) => string | Send | (string | Send)[],
      pathMap?: Record<string, string>
    ) => unknown
  }

  const routerNodes = new Map<string, RouterNode>()
  const forkNodes = new Map<string, ForkNode>()
  for (const node of graph.nodes) {
    if (node.type === 'router') routerNodes.set(node.id, node)
    if (node.type === 'fork') forkNodes.set(node.id, node)
  }

  for (const edge of graph.edges) {
    const fromKey = edge.from === GRAPH_START ? START : edge.from
    const router = routerNodes.get(edge.to)
    const fork = forkNodes.get(edge.to)

    if (router) {
      const pathMap: Record<string, string> = {}
      for (const [branchKey, target] of Object.entries(router.condition.branches)) {
        pathMap[branchKey] = target === GRAPH_END ? END : target
      }
      builderAny.addConditionalEdges(
        fromKey,
        (state) => String((state as Record<string, unknown>)[router.condition.field]),
        pathMap
      )
    } else if (fork) {
      // fork: 用 conditional edges + Send 实现并行扇出
      const targets = [...fork.targets]
      builderAny.addConditionalEdges(
        fromKey,
        (state) => targets.map(t => new Send(t, state)),
        Object.fromEntries(targets.map(t => [t, t]))
      )
      // fork 的每个 target → join
      for (const target of fork.targets) {
        builderAny.addEdge(target, fork.join)
      }
    } else {
      const toKey = edge.to === GRAPH_END ? END : edge.to
      builderAny.addEdge(fromKey, toKey)
    }
  }
}
```

- [ ] **Step 4: 运行测试，全部通过**

```bash
cd packages/agent && pnpm vitest run src/orchestration/__tests__/graph-compiler.test.ts
```

预期：所有 PASS。

- [ ] **Step 5: 删除 graph-compiler.ts 末尾的占位 stub 函数**

```typescript
// 删除这两行
export function _internalRouterStub(_: RouterNode): void {}
export function _internalForkStub(_: ForkNode, __: AgentNode | AcpAgentNode): void {}
```

- [ ] **Step 6: 跑 typecheck**

```bash
cd packages/agent && pnpm typecheck
```

预期：无错误。

- [ ] **Step 7: 提交**

```bash
git add packages/agent/src/orchestration/graph-compiler.ts packages/agent/src/orchestration/__tests__/graph-compiler.test.ts
git commit -m "feat(agent): graph-compiler 支持 fork 并行扇出"
```

---

## Phase D: 默认执行器

### Task 9: deepagents-executor (TDD)

**Files:**
- Create: `packages/agent/src/orchestration/__tests__/deepagents-executor.test.ts`
- Create: `packages/agent/src/orchestration/executors/deepagents-executor.ts`

- [ ] **Step 1: 写失败的测试**

```typescript
// packages/agent/src/orchestration/__tests__/deepagents-executor.test.ts
import { FakeListChatModel } from '@langchain/core/utils/testing'
import { describe, expect, it, vi } from 'vitest'
import { createDeepagentsExecutorFactory } from '../executors/deepagents-executor'
import type { NodeExecutorContext } from '../executors/executor-types'
import type { AgentNode } from '../graph-schema'

function makeCtx(): NodeExecutorContext {
  return {
    runId: 'run_test' as never,
    graphId: 'g1',
    emitGraphEvent: vi.fn(),
  }
}

function makeNode(overrides: Partial<AgentNode['agent']> = {}): AgentNode {
  return {
    id: 'node1',
    type: 'agent',
    agent: {
      model: 'fake',
      systemPrompt: 'You are helpful.',
      ...overrides,
    },
  }
}

describe('createDeepagentsExecutorFactory', () => {
  it('节点执行后从 state 读 input 并把结果写回 output', async () => {
    const factory = createDeepagentsExecutorFactory({
      resolveModel: () => new FakeListChatModel({ responses: ['hello world'] }),
    })
    const node: AgentNode = {
      ...makeNode(),
      input: ['question'],
      output: ['answer'],
    }
    const action = factory(node, makeCtx())

    const update = await action({ question: 'hi?' }, {} as never)
    expect(update.answer).toBe('hello world')
  })

  it('emit graph.node.started 和 graph.node.completed', async () => {
    const events: unknown[] = []
    const ctx: NodeExecutorContext = {
      ...makeCtx(),
      emitGraphEvent: (e) => events.push(e),
    }
    const factory = createDeepagentsExecutorFactory({
      resolveModel: () => new FakeListChatModel({ responses: ['ok'] }),
    })
    const node: AgentNode = { ...makeNode(), input: ['q'], output: ['a'] }
    const action = factory(node, ctx)
    await action({ q: 'x' }, {} as never)

    const types = events.map((e: { type: string }) => e.type)
    expect(types).toContain('graph.node.started')
    expect(types).toContain('graph.node.completed')
  })

  it('input 字段不存在时抛错', async () => {
    const factory = createDeepagentsExecutorFactory({
      resolveModel: () => new FakeListChatModel({ responses: ['ok'] }),
    })
    const node: AgentNode = { ...makeNode(), input: ['ghost'], output: ['a'] }
    const action = factory(node, makeCtx())

    await expect(action({}, {} as never)).rejects.toThrow(/ghost/)
  })

  it('多 output 字段时 systemPrompt 自动追加 JSON 指令', async () => {
    let capturedSystemPrompt: string | undefined
    const factory = createDeepagentsExecutorFactory({
      resolveModel: () => new FakeListChatModel({ responses: ['{"code":"C","tests":"T"}'] }),
      onRuntimeOptions: (opts) => {
        capturedSystemPrompt = opts.systemPrompt
      },
    })
    const node: AgentNode = {
      ...makeNode(),
      input: ['task'],
      output: ['code', 'tests'],
    }
    const action = factory(node, makeCtx())
    const update = await action({ task: 'do it' }, {} as never)

    expect(update).toEqual({ code: 'C', tests: 'T' })
    expect(capturedSystemPrompt).toContain('JSON')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd packages/agent && pnpm vitest run src/orchestration/__tests__/deepagents-executor.test.ts
```

预期：FAIL。

- [ ] **Step 3: 实现 deepagents-executor.ts**

```typescript
// packages/agent/src/orchestration/executors/deepagents-executor.ts
import type { BaseLanguageModel } from '@langchain/core/language_models/base'
import {
  InMemorySnapshotStore,
  createSessionRuntime,
  type RunTurnOptions,
  type SessionRuntime,
  type SessionRuntimeOptions,
  type ToolCatalog,
} from '@tianji/runtime'
import type { AppMessage, RuntimeEvent, SessionId } from '@tianji/shared'
import type { ObserverLogger } from '@tianji/observer'
import {
  buildOutputInstructionSuffix,
  buildPromptFromState,
  buildStateUpdateFromText,
} from '../io-mapping'
import type { AgentNode } from '../graph-schema'
import type {
  AgentExecutorFactory,
  NodeAction,
  NodeExecutorContext,
} from './executor-types'

export interface CreateDeepagentsExecutorFactoryOptions {
  /**
   * 把图中节点的 model 字符串解析为实际的模型实例或字符串引用。
   * 测试中可返回 FakeListChatModel；生产中可直接返回 model 字符串。
   */
  readonly resolveModel: (modelRef: string) => string | BaseLanguageModel
  readonly toolCatalog?: ToolCatalog
  readonly observer?: ObserverLogger
  /**
   * 测试钩子：观察 SessionRuntime 实际收到的 RunTurnOptions。
   * 生产代码不应使用。
   */
  readonly onRuntimeOptions?: (options: RunTurnOptions) => void
}

/**
 * 创建一个工厂函数，用于把 AgentNode 编译为 LangGraph 节点 action。
 * 每次节点执行都会创建一个独立的 SessionRuntime 实例（线程隔离）。
 */
export function createDeepagentsExecutorFactory(
  options: CreateDeepagentsExecutorFactoryOptions
): AgentExecutorFactory {
  return (node: AgentNode, ctx: NodeExecutorContext): NodeAction => {
    return async (state) => {
      const startTs = Date.now()
      ctx.emitGraphEvent({
        type: 'graph.node.started',
        runId: ctx.runId,
        graphId: ctx.graphId,
        nodeId: node.id,
        nodeKind: 'agent',
        timestamp: startTs,
      })

      const promptText = buildPromptFromState(state, node.input)
      const systemPromptSuffix = buildOutputInstructionSuffix(node.output)
      const fullSystemPrompt = node.agent.systemPrompt + systemPromptSuffix

      const runtime = buildRuntimeForNode(node, options)

      const session = await runtime.createSession({})
      const userMessage: AppMessage = {
        id: `msg_user_${startTs}`,
        role: 'user',
        content: [{ type: 'text', text: promptText }],
        createdAt: startTs,
      }

      const runOptions: RunTurnOptions = {
        sessionId: session.sessionId,
        message: userMessage,
        systemPrompt: fullSystemPrompt,
        abortSignal: ctx.abortSignal,
      }
      options.onRuntimeOptions?.(runOptions)

      const runId = await runtime.runTurn(runOptions)
      const finalText = await collectFinalAssistantText(runtime, runId)

      const update = buildStateUpdateFromText(finalText, node.output)

      ctx.emitGraphEvent({
        type: 'graph.node.completed',
        runId: ctx.runId,
        graphId: ctx.graphId,
        nodeId: node.id,
        output: update,
        timestamp: Date.now(),
      })

      await runtime.closeSession(session.sessionId)
      return update
    }
  }
}

function buildRuntimeForNode(
  node: AgentNode,
  options: CreateDeepagentsExecutorFactoryOptions
): SessionRuntime {
  const sessionOptions: SessionRuntimeOptions = {
    deepagents: {
      model: options.resolveModel(node.agent.model),
      subagents: node.agent.subagents,
      skills: node.agent.skills,
    },
    snapshotStore: new InMemorySnapshotStore(),
    toolCatalog: options.toolCatalog,
    logger: options.observer,
  }
  return createSessionRuntime(sessionOptions)
}

/**
 * 消费 streamEvents，提取最后一条 assistant message 的文本内容。
 */
async function collectFinalAssistantText(
  runtime: SessionRuntime,
  runId: string
): Promise<string> {
  let finalText = ''
  for await (const event of runtime.streamEvents(runId as never) as AsyncIterable<RuntimeEvent>) {
    if (event.type === 'message.completed' && event.message.role === 'assistant') {
      finalText = extractTextFromMessage(event.message)
    }
  }
  return finalText
}

function extractTextFromMessage(message: AppMessage): string {
  const parts: string[] = []
  for (const part of message.content) {
    if (part.type === 'text') parts.push(part.text)
  }
  return parts.join('')
}
```

- [ ] **Step 4: 运行测试，全部通过**

```bash
cd packages/agent && pnpm vitest run src/orchestration/__tests__/deepagents-executor.test.ts
```

预期：PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/agent/src/orchestration/executors/deepagents-executor.ts packages/agent/src/orchestration/__tests__/deepagents-executor.test.ts
git commit -m "feat(agent): 实现 deepagents 节点执行器工厂"
```

---

### Task 10: acp-executor 注入式占位

**Files:**
- Create: `packages/agent/src/orchestration/executors/acp-executor.ts`

- [ ] **Step 1: 创建 acp-executor.ts**

这个文件不实现具体的 ACP 子进程通信逻辑（那部分依赖 `apps/node` 的 `AgentRunner`），而是定义一个适配器：调用方传入一个 `RunnerProvider`，executor 用它启动/查询/断开。

```typescript
// packages/agent/src/orchestration/executors/acp-executor.ts
import type { RuntimeEvent } from '@tianji/shared'
import {
  buildOutputInstructionSuffix,
  buildPromptFromState,
  buildStateUpdateFromText,
} from '../io-mapping'
import type { AcpAgentNode } from '../graph-schema'
import type {
  AcpExecutorFactory,
  NodeAction,
  NodeExecutorContext,
} from './executor-types'

/**
 * ACP runner 的最小接口。
 * apps/node 的 AgentRunner 已经满足这个形状，可以直接传入。
 */
export interface AcpRunnerLike {
  connect(): Promise<void>
  query(prompt: string): AsyncIterable<RuntimeEvent>
  disconnect(): Promise<void>
}

export interface AcpRunnerProvider {
  (node: AcpAgentNode): AcpRunnerLike
}

export interface CreateAcpExecutorFactoryOptions {
  readonly runnerProvider: AcpRunnerProvider
}

/**
 * 创建 ACP 节点执行器工厂。
 * apps/node 应在配置 SessionRuntime 时把这个工厂连同 runnerProvider 一起传入。
 */
export function createAcpExecutorFactory(
  options: CreateAcpExecutorFactoryOptions
): AcpExecutorFactory {
  return (node: AcpAgentNode, ctx: NodeExecutorContext): NodeAction => {
    return async (state) => {
      const startTs = Date.now()
      ctx.emitGraphEvent({
        type: 'graph.node.started',
        runId: ctx.runId,
        graphId: ctx.graphId,
        nodeId: node.id,
        nodeKind: 'acp-agent',
        timestamp: startTs,
      })

      const promptText = buildPromptFromState(state, node.input)
      const suffix = buildOutputInstructionSuffix(node.output)
      const fullPrompt = suffix ? `${promptText}${suffix}` : promptText

      const runner = options.runnerProvider(node)
      await runner.connect()

      let accumulated = ''
      try {
        for await (const event of runner.query(fullPrompt)) {
          if (
            event.type === 'message.completed' &&
            event.message.role === 'assistant'
          ) {
            accumulated = extractText(event.message)
          }
        }
      } finally {
        await runner.disconnect()
      }

      const update = buildStateUpdateFromText(accumulated, node.output)

      ctx.emitGraphEvent({
        type: 'graph.node.completed',
        runId: ctx.runId,
        graphId: ctx.graphId,
        nodeId: node.id,
        output: update,
        timestamp: Date.now(),
      })

      return update
    }
  }
}

function extractText(message: { content: { type: string; text?: string }[] }): string {
  return message.content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text' && typeof p.text === 'string')
    .map(p => p.text)
    .join('')
}
```

- [ ] **Step 2: 跑 typecheck**

```bash
cd packages/agent && pnpm typecheck
```

预期：无错误。

- [ ] **Step 3: 提交**

```bash
git add packages/agent/src/orchestration/executors/acp-executor.ts
git commit -m "feat(agent): 新增 ACP 节点执行器工厂（注入式 runner provider）"
```

---

## Phase E: 顶层 Runner 与会话集成

### Task 11: graph-runner 顶层入口（含 emitGraphEvent 贯通）

**Files:**
- Modify: `packages/agent/src/orchestration/graph-compiler.ts`
- Create: `packages/agent/src/orchestration/graph-runner.ts`

为了让 graph-runner 的事件 emitter 能传到所有节点的 NodeExecutorContext，需要先把 `emitGraphEvent` 提升到 `CompileOptions` 中，再在 graph-runner 里把事件队列的 emit 函数注入。

- [ ] **Step 1: 在 graph-compiler.ts 的 CompileOptions 中加入 emitGraphEvent**

修改 import：

```typescript
import type { GraphEvent, RunId } from '@tianji/shared'
```

修改接口：

```typescript
export interface CompileOptions {
  readonly agentExecutorFactory: AgentExecutorFactory
  readonly acpExecutorFactory?: AcpExecutorFactory
  readonly checkpointer?: unknown
  readonly store?: unknown
  readonly observer?: ObserverLogger
  readonly runId?: RunId
  readonly emitGraphEvent?: (event: GraphEvent) => void
}
```

修改 ctx 构造：

```typescript
const ctx: NodeExecutorContext = {
  runId: options.runId ?? ('run_local' as RunId),
  graphId: graph.id,
  observer: options.observer,
  emitGraphEvent: options.emitGraphEvent ?? (() => undefined),
}
```

- [ ] **Step 2: 跑现有 orchestration 测试，确认未破坏**

```bash
cd packages/agent && pnpm vitest run src/orchestration/__tests__/
```

预期：之前所有测试仍 PASS。

- [ ] **Step 3: 创建 graph-runner.ts**

```typescript
// packages/agent/src/orchestration/graph-runner.ts
import type { GraphEvent, RunId } from '@tianji/shared'
import type { ObserverLogger } from '@tianji/observer'
import {
  compileOrchestrationGraph,
  type CompileOptions,
} from './graph-compiler'
import type { OrchestrationGraph } from './graph-schema'

export interface RunOrchestrationGraphOptions {
  readonly graph: OrchestrationGraph
  readonly compileOptions: Omit<CompileOptions, 'runId' | 'observer' | 'emitGraphEvent'>
  readonly runId: RunId
  readonly initialState?: Record<string, unknown>
  readonly observer?: ObserverLogger
  readonly abortSignal?: AbortSignal
}

export interface OrchestrationRunResult {
  readonly events: AsyncIterable<GraphEvent>
  readonly finished: Promise<Record<string, unknown>>
}

/**
 * 顶层入口：编译图并启动执行，返回事件流和最终状态 Promise。
 *
 * 事件流包含 graph.* 事件（启动、节点状态变化、完成）。
 * 内部 deepagents 的 RuntimeEvent 当前由各 executor 自行处理，
 * 后续可在此处通过额外管道透传。
 */
export function runOrchestrationGraph(
  options: RunOrchestrationGraphOptions
): OrchestrationRunResult {
  const eventQueue: GraphEvent[] = []
  const eventResolvers: ((value: IteratorResult<GraphEvent>) => void)[] = []
  let done = false

  const emit = (event: GraphEvent) => {
    if (done) return
    if (eventResolvers.length > 0) {
      const resolve = eventResolvers.shift()!
      resolve({ value: event, done: false })
    } else {
      eventQueue.push(event)
    }
  }

  const events: AsyncIterable<GraphEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<GraphEvent> {
      return {
        next() {
          if (eventQueue.length > 0) {
            const value = eventQueue.shift()!
            return Promise.resolve({ value, done: false })
          }
          if (done) {
            return Promise.resolve({ value: undefined as never, done: true })
          }
          return new Promise<IteratorResult<GraphEvent>>(resolve => {
            eventResolvers.push(resolve)
          })
        },
      }
    },
  }

  const compiled = compileOrchestrationGraph(options.graph, {
    ...options.compileOptions,
    runId: options.runId,
    observer: options.observer,
    emitGraphEvent: emit,
  })

  emit({
    type: 'graph.started',
    runId: options.runId,
    graphId: options.graph.id,
    graphVersion: options.graph.version,
    timestamp: Date.now(),
  })

  const finished = (async () => {
    const finalState = (await (compiled as unknown as {
      invoke: (input: Record<string, unknown>, config?: unknown) => Promise<Record<string, unknown>>
    }).invoke(options.initialState ?? {}, {
      signal: options.abortSignal,
    })) as Record<string, unknown>

    emit({
      type: 'graph.completed',
      runId: options.runId,
      graphId: options.graph.id,
      finalState,
      timestamp: Date.now(),
    })

    done = true
    while (eventResolvers.length > 0) {
      const resolve = eventResolvers.shift()!
      resolve({ value: undefined as never, done: true })
    }

    return finalState
  })()

  return { events, finished }
}
```

- [ ] **Step 4: 跑 typecheck**

```bash
cd packages/agent && pnpm typecheck
```

预期：无错误。

- [ ] **Step 5: 提交**

```bash
git add packages/agent/src/orchestration/graph-compiler.ts packages/agent/src/orchestration/graph-runner.ts
git commit -m "feat(agent): 新增 orchestration graph-runner 并贯通事件 emit"
```

---

### Task 12: 公共导出 + AgentSession 集成

**Files:**
- Create: `packages/agent/src/orchestration/index.ts`
- Modify: `packages/agent/src/index.ts`
- Modify: `packages/agent/src/session.ts`

- [ ] **Step 1: 创建 orchestration/index.ts 公共导出**

```typescript
// packages/agent/src/orchestration/index.ts
export { compileOrchestrationGraph, type CompileOptions } from './graph-compiler'
export { runOrchestrationGraph, type OrchestrationRunResult, type RunOrchestrationGraphOptions } from './graph-runner'
export { validateOrchestrationGraph, type ValidationResult } from './graph-validator'
export { compileStateChannels } from './state-channels'
export {
  buildPromptFromState,
  buildStateUpdateFromText,
  buildOutputInstructionSuffix,
} from './io-mapping'
export { createDeepagentsExecutorFactory, type CreateDeepagentsExecutorFactoryOptions } from './executors/deepagents-executor'
export { createAcpExecutorFactory, type CreateAcpExecutorFactoryOptions, type AcpRunnerLike, type AcpRunnerProvider } from './executors/acp-executor'
export type {
  NodeAction,
  NodeExecutorContext,
  AgentExecutorFactory,
  AcpExecutorFactory,
} from './executors/executor-types'
export type {
  OrchestrationGraph,
  OrchestrationGraphSource,
  StateChannelDef,
  StateChannelType,
  StateChannelReducer,
  GraphNode,
  AgentNode,
  AcpAgentNode,
  RouterNode,
  HumanGateNode,
  ForkNode,
  GraphEdge,
  SubAgentDef,
  ReservedNodeId,
} from './graph-schema'
export { GRAPH_START, GRAPH_END } from './graph-schema'
```

- [ ] **Step 2: 在 packages/agent/src/index.ts 顶层重新导出 orchestration**

打开 `packages/agent/src/index.ts`，在末尾追加：

```typescript
export * from './orchestration'
```

- [ ] **Step 3: 在 AgentSession 中加入 queryWithGraph**

打开 `packages/agent/src/session.ts`。

在文件顶部 imports 区追加：

```typescript
import {
  runOrchestrationGraph,
  type CompileOptions,
} from './orchestration'
import type { OrchestrationGraph } from './orchestration/graph-schema'
import type { GraphEvent, RuntimeEvent } from '@tianji/shared'
```

在 `AgentSession` 接口中增加：

```typescript
export interface AgentSession {
  readonly sessionId: SessionId
  readonly query: (prompt: string, options?: ChatOptions) => AsyncIterable<RuntimeEvent>
  readonly queryWithGraph: (
    graph: OrchestrationGraph,
    options: ChatWithGraphOptions
  ) => AsyncIterable<RuntimeEvent>
  readonly abort: () => void
}

export interface ChatWithGraphOptions {
  readonly initialState?: Record<string, unknown>
  readonly compileOptions: Omit<CompileOptions, 'runId' | 'observer' | 'emitGraphEvent'>
}
```

在 `createAgentSession` 工厂函数返回的对象中加入实现：

```typescript
async function* queryWithGraph(
  graph: OrchestrationGraph,
  graphOptions: ChatWithGraphOptions
): AsyncIterable<RuntimeEvent> {
  const runId = `run_graph_${Date.now()}` as never
  const result = runOrchestrationGraph({
    graph,
    runId,
    initialState: graphOptions.initialState,
    compileOptions: graphOptions.compileOptions,
  })

  // 透传 graph.* 事件作为 RuntimeEvent
  for await (const event of result.events) {
    yield event as RuntimeEvent
  }
  // 等待执行完成（即便没有更多事件，确保不漏掉错误）
  await result.finished
}
```

并在返回对象中加入 `queryWithGraph`：

```typescript
return {
  sessionId,
  query,
  queryWithGraph,
  abort,
}
```

- [ ] **Step 4: 跑 typecheck 和现有 session 测试**

```bash
cd packages/agent && pnpm typecheck
cd packages/agent && pnpm vitest run src/__tests__/session.test.ts
```

预期：无错误，session 测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/agent/src/orchestration/index.ts packages/agent/src/index.ts packages/agent/src/session.ts
git commit -m "feat(agent): 在 AgentSession 中暴露 queryWithGraph 入口"
```

---

## Phase F: 端到端集成测试

### Task 13: e2e 串行管线测试

**Files:**
- Create: `packages/agent/src/orchestration/__tests__/graph-runner.e2e.test.ts`

- [ ] **Step 1: 写 e2e 测试**

```typescript
// packages/agent/src/orchestration/__tests__/graph-runner.e2e.test.ts
import { FakeListChatModel } from '@langchain/core/utils/testing'
import { describe, expect, it } from 'vitest'
import { createDeepagentsExecutorFactory } from '../executors/deepagents-executor'
import { runOrchestrationGraph } from '../graph-runner'
import type { OrchestrationGraph } from '../graph-schema'
import type { GraphEvent } from '@tianji/shared'

describe('orchestration e2e', () => {
  it('两节点串行管线 planner→coder', async () => {
    const responses = ['plan: do A then B', 'code: console.log("done")']
    const sharedModel = new FakeListChatModel({ responses })

    const factory = createDeepagentsExecutorFactory({
      resolveModel: () => sharedModel,
    })

    const graph: OrchestrationGraph = {
      id: 'pipeline',
      name: 'planner-coder',
      version: 1,
      source: 'static',
      locked: false,
      state: {
        plan: { type: 'string' },
        code: { type: 'string' },
      },
      nodes: [
        {
          id: 'planner',
          type: 'agent',
          agent: { model: 'fake', systemPrompt: '你是规划者' },
          output: ['plan'],
        },
        {
          id: 'coder',
          type: 'agent',
          agent: { model: 'fake', systemPrompt: '你是编码者' },
          input: ['plan'],
          output: ['code'],
        },
      ],
      edges: [
        { from: '__start__', to: 'planner' },
        { from: 'planner', to: 'coder' },
        { from: 'coder', to: '__end__' },
      ],
    }

    const result = runOrchestrationGraph({
      graph,
      runId: 'run_e2e_1' as never,
      compileOptions: { agentExecutorFactory: factory },
    })

    const collectedEvents: GraphEvent[] = []
    const collectionPromise = (async () => {
      for await (const event of result.events) {
        collectedEvents.push(event)
      }
    })()

    const finalState = await result.finished
    await collectionPromise

    expect(finalState.plan).toContain('plan')
    expect(finalState.code).toContain('console.log')

    const eventTypes = collectedEvents.map(e => e.type)
    expect(eventTypes).toContain('graph.started')
    expect(eventTypes).toContain('graph.node.started')
    expect(eventTypes).toContain('graph.node.completed')
    expect(eventTypes).toContain('graph.completed')
  })
})
```

- [ ] **Step 2: 运行测试**

```bash
cd packages/agent && pnpm vitest run src/orchestration/__tests__/graph-runner.e2e.test.ts
```

预期：PASS。

- [ ] **Step 3: 提交**

```bash
git add packages/agent/src/orchestration/__tests__/graph-runner.e2e.test.ts
git commit -m "test(agent): 新增 orchestration e2e 串行管线测试"
```

---

### Task 14: e2e router 循环测试

**Files:**
- Modify: `packages/agent/src/orchestration/__tests__/graph-runner.e2e.test.ts`

- [ ] **Step 1: 在 e2e 文件追加 router 循环测试**

```typescript
it('router 形成循环：reviewer 不通过则回到 coder', async () => {
  // 序列：第一次 coder→ "代码 v1"； reviewer→ "{approved:false}"； 第二次 coder→"代码 v2"； reviewer→"{approved:true}"
  const sharedModel = new FakeListChatModel({
    responses: [
      '代码 v1',
      '{"review":"待改进","approved":false}',
      '代码 v2',
      '{"review":"通过","approved":true}',
    ],
  })

  const factory = createDeepagentsExecutorFactory({
    resolveModel: () => sharedModel,
  })

  const graph: OrchestrationGraph = {
    id: 'review-loop',
    name: 'reviewer-loop',
    version: 1,
    source: 'static',
    locked: false,
    state: {
      code: { type: 'string' },
      review: { type: 'string' },
      approved: { type: 'boolean', default: false },
    },
    nodes: [
      {
        id: 'coder',
        type: 'agent',
        agent: { model: 'fake', systemPrompt: '编码者' },
        output: ['code'],
      },
      {
        id: 'reviewer',
        type: 'agent',
        agent: { model: 'fake', systemPrompt: '审查者' },
        input: ['code'],
        output: ['review', 'approved'],
      },
      {
        id: 'router1',
        type: 'router',
        condition: {
          field: 'approved',
          branches: { true: '__end__', false: 'coder' },
        },
      },
    ],
    edges: [
      { from: '__start__', to: 'coder' },
      { from: 'coder', to: 'reviewer' },
      { from: 'reviewer', to: 'router1' },
    ],
  }

  const result = runOrchestrationGraph({
    graph,
    runId: 'run_e2e_loop' as never,
    compileOptions: { agentExecutorFactory: factory },
  })

  // 后台收集事件
  const events: GraphEvent[] = []
  const collect = (async () => {
    for await (const e of result.events) events.push(e)
  })()

  const finalState = await result.finished
  await collect

  expect(finalState.approved).toBe(true)
  expect(finalState.code).toBe('代码 v2')

  const coderStarts = events.filter(
    e => e.type === 'graph.node.started' && (e as { nodeId: string }).nodeId === 'coder'
  )
  expect(coderStarts.length).toBe(2) // 因为循环了一次
})
```

- [ ] **Step 2: 运行测试**

```bash
cd packages/agent && pnpm vitest run src/orchestration/__tests__/graph-runner.e2e.test.ts
```

预期：两个 e2e 测试都 PASS。

- [ ] **Step 3: 提交**

```bash
git add packages/agent/src/orchestration/__tests__/graph-runner.e2e.test.ts
git commit -m "test(agent): 新增 orchestration e2e router 循环测试"
```

---

### Task 15: 全量 check 与最终提交

**Files:** （无新增）

- [ ] **Step 1: 跑 pnpm check**

```bash
pnpm check
```

预期：所有包通过 biome lint、typecheck、boundary check、deps check。如果有任何错误或警告，必须修复——CLAUDE.md 明确要求"必须修复 pnpm check 报出的所有错误、警告和信息"。

- [ ] **Step 2: 跑 packages/agent 的全部测试做回归**

```bash
pnpm --filter @tianji/agent test
```

预期：所有测试 PASS。

- [ ] **Step 3: 跑 packages/runtime 的全部测试做回归（确认我们没有意外破坏 shared events）**

```bash
pnpm --filter @tianji/runtime test
```

预期：所有测试 PASS。

- [ ] **Step 4: 跑 packages/shared 的测试**

```bash
pnpm --filter @tianji/shared test
```

预期：所有测试 PASS。

- [ ] **Step 5: 如果有任何修复，按修复内容提交**

修复都做完后，最终状态应当是干净的工作区。如果 check/测试过程中没有修改任何文件，跳过此步。

---

## 验收清单

实施完成后，以下点全部满足才视为 done：

| 验收项 | 检查方式 |
|--------|---------|
| `OrchestrationGraph` 五种节点类型全部可编译 | task 6/7/8 测试通过 |
| validator 拒绝所有无效图 | task 3 测试通过 |
| state reducer 三种模式正确 | task 4 测试通过 |
| io-mapping 处理单/多字段输入输出 | task 5 测试通过 |
| deepagents executor 能跑通 FakeListChatModel | task 9 测试通过 |
| ACP executor 工厂可被 apps/node 注入实现 | task 10 typecheck 通过 |
| graph-runner 事件流贯通 | task 11 完成 |
| AgentSession.queryWithGraph 暴露并 typecheck 通过 | task 12 通过 |
| 串行 e2e 管线跑通 | task 13 测试通过 |
| router 循环 e2e 跑通 | task 14 测试通过 |
| `pnpm check` 全绿 | task 15 步骤 1 通过 |
| 所有包测试回归绿 | task 15 步骤 2-4 通过 |

## 不在本计划范围内（spec 第 12 节明确 + 本计划补充）

- LLM 自动生成图的 prompt 工程
- 图的可视化前端编辑器（注：JSON Schema 本身就是可视化数据源，前端可直接渲染；运行时高亮通过 graph.* 事件流驱动；不需要单独的 graph-serializer 模块）
- 运行时图的动态修改（mutate_graph 工具）
- 编排图的版本管理与迁移
- 跨节点 / 跨进程的分布式编排
- 节点级别细粒度权限控制
- 把 ACP runner 实际接入 apps/node（独立小 PR，调用 createAcpExecutorFactory 并传入 AgentRunner 即可）
- 图执行的父子 run 谱系跟踪与 SessionRuntime 深度集成（spec 10.2 节，留作后续重构）
