# Orchestration Mermaid Output Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给编排层增加 Mermaid 文本渲染能力，并在 agent 运行时把当前编排图以 Mermaid 格式输出给调用方。

**Architecture:** 在 `packages/agent/src/orchestration` 内新增一个纯函数模块，把 `OrchestrationGraph` 转成 Mermaid `flowchart TD` 文本；`graph-runner.ts` 在图校验并编译成功后，通过显式回调把 Mermaid 文本抛给上层，而不是在底层直接写死到 `stdout`。这样 CLI、测试、后续 Web UI 都能复用同一份图文本。

**Tech Stack:** TypeScript, Vitest, `@tianji/agent` orchestration 模块, `@langchain/core/utils/testing` (FakeListChatModel)

---

## 文件结构

| 文件 | 职责 | 改动类型 |
|------|------|----------|
| `packages/agent/src/orchestration/graph-mermaid.ts` | `OrchestrationGraph -> Mermaid` 纯函数渲染 | 新增 |
| `packages/agent/src/orchestration/graph-runner.ts` | 增加 Mermaid 输出回调，在运行开始前发出图文本 | 修改 |
| `packages/agent/src/orchestration/index.ts` | 导出 Mermaid 渲染函数和类型 | 修改 |
| `packages/agent/src/orchestration/__tests__/graph-mermaid.test.ts` | 验证不同节点/边会正确转成 Mermaid | 新增 |
| `packages/agent/src/orchestration/__tests__/graph-runner.e2e.test.ts` | 验证 runner 启动时会通过回调输出 Mermaid | 修改 |
| `packages/agent/README.md` | 如已有 orchestration 用法说明，补一段 Mermaid 输出示例；若无相关章节则不改 | 视情况修改 |

---

### Task 1: 新增 Mermaid 渲染模块

**Files:**
- Create: `packages/agent/src/orchestration/graph-mermaid.ts`

- [ ] **Step 1: 创建 `graph-mermaid.ts`，定义公开接口和内部辅助函数**

写入完整文件内容：

```typescript
import type { GraphNode, OrchestrationGraph } from './graph-schema.js'

/**
 * Mermaid 渲染配置。
 */
export interface RenderOrchestrationGraphMermaidOptions {
  readonly direction?: 'TD' | 'LR'
}

/**
 * 把可序列化编排图转换为 Mermaid flowchart 文本。
 * 这里只做静态结构渲染，不掺入运行态成功/失败样式。
 */
export function renderOrchestrationGraphMermaid(
  graph: OrchestrationGraph,
  options: RenderOrchestrationGraphMermaidOptions = {}
): string {
  const direction = options.direction ?? 'TD'
  const lines: string[] = [`flowchart ${direction}`]

  lines.push(`  ${toMermaidId('__start__')}([START])`)
  lines.push(`  ${toMermaidId('__end__')}([END])`)

  for (const node of graph.nodes) {
    lines.push(renderNode(node))
  }

  for (const edge of graph.edges) {
    lines.push(renderEdge(edge.from, edge.to))
  }

  return lines.join('\n')
}

function renderNode(node: GraphNode): string {
  const id = toMermaidId(node.id)
  const label = escapeLabel(node.id)

  if (node.type === 'agent') {
    return `  ${id}[agent: ${label}]`
  }

  if (node.type === 'acp-agent') {
    return `  ${id}[[acp: ${label}]]`
  }

  if (node.type === 'router') {
    return `  ${id}{router: ${label}}`
  }

  if (node.type === 'human-gate') {
    return `  ${id}{{human: ${label}}}`
  }

  return `  ${id}([fork: ${label}])`
}

function renderEdge(from: string, to: string): string {
  return `  ${toMermaidId(from)} --> ${toMermaidId(to)}`
}

function toMermaidId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_]/g, '_')
}

function escapeLabel(raw: string): string {
  return raw.replace(/"/g, '\\"')
}
```

- [ ] **Step 2: 保持实现边界最小，不在这里读取运行事件或 logger**

检查该文件，确认只依赖 `graph-schema.ts`，不导入 `RuntimeEvent`、`ObserverLogger`、`process.stdout`、`console`。

预期：`graph-mermaid.ts` 是纯函数文件，后续 CLI、测试、UI 都可复用。

- [ ] **Step 3: 运行定向测试和类型检查**

Run: `pnpm --filter @tianji/agent test -- graph-mermaid`
Expected: 当前还没有测试，命令可能显示无匹配测试文件；这是正常的，下一任务补测试后再重跑。

Run: `pnpm --filter @tianji/agent typecheck`
Expected: 通过。

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/orchestration/graph-mermaid.ts
git commit -m "feat(agent): add orchestration mermaid renderer"
```

---

### Task 2: 在 graph-runner 中增加 Mermaid 输出回调

**Files:**
- Modify: `packages/agent/src/orchestration/graph-runner.ts`

- [ ] **Step 1: 扩展 `RunOrchestrationGraphOptions`，增加显式回调**

在接口中加入：

```typescript
  readonly onMermaid?: (diagram: string) => void
```

放在 `abortSignal` 后面即可。不要加布尔开关，不要在 runner 里直接 `console.log`。

- [ ] **Step 2: 顶部导入 Mermaid 渲染函数**

在现有 import 区增加：

```typescript
import { renderOrchestrationGraphMermaid } from './graph-mermaid.js'
```

- [ ] **Step 3: 在 compile 成功后、graph.started 事件发出前触发回调**

在：

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

之后，插入：

```typescript
  if (options.onMermaid !== undefined) {
    options.onMermaid(renderOrchestrationGraphMermaid(options.graph))
  }
```

要求：
- 只在图编译成功后触发，非法图不输出 Mermaid。
- 只输出一次。
- 不吞回调异常。若调用方回调崩溃，就让它暴露。

- [ ] **Step 4: 运行类型检查**

Run: `pnpm --filter @tianji/agent typecheck`
Expected: 通过，`RunOrchestrationGraphOptions` 的新字段不影响现有调用方。

- [ ] **Step 5: Commit**

```bash
git add packages/agent/src/orchestration/graph-runner.ts
git commit -m "feat(agent): emit orchestration mermaid from graph runner"
```

---

### Task 3: 导出公共 API

**Files:**
- Modify: `packages/agent/src/orchestration/index.ts`

- [ ] **Step 1: 导出渲染函数和类型**

在 `index.ts` 增加：

```typescript
export {
  renderOrchestrationGraphMermaid,
  type RenderOrchestrationGraphMermaidOptions,
} from './graph-mermaid.js'
```

这样 `packages/agent` 下游消费者可以直接拿到渲染函数，不需要跨内部路径 import。

- [ ] **Step 2: 运行类型检查**

Run: `pnpm --filter @tianji/agent typecheck`
Expected: 通过。

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/orchestration/index.ts
git commit -m "refactor(agent): export orchestration mermaid helpers"
```

---

### Task 4: 为 Mermaid 渲染补单元测试

**Files:**
- Create: `packages/agent/src/orchestration/__tests__/graph-mermaid.test.ts`

- [ ] **Step 1: 写最小图渲染测试**

创建测试文件，写入：

```typescript
import { describe, expect, it } from 'vitest'

import { renderOrchestrationGraphMermaid } from '../graph-mermaid.js'
import type { OrchestrationGraph } from '../graph-schema.js'

describe('renderOrchestrationGraphMermaid', () => {
  it('渲染串行 agent 管线为 mermaid flowchart', () => {
    const graph: OrchestrationGraph = {
      id: 'pipeline',
      name: 'pipeline',
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
          agent: { model: 'fake', systemPrompt: 'planner' },
          output: ['plan'],
        },
        {
          id: 'coder',
          type: 'agent',
          agent: { model: 'fake', systemPrompt: 'coder' },
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

    const result = renderOrchestrationGraphMermaid(graph)

    expect(result).toContain('flowchart TD')
    expect(result).toContain('__start__([START])')
    expect(result).toContain('__end__([END])')
    expect(result).toContain('planner[agent: planner]')
    expect(result).toContain('coder[agent: coder]')
    expect(result).toContain('__start__ --> planner')
    expect(result).toContain('planner --> coder')
    expect(result).toContain('coder --> __end__')
  })
```

- [ ] **Step 2: 写混合节点形状测试**

在同一个文件继续追加：

```typescript
  it('按节点类型渲染不同 mermaid 形状', () => {
    const graph: OrchestrationGraph = {
      id: 'mixed',
      name: 'mixed',
      version: 1,
      source: 'static',
      locked: false,
      state: {
        approved: { type: 'boolean', default: false },
      },
      nodes: [
        {
          id: 'worker-acp',
          type: 'acp-agent',
          acp: { command: 'tianji-agent' },
        },
        {
          id: 'review-router',
          type: 'router',
          condition: { field: 'approved', branches: { true: '__end__', false: 'worker-acp' } },
        },
        {
          id: 'approval-gate',
          type: 'human-gate',
          prompt: '继续吗',
        },
        {
          id: 'parallel-work',
          type: 'fork',
          targets: ['worker-acp'],
          join: 'approval-gate',
        },
      ],
      edges: [
        { from: '__start__', to: 'parallel-work' },
        { from: 'worker-acp', to: 'review-router' },
        { from: 'approval-gate', to: '__end__' },
      ],
    }

    const result = renderOrchestrationGraphMermaid(graph)

    expect(result).toContain('worker_acp[[acp: worker-acp]]')
    expect(result).toContain('review_router{router: review-router}')
    expect(result).toContain('approval_gate{{human: approval-gate}}')
    expect(result).toContain('parallel_work([fork: parallel-work])')
  })
})
```

- [ ] **Step 3: 实际运行该测试**

Run: `pnpm --filter @tianji/agent test -- graph-mermaid.test.ts`
Expected: 2 个测试通过。

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/orchestration/__tests__/graph-mermaid.test.ts
git commit -m "test(agent): cover orchestration mermaid rendering"
```

---

### Task 5: 为 graph-runner Mermaid 回调补回归测试

**Files:**
- Modify: `packages/agent/src/orchestration/__tests__/graph-runner.e2e.test.ts`

- [ ] **Step 1: 在现有串行管线测试中加入 Mermaid 回调断言**

在第一个测试中新增变量：

```typescript
    let mermaid = ''
```

并把 runner 调用改成：

```typescript
    const result = runOrchestrationGraph({
      graph,
      runId: 'run_e2e_1' as RunId,
      compileOptions: { agentExecutorFactory: factory },
      onMermaid: (diagram) => {
        mermaid = diagram
      },
    })
```

在 `await collectionPromise` 之后增加断言：

```typescript
    expect(mermaid).toContain('flowchart TD')
    expect(mermaid).toContain('planner[agent: planner]')
    expect(mermaid).toContain('planner --> coder')
```

- [ ] **Step 2: 增加一次性输出保证断言**

把 `let mermaid = ''` 改成：

```typescript
    const mermaidDiagrams: string[] = []
```

回调改成：

```typescript
      onMermaid: (diagram) => {
        mermaidDiagrams.push(diagram)
      },
```

断言改成：

```typescript
    expect(mermaidDiagrams).toHaveLength(1)
    expect(mermaidDiagrams[0]).toContain('flowchart TD')
```

- [ ] **Step 3: 实际运行该测试**

Run: `pnpm --filter @tianji/agent test -- graph-runner.e2e.test.ts`
Expected: 现有 e2e 测试继续通过，新增 Mermaid 断言也通过。

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/orchestration/__tests__/graph-runner.e2e.test.ts
git commit -m "test(agent): verify graph runner emits mermaid diagram"
```

---

### Task 6: 检查 README 是否需要补说明

**Files:**
- Modify: `packages/agent/README.md`（如果存在 orchestration 使用文档）

- [ ] **Step 1: 先检查 README 是否存在且是否已有 orchestration 示例**

读取：`packages/agent/README.md`

判断规则：
- 如果文件不存在，不创建新 README。
- 如果存在但没有 orchestration 用法，不为了这个功能单独补整份文档。
- 只有当 README 已经在介绍 `runOrchestrationGraph` 或 orchestration API 时，才在对应段落追加 Mermaid 示例。

- [ ] **Step 2: 如果满足条件，补一段最小示例**

追加类似示例：

```typescript
const result = runOrchestrationGraph({
  graph,
  runId,
  compileOptions: { agentExecutorFactory },
  onMermaid: (diagram) => {
    process.stdout.write(`${diagram}\n`)
  },
})
```

文案只说明一件事：Mermaid 文本由调用方决定输出到终端、日志还是 UI。

- [ ] **Step 3: 运行类型检查和测试**

如果只改 README，这一步跳过代码测试。

- [ ] **Step 4: Commit**

```bash
git add packages/agent/README.md
git commit -m "docs(agent): document orchestration mermaid callback"
```

若 README 未修改，此任务标记完成但不提交。

---

### Task 7: 全量回归与最终检查

**Files:**
- Modify: 无

- [ ] **Step 1: 运行 agent 包测试**

Run: `pnpm --filter @tianji/agent test`
Expected: `packages/agent` 现有测试全部通过，包括新增 Mermaid 测试。

- [ ] **Step 2: 运行仓库强制检查**

Run: `pnpm check`
Expected: 全仓通过，无 error、warning、info 残留。若出现任何问题，直接修复，不允许带错结束。

- [ ] **Step 3: 如 README 有改动，确认文档内容和代码接口一致**

重点检查：
- 回调名是否为 `onMermaid`
- 导出函数名是否为 `renderOrchestrationGraphMermaid`
- Mermaid 示例是否仍然是 `flowchart TD`

- [ ] **Step 4: 最终提交**

```bash
git add packages/agent/src/orchestration/graph-mermaid.ts \
  packages/agent/src/orchestration/graph-runner.ts \
  packages/agent/src/orchestration/index.ts \
  packages/agent/src/orchestration/__tests__/graph-mermaid.test.ts \
  packages/agent/src/orchestration/__tests__/graph-runner.e2e.test.ts \
  packages/agent/README.md
git commit -m "feat(agent): expose orchestration mermaid diagrams"
```

如果 README 没改，把它从 `git add` 里删掉。

---

## Self-Review

### Spec coverage

- 已覆盖 Mermaid 纯函数渲染。
- 已覆盖 runner 启动时输出 Mermaid。
- 已覆盖公共导出。
- 已覆盖单元测试和 e2e 回归测试。
- 已覆盖 README 条件更新。

### Placeholder scan

- 无 `TODO`、`TBD`、`implement later`。
- 每个代码步骤都给了明确文件和代码片段。
- 每个验证步骤都给了明确命令。

### Type consistency

- 回调统一命名为 `onMermaid`。
- 渲染函数统一命名为 `renderOrchestrationGraphMermaid`。
- 选项类型统一命名为 `RenderOrchestrationGraphMermaidOptions`。
