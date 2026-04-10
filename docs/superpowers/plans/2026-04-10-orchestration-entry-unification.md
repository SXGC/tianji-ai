# 编排入口统一 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除 `session.query` 单 agent 路径，所有入口统一走 `session.queryWithGraph`，新增图加载器和 systemPrompt 构建器，实现 RuntimeEvent 透传。

**Architecture:** 新增 graph-loader 从 JSON 加载编排图并展开 agent name 为完整配置；新增 system-prompt-builder 拼接 SOUL.md + AGENTS.md；改造 executor/graph-runner 透传内部 RuntimeEvent；最后将 daemon-server/InProcessAgentRunner/controlplane-runtime 入口从 session.query 切换到 session.queryWithGraph。

**Tech Stack:** TypeScript, Vitest, LangGraph (@langchain/langgraph), @tianji/shared, @tianji/runtime

**Spec:** `docs/superpowers/specs/2026-04-10-orchestration-entry-unification-design.md`

---

### Task 1: systemPrompt 构建器

**Files:**
- Create: `packages/agent/src/orchestration/system-prompt-builder.ts`
- Test: `packages/agent/src/orchestration/__tests__/system-prompt-builder.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/agent/src/orchestration/__tests__/system-prompt-builder.test.ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildSystemPrompt } from '../system-prompt-builder.js'

describe('buildSystemPrompt', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tianji-prompt-builder-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('AGENTS.md 不存在时只返回 soul 块', async () => {
    const soulPath = join(tempDir, 'SOUL.md')
    await writeFile(soulPath, '# Agent\nYou are helpful.\n', 'utf8')

    const result = await buildSystemPrompt({
      soulPath,
      workspace: join(tempDir, 'nonexistent-workspace'),
    })

    expect(result).toContain('<agent_soul>')
    expect(result).toContain('# Agent')
    expect(result).toContain('You are helpful.')
    expect(result).toContain('</agent_soul>')
    expect(result).not.toContain('<workspace_agents_md>')
  })

  it('AGENTS.md 存在时正确拼接两个块', async () => {
    const soulPath = join(tempDir, 'SOUL.md')
    await writeFile(soulPath, 'Soul content here.\n', 'utf8')

    const workspace = join(tempDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'AGENTS.md'), 'Workspace rules here.\n', 'utf8')

    const result = await buildSystemPrompt({ soulPath, workspace })

    expect(result).toContain('<agent_soul>')
    expect(result).toContain('Soul content here.')
    expect(result).toContain('</agent_soul>')
    expect(result).toContain('<workspace_agents_md>')
    expect(result).toContain('Workspace rules here.')
    expect(result).toContain('</workspace_agents_md>')

    // soul 在前，agents.md 在后
    const soulIndex = result.indexOf('<agent_soul>')
    const agentsIndex = result.indexOf('<workspace_agents_md>')
    expect(soulIndex).toBeLessThan(agentsIndex)
  })

  it('SOUL.md 不存在时报错（由 loadAgentSoul 保证）', async () => {
    const missingSoulPath = join(tempDir, 'missing-SOUL.md')

    await expect(
      buildSystemPrompt({ soulPath: missingSoulPath, workspace: tempDir })
    ).rejects.toThrow(/soul/i)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/agent && pnpm vitest run system-prompt-builder`
Expected: FAIL — module `../system-prompt-builder.js` does not exist

- [ ] **Step 3: Write implementation**

```typescript
// packages/agent/src/orchestration/system-prompt-builder.ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { loadAgentSoul } from '@tianji/shared'

export interface BuildSystemPromptOptions {
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
 * 3. 返回结构化 XML 块拼接结果
 *
 * @param options - 构建配置
 * @returns 拼接后的 systemPrompt 字符串
 */
export async function buildSystemPrompt(options: BuildSystemPromptOptions): Promise<string> {
  const soulContent = await loadAgentSoul(options.soulPath)

  const agentsContent = await tryReadFile(join(options.workspace, 'AGENTS.md'))

  let prompt = `<agent_soul>\n${soulContent}\n</agent_soul>`

  if (agentsContent !== null) {
    prompt += `\n\n<workspace_agents_md>\n${agentsContent}\n</workspace_agents_md>`
  }

  return prompt
}

async function tryReadFile(filePath: string): Promise<string | null> {
  try {
    const content = await readFile(filePath, 'utf8')
    return content.trim().length > 0 ? content : null
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/agent && pnpm vitest run system-prompt-builder`
Expected: 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/orchestration/system-prompt-builder.ts packages/agent/src/orchestration/__tests__/system-prompt-builder.test.ts
git commit -m "feat(agent): systemPrompt 构建器拼接 SOUL.md + AGENTS.md"
```

---

### Task 2: 图加载器

**Files:**
- Create: `packages/agent/src/orchestration/graph-loader.ts`
- Test: `packages/agent/src/orchestration/__tests__/graph-loader.test.ts`

**Depends on:** Task 1 (system-prompt-builder)

- [ ] **Step 1: Write the failing tests**

```typescript
// packages/agent/src/orchestration/__tests__/graph-loader.test.ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TianjiAgentConfig } from '@tianji/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadDefaultOrchestrationGraph } from '../graph-loader.js'

describe('loadDefaultOrchestrationGraph', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tianji-graph-loader-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  /** 写好一份最小可用的 configDir 文件集：JSON + SOUL.md */
  async function writeMinimalConfig(
    graphJson: Record<string, unknown>,
    agentName = 'default'
  ): Promise<void> {
    await writeFile(
      join(tempDir, 'default-orchestration.json'),
      JSON.stringify(graphJson),
      'utf8'
    )
    const agentDir = join(tempDir, 'agents', agentName)
    await mkdir(agentDir, { recursive: true })
    await writeFile(join(agentDir, 'SOUL.md'), 'You are a test agent.\n', 'utf8')
  }

  it('正常加载并展开 native agent 节点', async () => {
    await writeMinimalConfig({
      id: 'test',
      name: 'test-graph',
      version: 1,
      source: 'static',
      locked: false,
      state: { input: { type: 'string' }, output: { type: 'string' } },
      nodes: [
        { id: 'worker', type: 'agent', agent: 'default', input: ['input'], output: ['output'] },
      ],
      edges: [
        { from: '__start__', to: 'worker' },
        { from: 'worker', to: '__end__' },
      ],
    })

    const configs: Record<string, TianjiAgentConfig> = {
      default: { model: 'openai/gpt-4' },
    }

    const graph = await loadDefaultOrchestrationGraph({
      configDir: tempDir,
      agentConfigs: configs,
    })

    expect(graph.id).toBe('test')
    const agentNode = graph.nodes.find((n) => n.id === 'worker')
    expect(agentNode).toBeDefined()
    expect(agentNode!.type).toBe('agent')
    if (agentNode!.type === 'agent') {
      expect(agentNode!.agent.model).toBe('openai/gpt-4')
      expect(agentNode!.agent.systemPrompt).toContain('You are a test agent.')
    }
  })

  it('default-orchestration.json 不存在时报错', async () => {
    await expect(
      loadDefaultOrchestrationGraph({
        configDir: tempDir,
        agentConfigs: {},
      })
    ).rejects.toThrow(/default-orchestration\.json/)
  })

  it('引用不存在的 agent name 时报错', async () => {
    await writeMinimalConfig({
      id: 'test',
      name: 'test',
      version: 1,
      source: 'static',
      locked: false,
      state: {},
      nodes: [{ id: 'w', type: 'agent', agent: 'nonexistent' }],
      edges: [{ from: '__start__', to: 'w' }, { from: 'w', to: '__end__' }],
    })

    await expect(
      loadDefaultOrchestrationGraph({
        configDir: tempDir,
        agentConfigs: { default: { model: 'openai/gpt-4' } },
      })
    ).rejects.toThrow(/nonexistent/)
  })

  it('引用 external agent 时报错', async () => {
    await writeMinimalConfig({
      id: 'test',
      name: 'test',
      version: 1,
      source: 'static',
      locked: false,
      state: {},
      nodes: [{ id: 'w', type: 'agent', agent: 'ext' }],
      edges: [{ from: '__start__', to: 'w' }, { from: 'w', to: '__end__' }],
    })

    const configs: Record<string, TianjiAgentConfig> = {
      ext: { command: 'claude' },
    }

    await expect(
      loadDefaultOrchestrationGraph({
        configDir: tempDir,
        agentConfigs: configs,
      })
    ).rejects.toThrow(/external.*acp-agent/i)
  })

  it('非 agent 节点原样透传', async () => {
    await writeMinimalConfig({
      id: 'test',
      name: 'test',
      version: 1,
      source: 'static',
      locked: false,
      state: { input: { type: 'string' }, output: { type: 'string' } },
      nodes: [
        { id: 'worker', type: 'agent', agent: 'default', input: ['input'], output: ['output'] },
        { id: 'gate', type: 'human-gate', prompt: 'approve?' },
      ],
      edges: [
        { from: '__start__', to: 'worker' },
        { from: 'worker', to: 'gate' },
        { from: 'gate', to: '__end__' },
      ],
    })

    const graph = await loadDefaultOrchestrationGraph({
      configDir: tempDir,
      agentConfigs: { default: { model: 'openai/gpt-4' } },
    })

    const gateNode = graph.nodes.find((n) => n.id === 'gate')
    expect(gateNode).toBeDefined()
    expect(gateNode!.type).toBe('human-gate')
    if (gateNode!.type === 'human-gate') {
      expect(gateNode!.prompt).toBe('approve?')
    }
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/agent && pnpm vitest run graph-loader`
Expected: FAIL — module `../graph-loader.js` does not exist

- [ ] **Step 3: Write implementation**

```typescript
// packages/agent/src/orchestration/graph-loader.ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  type TianjiAgentConfig,
  getAgentSoulPath,
  resolveAgentType,
} from '@tianji/shared'

import type { GraphNode, OrchestrationGraph } from './graph-schema.js'
import { buildSystemPrompt } from './system-prompt-builder.js'

export interface GraphLoaderOptions {
  /** configDir，用于定位 default-orchestration.json 和各 agent 的 SOUL.md */
  readonly configDir: string
  /** tianji.config.json 中 agents.items 的完整配置 */
  readonly agentConfigs: Readonly<Record<string, TianjiAgentConfig>>
}

/**
 * JSON 文件中 agent 节点的 agent 字段是 string（agent name），
 * 与最终 OrchestrationGraph 的 AgentNode.agent 对象不同。
 */
interface RawAgentNode {
  readonly id: string
  readonly type: 'agent'
  readonly agent: string
  readonly input?: readonly string[]
  readonly output?: readonly string[]
}

interface RawOrchestrationGraph {
  readonly id: string
  readonly name: string
  readonly version: number
  readonly source: string
  readonly locked: boolean
  readonly state: Record<string, unknown>
  readonly nodes: readonly (RawAgentNode | Record<string, unknown>)[]
  readonly edges: readonly { readonly from: string; readonly to: string }[]
}

/**
 * 加载 <configDir>/default-orchestration.json 并展开 agent name 为完整 AgentNode.agent 对象。
 *
 * - agent 节点只允许引用 native agent；external agent 必须用 acp-agent 节点。
 * - 当前只从 TianjiAgentConfig 展开 model + systemPrompt；tools/subagents/skills 留 undefined。
 *
 * @throws 文件不存在、agent name 找不到、agent 是 external 类型、native agent 无 model
 */
export async function loadDefaultOrchestrationGraph(
  options: GraphLoaderOptions
): Promise<OrchestrationGraph> {
  const jsonPath = join(options.configDir, 'default-orchestration.json')

  let rawJson: string
  try {
    rawJson = await readFile(jsonPath, 'utf8')
  } catch {
    throw new Error(
      `Default orchestration graph file does not exist: ${jsonPath}`
    )
  }

  const raw = JSON.parse(rawJson) as RawOrchestrationGraph
  const expandedNodes: GraphNode[] = []

  for (const node of raw.nodes) {
    if (isRawAgentNode(node)) {
      expandedNodes.push(await expandAgentNode(node, options))
    } else {
      expandedNodes.push(node as GraphNode)
    }
  }

  return {
    id: raw.id,
    name: raw.name,
    version: raw.version,
    source: raw.source as OrchestrationGraph['source'],
    locked: raw.locked,
    state: raw.state as OrchestrationGraph['state'],
    nodes: expandedNodes,
    edges: raw.edges,
  }
}

function isRawAgentNode(node: Record<string, unknown> | RawAgentNode): node is RawAgentNode {
  return node.type === 'agent' && typeof node.agent === 'string'
}

async function expandAgentNode(
  raw: RawAgentNode,
  options: GraphLoaderOptions
): Promise<GraphNode> {
  const agentName = raw.agent
  const config = options.agentConfigs[agentName]

  if (config === undefined) {
    throw new Error(
      `Agent node "${raw.id}" references unknown agent "${agentName}". ` +
      `Available agents: ${Object.keys(options.agentConfigs).join(', ') || '(none)'}`
    )
  }

  if (resolveAgentType(config) === 'external') {
    throw new Error(
      `Agent node "${raw.id}" references external agent "${agentName}". ` +
      `Use acp-agent node type instead.`
    )
  }

  if (config.model === undefined) {
    throw new Error(
      `Agent node "${raw.id}" references agent "${agentName}" which has no model configured.`
    )
  }

  const soulPath = getAgentSoulPath(options.configDir, agentName)
  const workspace = config.workspace ?? process.cwd()
  const systemPrompt = await buildSystemPrompt({ soulPath, workspace })

  return {
    id: raw.id,
    type: 'agent',
    agent: {
      model: config.model,
      systemPrompt,
    },
    input: raw.input,
    output: raw.output,
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/agent && pnpm vitest run graph-loader`
Expected: 5 tests PASS

- [ ] **Step 5: Run pnpm check**

Run: `pnpm check`
Expected: 全部通过

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/orchestration/graph-loader.ts packages/agent/src/orchestration/__tests__/graph-loader.test.ts
git commit -m "feat(agent): 图加载器从 JSON 加载编排图并展开 agent name"
```

---

### Task 3: RuntimeEvent 透传 — executor-types + deepagents-executor

**Files:**
- Modify: `packages/agent/src/orchestration/executors/executor-types.ts:14-19`
- Modify: `packages/agent/src/orchestration/executors/deepagents-executor.ts:110,195-204`
- Modify: `packages/agent/src/orchestration/__tests__/deepagents-executor.test.ts`

- [ ] **Step 1: Write the failing test**

在 `packages/agent/src/orchestration/__tests__/deepagents-executor.test.ts` 末尾追加：

```typescript
  it('透传内部 RuntimeEvent 到 emitRuntimeEvent 回调', async () => {
    const runtimeEvents: RuntimeEvent[] = []
    const ctx = makeCtx({
      emitRuntimeEvent: (event) => runtimeEvents.push(event),
    })
    const factory = createDeepagentsExecutorFactory({
      resolveModel: () => new FakeListChatModel({ responses: ['result text'] }),
    })
    const node = makeAgentNode({ input: ['q'], output: ['a'] })
    const action = factory(node, ctx)
    await action({ q: 'x' }, {} as never)

    // deepagents runtime 至少会发出 run.started 和 run.completed
    const types = runtimeEvents.map((e) => e.type)
    expect(types).toContain('run.started')
    expect(types).toContain('run.completed')
  })

  it('emitRuntimeEvent 未提供时不报错（向后兼容）', async () => {
    const ctx = makeCtx() // 没有 emitRuntimeEvent
    const factory = createDeepagentsExecutorFactory({
      resolveModel: () => new FakeListChatModel({ responses: ['ok'] }),
    })
    const node = makeAgentNode({ input: ['q'], output: ['a'] })
    const action = factory(node, ctx)

    // 不报错即通过
    await expect(action({ q: 'x' }, {} as never)).resolves.toBeDefined()
  })
```

同时在文件顶部导入补充 `RuntimeEvent`：

```typescript
import type { GraphEvent, RunId, RuntimeEvent } from '@tianji/shared'
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent && pnpm vitest run deepagents-executor`
Expected: FAIL — `emitRuntimeEvent` 不在 `NodeExecutorContext` 类型中

- [ ] **Step 3: 修改 executor-types.ts 新增 emitRuntimeEvent**

在 `packages/agent/src/orchestration/executors/executor-types.ts` 的 `NodeExecutorContext` 接口中新增：

```typescript
import type { GraphEvent, RunId, RuntimeEvent } from '@tianji/shared'
// ...
export interface NodeExecutorContext {
  readonly runId: RunId
  readonly graphId: string
  readonly observer?: ObserverLogger
  readonly emitGraphEvent: (event: GraphEvent) => void
  readonly emitRuntimeEvent?: (event: RuntimeEvent) => void
  readonly abortSignal?: AbortSignal
}
```

（删除原有的 `import type { GraphEvent, RunId } from '@tianji/shared'`，换成新的带 `RuntimeEvent` 的导入。）

- [ ] **Step 4: 修改 deepagents-executor.ts 的 collectFinalAssistantText 透传事件**

把 `collectFinalAssistantText` 函数签名改为接收回调：

```typescript
async function collectFinalAssistantText(
  runtime: SessionRuntime,
  runId: RunId,
  onEvent?: (event: RuntimeEvent) => void
): Promise<string> {
  let finalText = ''
  const events: AsyncIterable<RuntimeEvent> = runtime.streamEvents(runId)
  for await (const event of events) {
    onEvent?.(event)
    if (event.type === 'message.completed' && event.message.role === 'assistant') {
      finalText = extractTextFromMessage(event.message)
    }
  }
  return finalText
}
```

把调用处（第 110 行附近）从：

```typescript
const finalAssistantText = await collectFinalAssistantText(runtime, runId)
```

改为：

```typescript
const finalAssistantText = await collectFinalAssistantText(
  runtime,
  runId,
  ctx.emitRuntimeEvent
)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd packages/agent && pnpm vitest run deepagents-executor`
Expected: 6 tests PASS（含 2 个新增）

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/orchestration/executors/executor-types.ts packages/agent/src/orchestration/executors/deepagents-executor.ts packages/agent/src/orchestration/__tests__/deepagents-executor.test.ts
git commit -m "feat(agent): deepagents-executor 透传 RuntimeEvent 到外层流"
```

---

### Task 4: RuntimeEvent 透传 — acp-executor

**Files:**
- Modify: `packages/agent/src/orchestration/executors/acp-executor.ts:85-95`

- [ ] **Step 1: Write the failing test**

在现有的 `packages/agent/src/orchestration/__tests__/` 下，如果没有 `acp-executor.test.ts`，检查是否存在。如果不存在则创建。核心测试：

```typescript
// packages/agent/src/orchestration/__tests__/acp-executor.test.ts
import type { RunId, RuntimeEvent } from '@tianji/shared'
import { describe, expect, it, vi } from 'vitest'

import type { AcpAgentNode } from '../graph-schema.js'
import type { NodeExecutorContext } from '../executors/executor-types.js'
import { createAcpExecutorFactory, type AcpRunnerLike } from '../executors/acp-executor.js'

function makeCtx(overrides: Partial<NodeExecutorContext> = {}): NodeExecutorContext {
  return {
    runId: 'run_test' as RunId,
    graphId: 'g1',
    emitGraphEvent: vi.fn(),
    ...overrides,
  }
}

function makeAcpNode(overrides: Partial<AcpAgentNode> = {}): AcpAgentNode {
  return {
    id: 'acp1',
    type: 'acp-agent',
    acp: {},
    ...overrides,
  }
}

function makeFakeRunner(responses: string[]): AcpRunnerLike {
  let callIndex = 0
  return {
    connect: vi.fn(async () => {}),
    async *query(): AsyncIterable<RuntimeEvent> {
      const text = responses[callIndex] ?? ''
      callIndex += 1
      yield {
        type: 'run.started',
        runId: 'inner_run' as RunId,
        sessionId: 'inner_session' as never,
        triggerType: 'new',
        timestamp: Date.now(),
      }
      yield {
        type: 'message.completed',
        runId: 'inner_run' as RunId,
        sessionId: 'inner_session' as never,
        messageId: 'msg1',
        message: {
          id: 'msg1',
          role: 'assistant',
          content: [{ type: 'text', text }],
          createdAt: Date.now(),
        },
        timestamp: Date.now(),
      } as RuntimeEvent
      yield {
        type: 'run.completed',
        runId: 'inner_run' as RunId,
        sessionId: 'inner_session' as never,
        triggerType: 'new',
        timestamp: Date.now(),
      }
    },
    disconnect: vi.fn(async () => {}),
  }
}

describe('createAcpExecutorFactory', () => {
  it('透传内部 RuntimeEvent 到 emitRuntimeEvent 回调', async () => {
    const runtimeEvents: RuntimeEvent[] = []
    const runner = makeFakeRunner(['hello'])
    const factory = createAcpExecutorFactory({
      runnerProvider: () => runner,
    })
    const ctx = makeCtx({
      emitRuntimeEvent: (event) => runtimeEvents.push(event),
    })
    const node = makeAcpNode({ input: ['q'], output: ['a'] })
    const action = factory(node, ctx)
    await action({ q: 'test' }, {} as never)

    const types = runtimeEvents.map((e) => e.type)
    expect(types).toContain('run.started')
    expect(types).toContain('message.completed')
    expect(types).toContain('run.completed')
  })

  it('emitRuntimeEvent 未提供时不报错', async () => {
    const runner = makeFakeRunner(['ok'])
    const factory = createAcpExecutorFactory({
      runnerProvider: () => runner,
    })
    const node = makeAcpNode({ input: ['q'], output: ['a'] })
    const action = factory(node, makeCtx())

    await expect(action({ q: 'x' }, {} as never)).resolves.toBeDefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/agent && pnpm vitest run acp-executor`
Expected: FAIL — `emitRuntimeEvent` 类型不匹配或行为不符

- [ ] **Step 3: 修改 acp-executor.ts 在事件循环体内透传**

在 `packages/agent/src/orchestration/executors/acp-executor.ts` 第 87 行附近，把：

```typescript
        for await (const event of runner.query(fullPrompt)) {
            if (event.type === 'message.completed' && event.message.role === 'assistant') {
              accumulatedText = extractText(event.message)
            }
          }
```

改为：

```typescript
        for await (const event of runner.query(fullPrompt)) {
            ctx.emitRuntimeEvent?.(event)
            if (event.type === 'message.completed' && event.message.role === 'assistant') {
              accumulatedText = extractText(event.message)
            }
          }
```

（仅加一行 `ctx.emitRuntimeEvent?.(event)`。）

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/agent && pnpm vitest run acp-executor`
Expected: 2 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/orchestration/executors/acp-executor.ts packages/agent/src/orchestration/__tests__/acp-executor.test.ts
git commit -m "feat(agent): acp-executor 透传 RuntimeEvent 到外层流"
```

---

### Task 5: graph-runner 拓宽事件类型 + 注入 emitRuntimeEvent

**Files:**
- Modify: `packages/agent/src/orchestration/graph-runner.ts`
- Modify: `packages/agent/src/orchestration/__tests__/graph-runner.e2e.test.ts`

- [ ] **Step 1: 修改 graph-runner.ts**

把 `packages/agent/src/orchestration/graph-runner.ts` 做如下改动：

1. 导入类型从 `GraphEvent` 拓宽到 `RuntimeEvent`：

```typescript
import type { RuntimeEvent, RunId } from '@tianji/shared'
```

（删掉原有的 `import type { GraphEvent, RunId } from '@tianji/shared'`。）

2. 事件队列和解析器类型从 `GraphEvent` 改为 `RuntimeEvent`：

```typescript
const eventQueue: RuntimeEvent[] = []
const eventResolvers: ((value: IteratorResult<RuntimeEvent>) => void)[] = []
```

3. `emit` 函数签名改为：

```typescript
const emit = (event: RuntimeEvent): void => {
```

4. `events` 的类型改为 `AsyncIterable<RuntimeEvent>` 和 `AsyncIterator<RuntimeEvent>`：

```typescript
const events: AsyncIterable<RuntimeEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {
      return {
        next(): Promise<IteratorResult<RuntimeEvent>> {
```

5. `OrchestrationRunResult.events` 类型改为：

```typescript
export interface OrchestrationRunResult {
  readonly events: AsyncIterable<RuntimeEvent>
  readonly finished: Promise<Record<string, unknown>>
}
```

6. 修改 `RunOrchestrationGraphOptions.compileOptions` 的 Omit 列表，新增 `'emitRuntimeEvent'`（防止外部调用方被要求传入此字段，它由 runner 内部注入）：

```typescript
export interface RunOrchestrationGraphOptions {
  readonly graph: OrchestrationGraph
  readonly compileOptions: Omit<
    CompileOptions,
    'runId' | 'observer' | 'emitGraphEvent' | 'emitRuntimeEvent' | 'abortSignal'
  >
  // ...rest unchanged
}
```

8. 在 `compileOrchestrationGraph` 调用时注入 `emitRuntimeEvent: emit`。在第 83-89 行区域，把 `compileOptions` 展开后追加 `emitRuntimeEvent`：

注意：这需要同步改 `CompileOptions`（在 `graph-compiler.ts`）。但 `graph-compiler.ts` 只是把 `options` 直接塞进 `NodeExecutorContext`，所以要在 `CompileOptions` 里也加 `emitRuntimeEvent`。

修改 `packages/agent/src/orchestration/graph-compiler.ts`：

在 `CompileOptions` 接口中新增：

```typescript
readonly emitRuntimeEvent?: (event: RuntimeEvent) => void
```

在 `compileOrchestrationGraph` 函数内构建 `ctx` 时新增：

```typescript
const ctx: NodeExecutorContext = {
    runId: options.runId,
    graphId: graph.id,
    observer: options.observer,
    emitGraphEvent: options.emitGraphEvent ?? (() => undefined),
    emitRuntimeEvent: options.emitRuntimeEvent,
    abortSignal: options.abortSignal,
  }
```

在 `graph-runner.ts` 的 compile 调用中传入 `emitRuntimeEvent: emit`：

```typescript
const compiled = compileOrchestrationGraph(options.graph, {
    ...options.compileOptions,
    runId: options.runId,
    observer: options.observer,
    emitGraphEvent: emit,
    emitRuntimeEvent: emit,
    abortSignal: options.abortSignal,
  })
```

9. 更新 tsdoc 注释，把"事件流包含 graph.* 事件"改为"事件流包含 graph.* 事件和节点内部的 RuntimeEvent（run.*/message.*/tool.*）"。

- [ ] **Step 2: 更新 graph-runner.e2e.test.ts**

把事件收集类型从 `GraphEvent[]` 改为 `RuntimeEvent[]`，导入从 `GraphEvent` 改为 `RuntimeEvent`：

```typescript
import type { RuntimeEvent, RunId } from '@tianji/shared'
```

两个测试里的 `const collectedEvents: GraphEvent[] = []` 和 `const events: GraphEvent[] = []` 全部改为 `RuntimeEvent[]`。

断言保持不变（graph.* 事件也是 RuntimeEvent 的成员）。

- [ ] **Step 3: Run all orchestration tests**

Run: `cd packages/agent && pnpm vitest run orchestration`
Expected: 全部 PASS

- [ ] **Step 4: Run pnpm check**

Run: `pnpm check`
Expected: 全部通过（graph-compiler.ts 的 CompileOptions 改动需要通过 typecheck）

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/orchestration/graph-runner.ts packages/agent/src/orchestration/graph-compiler.ts packages/agent/src/orchestration/__tests__/graph-runner.e2e.test.ts
git commit -m "feat(agent): graph-runner 事件流拓宽为 RuntimeEvent 并注入 emitRuntimeEvent"
```

---

### Task 6: orchestration index 导出新模块

**Files:**
- Modify: `packages/agent/src/orchestration/index.ts`

- [ ] **Step 1: 更新 index.ts 导出**

在 `packages/agent/src/orchestration/index.ts` 中新增导出：

```typescript
export {
  loadDefaultOrchestrationGraph,
  type GraphLoaderOptions,
} from './graph-loader.js'
export {
  buildSystemPrompt,
  type BuildSystemPromptOptions,
} from './system-prompt-builder.js'
```

同时把 `OrchestrationRunResult` 的导出注释确认与新类型一致（events 已经是 `AsyncIterable<RuntimeEvent>`）。

- [ ] **Step 2: Run pnpm check**

Run: `pnpm check`
Expected: 全部通过

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/orchestration/index.ts
git commit -m "chore(agent): orchestration index 导出 graph-loader 和 system-prompt-builder"
```

---

### Task 7: 删除 session.query，统一 queryWithGraph

**Files:**
- Modify: `packages/agent/src/session.ts`
- Modify: `packages/agent/src/index.ts`
- Modify: `packages/agent/src/__tests__/session.test.ts`

- [ ] **Step 1: 修改 session.ts**

1. 删除 `ChatOptions` 接口（第 23-25 行）。
2. 从 `AgentSession` 接口中删除 `query` 方法签名（第 46 行）。
3. 在 `createAgentSession` 返回对象中删除 `query` 方法的整个实现（第 125-151 行的 `async *query` 块）。
4. 删除 `abort()` 中对 `activeRunId` / `runtime.cancelRun` 的引用（第 107、116-118 行），只保留 `activeGraphControllers` 的 abort 逻辑。同时删除 `let activeRunId: RunId | null = null` 声明（第 107 行）。

保留 `queryWithGraph` 方法和 `ChatWithGraphOptions` 类型不变。

- [ ] **Step 2: 修改 packages/agent/src/index.ts**

删除 `ChatOptions` 的导出：

```typescript
export {
  createAgentRuntime,
  createAgentSession,
  type AgentRuntimeOptions,
  type AgentSession,
} from './session.js'
```

（去掉 `type ChatOptions`。）

- [ ] **Step 3: 修改 session.test.ts**

1. 删除第 130-204 行的 `it('creates a chat session that calls runtime with context soul', ...)` 测试（它测的是已删除的 `session.query`）。
2. `describe('agent session queryWithGraph', ...)` 部分保持不变。
3. 文件顶部如果有对 `ChatOptions` 的引用，删除。

- [ ] **Step 4: Run tests**

Run: `cd packages/agent && pnpm vitest run session`
Expected: 所有 queryWithGraph 测试 PASS，旧的 query 测试已删除

- [ ] **Step 5: Run pnpm check**

Run: `pnpm check`
Expected: 全部通过。检查其他包是否引用了 `ChatOptions` 或 `session.query`。如果有编译错误，需要在后续 Task 中处理（daemon-server、in-process-runner）。此时预期会有编译错误，因为 daemon-server 仍在调用 `this.#session.query`。这是预期内的，在 Task 8 修复。

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/session.ts packages/agent/src/index.ts packages/agent/src/__tests__/session.test.ts
git commit -m "refactor(agent): 删除 session.query 单 agent 入口，统一走 queryWithGraph"
```

---

### Task 8: DaemonServer 接入 defaultGraph + executorFactory

**Files:**
- Modify: `packages/agent/src/daemon-server.ts`
- Modify: `apps/node/src/__tests__/daemon-e2e.test.ts`
- Modify: `apps/node/src/__tests__/daemon-entry.test.ts`

- [ ] **Step 1: 修改 daemon-server.ts**

1. 新增导入：

```typescript
import type { AgentExecutorFactory, OrchestrationGraph } from './orchestration/index.js'
import type { ChatWithGraphOptions } from './session.js'
```

2. 修改 `DaemonServerOptions` 接口：

```typescript
export interface DaemonServerOptions {
  readonly session: AgentSession
  readonly defaultGraph: OrchestrationGraph
  readonly executorFactory: AgentExecutorFactory
  readonly paths?: Pick<AgentAppPaths, 'daemonPortPath' | 'daemonPidPath'>
  readonly getControlPlaneStatus?: () => ControlPlaneStatusSnapshot
}
```

3. 在 `DaemonServer` 类中新增私有字段和构造函数赋值：

```typescript
readonly #defaultGraph: OrchestrationGraph
readonly #executorFactory: AgentExecutorFactory

constructor(options: DaemonServerOptions) {
    this.#session = options.session
    this.#defaultGraph = options.defaultGraph
    this.#executorFactory = options.executorFactory
    // ...rest unchanged
}
```

4. 修改 `#handleChat`（第 186 行）：

```typescript
for await (const event of this.#session.queryWithGraph(this.#defaultGraph, {
        initialState: { input: parsed.prompt },
        compileOptions: { agentExecutorFactory: this.#executorFactory },
      })) {
```

- [ ] **Step 2: 更新 packages/agent/src/index.ts**

确保 `DaemonServerOptions` 的新字段类型被导出（`AgentExecutorFactory` 和 `OrchestrationGraph` 已经通过 `orchestration/index.ts` 导出）。

- [ ] **Step 3: 更新 daemon-e2e.test.ts 和 daemon-entry.test.ts**

这些测试构造 `DaemonServer` 时需要传入 `defaultGraph` 和 `executorFactory`。构造一个最小 stub：

在每个测试文件中，需要为 `DaemonServer` 构造增加必需参数。具体改法取决于每个测试如何构造 `DaemonServer`。先完整读取两个测试文件再做适配。

关键：提供一个 `defaultGraph`（可复用 `buildSingleNodeGraph()` 模式）和一个 `executorFactory`（`vi.fn()` 返回一个 pass-through action 即可）。

- [ ] **Step 4: Run tests**

Run: `cd apps/node && pnpm vitest run daemon`
Expected: PASS

- [ ] **Step 5: Run pnpm check**

Run: `pnpm check`
Expected: 可能 in-process-runner 和 daemon-entry 仍有编译错误（session.query 已删），Task 9-10 处理。

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/daemon-server.ts packages/agent/src/index.ts apps/node/src/__tests__/daemon-e2e.test.ts apps/node/src/__tests__/daemon-entry.test.ts
git commit -m "feat(agent): DaemonServer 接入 defaultGraph 和 executorFactory"
```

---

### Task 9: InProcessAgentRunner 接入 defaultGraph + executorFactory

**Files:**
- Modify: `apps/node/src/acp/in-process-runner.ts`
- Modify: `apps/node/src/__tests__/native-agent-integration.test.ts`
- Modify: `apps/node/src/__tests__/native-agent-error-recovery.test.ts`

- [ ] **Step 1: 修改 in-process-runner.ts**

1. 新增导入：

```typescript
import type { AgentExecutorFactory, OrchestrationGraph } from '@tianji/agent'
```

（`AgentExecutorFactory` 和 `OrchestrationGraph` 已经从 `@tianji/agent` 的 orchestration index 导出。）

2. 修改构造函数 config 类型和私有字段：

```typescript
readonly #defaultGraph: OrchestrationGraph
readonly #executorFactory: AgentExecutorFactory

constructor(config: {
    agentId: string
    nativeAgentContext: LoadedAgentContext
    runtimeOptions?: AgentRuntimeOptions
    defaultGraph: OrchestrationGraph
    executorFactory: AgentExecutorFactory
  }) {
    this.agentId = config.agentId
    this.#baseContext = config.nativeAgentContext
    this.#runtimeOptions = config.runtimeOptions
    this.#defaultGraph = config.defaultGraph
    this.#executorFactory = config.executorFactory
  }
```

3. 修改 `query` 方法：

```typescript
async *query(prompt: string): AsyncIterable<RuntimeEvent> {
    if (this.#session === null) {
      throw new Error('Not connected. Call connect() first.')
    }

    const session = this.#session
    const generation = this.#activeGeneration
    let completedSeen = false

    for await (const event of session.queryWithGraph(this.#defaultGraph, {
      initialState: { input: prompt },
      compileOptions: { agentExecutorFactory: this.#executorFactory },
    })) {
      if (generation !== this.#activeGeneration || this.#session !== session) {
        return
      }

      if (event.type === 'run.completed') {
        if (completedSeen) {
          continue
        }
        completedSeen = true
      }

      yield event
    }
  }
```

- [ ] **Step 2: 更新测试文件**

在 `native-agent-integration.test.ts` 和 `native-agent-error-recovery.test.ts` 中，构造 `InProcessAgentRunner` 时新增 `defaultGraph` 和 `executorFactory` 参数。先读取两个测试文件，补上必需参数。

- [ ] **Step 3: Run tests**

Run: `cd apps/node && pnpm vitest run native-agent`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/node/src/acp/in-process-runner.ts apps/node/src/__tests__/native-agent-integration.test.ts apps/node/src/__tests__/native-agent-error-recovery.test.ts
git commit -m "feat(node): InProcessAgentRunner 接入 defaultGraph 和 executorFactory"
```

---

### Task 10: daemon-entry + controlplane-runtime 接线

**Files:**
- Modify: `apps/node/src/daemon-entry.ts`
- Modify: `apps/node/src/node-runtime/controlplane-runtime.ts`

- [ ] **Step 1: 修改 daemon-entry.ts**

1. 新增导入：

```typescript
import {
  type ControlPlaneStatusSnapshot,
  DEFAULT_CONTROL_PLANE_STATUS,
  DaemonServer,
  createAgentSession,
  createDeepagentsExecutorFactory,
  loadDefaultOrchestrationGraph,
} from '@tianji/agent'
```

（删掉原来只导入 `createAgentSession` 和 `DaemonServer` 的行。）

2. 在 `runDaemonEntry` 函数内，`const session = ...` 之前新增：

```typescript
const executorFactory = createDeepagentsExecutorFactory({
    resolveModel: (modelRef) => modelRef,
  })

  const defaultGraph = await loadDefaultOrchestrationGraph({
    configDir: context.paths.configDir,
    agentConfigs: context.config.agents?.items ?? {},
  })
```

3. 修改 `DaemonServer` 构造调用：

```typescript
const server = new DaemonServer({
    session,
    defaultGraph,
    executorFactory,
    getControlPlaneStatus: () => controlPlaneStatus,
    paths: {
      daemonPortPath: context.paths.daemonPortPath,
      daemonPidPath: context.paths.daemonPidPath,
    },
  })
```

4. 修改 `createControlPlaneRuntime` 调用时传入 `defaultGraph` 和 `executorFactory`：

```typescript
const runtime = createControlPlaneRuntime({
      ...controlPlaneConfig,
      agentConfigs: context.config.agents?.items ?? {},
      nativeAgentContext: context,
      agentList: deriveControlPlaneAgentList(context.config, controlPlaneConfig.version),
      defaultGraph,
      executorFactory,
      logger,
      // ...rest unchanged
    })
```

- [ ] **Step 2: 修改 controlplane-runtime.ts**

1. 新增导入：

```typescript
import type { AgentExecutorFactory, OrchestrationGraph } from '@tianji/agent'
```

2. 修改 `ControlPlaneRuntimeConfig`：

```typescript
export interface ControlPlaneRuntimeConfig {
  // ...existing fields...
  readonly defaultGraph: OrchestrationGraph
  readonly executorFactory: AgentExecutorFactory
}
```

3. 在 `createRunner` 回调（第 152-174 行）中，构造 `InProcessAgentRunner` 时传入新参数：

```typescript
return new InProcessAgentRunner({
            agentId: command.payload.agentId,
            nativeAgentContext: config.nativeAgentContext,
            runtimeOptions:
              config.observerLogger !== undefined ? { logger: config.observerLogger } : undefined,
            defaultGraph: config.defaultGraph,
            executorFactory: config.executorFactory,
          })
```

- [ ] **Step 3: Run pnpm check**

Run: `pnpm check`
Expected: 全部通过。这是关键里程碑——所有编译错误应该在这一步消除。

- [ ] **Step 4: Run all tests**

Run: `cd packages/agent && pnpm vitest run` 和 `cd apps/node && pnpm vitest run`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
git add apps/node/src/daemon-entry.ts apps/node/src/node-runtime/controlplane-runtime.ts
git commit -m "feat(node): daemon-entry 和 controlplane-runtime 接线 defaultGraph + executorFactory"
```

---

### Task 11: 全量验证 + 回归

- [ ] **Step 1: Run pnpm check**

Run: `pnpm check`
Expected: 0 errors, 0 warnings

- [ ] **Step 2: Run 全部包测试**

Run: `cd packages/agent && pnpm vitest run`
Expected: 全部 PASS

Run: `cd apps/node && pnpm vitest run`
Expected: 全部 PASS

- [ ] **Step 3: 确认 knip 无新增 dead exports**

Run: `pnpm check`（已包含 knip）
Expected: 无新增报错。若 `ChatOptions` 导出删除后被其他文件引用，在此步暴露并修复。

- [ ] **Step 4: 总结提交历史**

确认所有 10 次 commit 已正确记录：
1. `feat(agent): systemPrompt 构建器拼接 SOUL.md + AGENTS.md`
2. `feat(agent): 图加载器从 JSON 加载编排图并展开 agent name`
3. `feat(agent): deepagents-executor 透传 RuntimeEvent 到外层流`
4. `feat(agent): acp-executor 透传 RuntimeEvent 到外层流`
5. `feat(agent): graph-runner 事件流拓宽为 RuntimeEvent 并注入 emitRuntimeEvent`
6. `chore(agent): orchestration index 导出 graph-loader 和 system-prompt-builder`
7. `refactor(agent): 删除 session.query 单 agent 入口，统一走 queryWithGraph`
8. `feat(agent): DaemonServer 接入 defaultGraph 和 executorFactory`
9. `feat(node): InProcessAgentRunner 接入 defaultGraph 和 executorFactory`
10. `feat(node): daemon-entry 和 controlplane-runtime 接线 defaultGraph + executorFactory`
