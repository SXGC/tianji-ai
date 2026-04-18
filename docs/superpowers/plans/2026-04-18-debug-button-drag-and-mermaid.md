# Debug 按钮拖动 + GraphRunCompleted Mermaid 渲染 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让右下角 Debug 按钮可拖动，并在事件详情抽屉中为 GraphRunCompleted 事件渲染编排图 Mermaid 图。

**Architecture:** Feature 1 新建 `use-draggable` hook 管理按钮 (x, y) 坐标，`DebugToggleButton` 从静态 fixed 改为动态 left/top。Feature 2 在 `GraphRunStartedEvent` 加 `mermaidDiagram` 字段，`graph-runner` 生成并写入事件，前端 `EventListTab` 查找对应 GraphRunStarted 后把 mermaidDiagram 传给 `EventDetailDrawer`，由新建的 `MermaidDiagram` 组件调用 `mermaid.render()` 渲染 SVG。

**Tech Stack:** TypeScript, React 19, Vitest, @testing-library/react, mermaid@11（已在 pnpm store）

---

## 文件地图

| 操作 | 路径 | 职责 |
|------|------|------|
| 新建 | `apps/controlplane/src/web/components/debug/hooks/use-draggable.ts` | 轻量拖动 hook，只管 (x, y)，无 resize/minimize |
| 新建 | `apps/controlplane/src/web/components/debug/hooks/__tests__/use-draggable.test.tsx` | use-draggable 单元测试 |
| 修改 | `apps/controlplane/src/web/components/debug/debug-toggle-button.tsx` | 使用 use-draggable，改为 left/top 定位 |
| 修改 | `packages/shared/src/events/graph-run.ts` | `GraphRunStartedEvent` 加 `mermaidDiagram: string` |
| 修改 | `packages/agent/src/orchestration/graph-runner.ts` | 先生成 mermaid，再写入 GraphRunStarted 事件 |
| 修改 | `packages/agent/src/orchestration/__tests__/graph-runner.test.ts` | 新增：验证 GraphRunStarted 含 mermaidDiagram |
| 修改 | `apps/controlplane/package.json` | 添加 `mermaid` 为 direct dep |
| 新建 | `apps/controlplane/src/web/components/debug/mermaid-diagram.tsx` | 调用 mermaid.render() 渲染 SVG |
| 新建 | `apps/controlplane/src/web/components/debug/__tests__/mermaid-diagram.test.tsx` | MermaidDiagram 单元测试 |
| 修改 | `apps/controlplane/src/web/components/debug/event-detail-drawer.tsx` | 新增 `mermaidDiagram?: string \| null` prop，条件渲染 MermaidDiagram |
| 修改 | `apps/controlplane/src/web/components/debug/event-list-tab.tsx` | 选中 GraphRunCompleted 时查找 mermaidDiagram，传给 drawer |
| 修改 | `apps/controlplane/src/web/components/debug/__tests__/event-list-tab.test.tsx` | 新增：验证 mermaid prop 传递 |

---

## Task 1: use-draggable hook

**Files:**
- Create: `apps/controlplane/src/web/components/debug/hooks/use-draggable.ts`
- Create: `apps/controlplane/src/web/components/debug/hooks/__tests__/use-draggable.test.tsx`

- [ ] **Step 1: 写失败测试**

新建 `apps/controlplane/src/web/components/debug/hooks/__tests__/use-draggable.test.tsx`：

```tsx
/** @vitest-environment jsdom */
import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, test } from 'vitest'

import { useDraggable } from '../use-draggable.js'

if (typeof window.PointerEvent === 'undefined') {
  // @ts-expect-error — 测试环境 polyfill
  window.PointerEvent = class PointerEvent extends MouseEvent {}
}

afterEach(() => {
  // pointermove/pointerup 监听器在 pointerup 触发后自动移除，无需手动清理
})

describe('useDraggable', () => {
  test('初始位置由参数决定', () => {
    const { result } = renderHook(() => useDraggable(100, 200))
    expect(result.current.x).toBe(100)
    expect(result.current.y).toBe(200)
  })

  test('pointerdown + pointermove 更新位置', () => {
    const { result } = renderHook(() => useDraggable(100, 200))

    // pointerdown 起始点 (110, 220)，与初始位置的偏移 = (10, 20)
    act(() => {
      result.current.startDrag(
        new PointerEvent('pointerdown', { clientX: 110, clientY: 220 })
      )
    })

    // pointermove 到 (160, 260)，delta = (+50, +40)，新位置 = (150, 240)
    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 160, clientY: 260, bubbles: true })
      )
    })

    expect(result.current.x).toBe(150)
    expect(result.current.y).toBe(240)
  })

  test('pointerup 后 pointermove 不再更新位置', () => {
    const { result } = renderHook(() => useDraggable(100, 200))

    act(() => {
      result.current.startDrag(
        new PointerEvent('pointerdown', { clientX: 100, clientY: 200 })
      )
    })

    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    })

    act(() => {
      window.dispatchEvent(
        new PointerEvent('pointermove', { clientX: 999, clientY: 999, bubbles: true })
      )
    })

    expect(result.current.x).toBe(100)
    expect(result.current.y).toBe(200)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /workspaces/dev_docker/tianji-ai/apps/controlplane
pnpm test -- --reporter=verbose src/web/components/debug/hooks/__tests__/use-draggable.test.tsx
```

期望：FAIL，`Cannot find module '../use-draggable.js'`

- [ ] **Step 3: 实现 use-draggable.ts**

新建 `apps/controlplane/src/web/components/debug/hooks/use-draggable.ts`：

```ts
import { useCallback, useRef, useState } from 'react'

export interface DraggableController {
  x: number
  y: number
  startDrag: (e: PointerEvent) => void
}

/**
 * 极简拖动 hook，只管 (x, y) 位置。不包含 resize / minimize（区别于 use-debug-window）。
 * 使用 pointer 事件以同时支持触屏和桌面。listener 在 pointerup 时自动移除。
 */
export function useDraggable(initialX: number, initialY: number): DraggableController {
  const [pos, setPos] = useState({ x: initialX, y: initialY })
  const posRef = useRef(pos)
  posRef.current = pos

  const startDrag = useCallback((e: PointerEvent) => {
    const startClientX = e.clientX
    const startClientY = e.clientY
    const startPos = posRef.current

    const onMove = (pe: PointerEvent): void => {
      setPos({
        x: startPos.x + (pe.clientX - startClientX),
        y: startPos.y + (pe.clientY - startClientY),
      })
    }

    const onEnd = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
  }, [])

  return { x: pos.x, y: pos.y, startDrag }
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd /workspaces/dev_docker/tianji-ai/apps/controlplane
pnpm test -- --reporter=verbose src/web/components/debug/hooks/__tests__/use-draggable.test.tsx
```

期望：3 tests PASS

- [ ] **Step 5: 运行 pnpm check**

```bash
cd /workspaces/dev_docker/tianji-ai
pnpm check
```

期望：无错误、无警告。

- [ ] **Step 6: Commit**

加载 `git-commit` skill 后执行：

```bash
git add apps/controlplane/src/web/components/debug/hooks/use-draggable.ts
git add apps/controlplane/src/web/components/debug/hooks/__tests__/use-draggable.test.tsx
```

提交信息：`feat(debug): 新增 use-draggable hook 管理拖动坐标`

---

## Task 2: DebugToggleButton 支持拖动

**Files:**
- Modify: `apps/controlplane/src/web/components/debug/debug-toggle-button.tsx`
- Modify: `apps/controlplane/src/web/components/debug/__tests__/debug-panel.test.tsx`

- [ ] **Step 1: 在 debug-panel.test.tsx 新增拖动测试**

在 `describe('DebugToggleButtonImpl', ...)` 块末尾追加：

```tsx
test('在按钮上 pointerdown + 全局 pointermove 会移动按钮位置', () => {
  render(<DebugToggleButtonImpl />)
  const btn = screen.getByRole('button', { name: /debug/i })

  const initialLeft = Number.parseInt(btn.style.left, 10)
  const initialTop = Number.parseInt(btn.style.top, 10)

  // pointerdown 起始点 (50, 50)
  fireEvent.pointerDown(btn, { clientX: 50, clientY: 50 })

  // pointermove (+30, +20)
  act(() => {
    window.dispatchEvent(
      new PointerEvent('pointermove', { clientX: 80, clientY: 70, bubbles: true })
    )
  })

  act(() => {
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  })

  expect(Number.parseInt(btn.style.left, 10)).toBe(initialLeft + 30)
  expect(Number.parseInt(btn.style.top, 10)).toBe(initialTop + 20)
})
```

- [ ] **Step 2: 运行测试确认新测试失败**

```bash
cd /workspaces/dev_docker/tianji-ai/apps/controlplane
pnpm test -- --reporter=verbose src/web/components/debug/__tests__/debug-panel.test.tsx
```

期望：新增测试 FAIL（按钮无 style.left），已有测试 PASS。

- [ ] **Step 3: 更新 debug-toggle-button.tsx**

完整替换 `DebugToggleButtonImpl` 函数（保留文件其余部分不变）：

```tsx
import type { JSX } from 'react'

import { useDebugStore } from '../../stores/debug-store.js'
import { useDraggable } from './hooks/use-draggable.js'

const DEBUG_ENABLED = import.meta.env.VITE_ENABLE_DEBUG === 'true'

/**
 * 真正的实现。导出以便测试文件直接验证其渲染/点击行为，绕开模块级 DEBUG_ENABLED 常量
 * 在 test 环境无法运行时切换的限制（vi.stubEnv 无法重置已经计算好的 const）。
 */
export function DebugToggleButtonImpl(): JSX.Element {
  const togglePanel = useDebugStore((s) => s.togglePanel)
  const { x, y, startDrag } = useDraggable(
    window.innerWidth - 80,
    window.innerHeight - 52
  )
  return (
    <button
      type="button"
      onClick={togglePanel}
      onPointerDown={(e) => startDrag(e.nativeEvent)}
      aria-label="Debug"
      style={{
        position: 'fixed',
        left: x,
        top: y,
        zIndex: 9999,
        padding: '8px 12px',
        borderRadius: 8,
        border: '1px solid #333',
        background: '#111',
        color: '#fff',
        cursor: 'grab',
        userSelect: 'none',
      }}
    >
      Debug
    </button>
  )
}

function EmptyComponent(): null {
  return null
}

/**
 * 右下角的 Debug 开关。仅当 VITE_ENABLE_DEBUG === 'true' 时才导出真正的实现，
 * 否则导出一个静态返回 null 的空组件；实现函数与其依赖被 Vite tree-shake。
 */
export const DebugToggleButton = DEBUG_ENABLED ? DebugToggleButtonImpl : EmptyComponent
```

- [ ] **Step 4: 运行全部 debug 测试确认通过**

```bash
cd /workspaces/dev_docker/tianji-ai/apps/controlplane
pnpm test -- --reporter=verbose src/web/components/debug/__tests__/debug-panel.test.tsx
```

期望：全部 PASS（含原有点击测试 + 新拖动测试）。

- [ ] **Step 5: 运行 pnpm check**

```bash
cd /workspaces/dev_docker/tianji-ai
pnpm check
```

期望：无错误、无警告。

- [ ] **Step 6: Commit**

```bash
git add apps/controlplane/src/web/components/debug/debug-toggle-button.tsx
git add apps/controlplane/src/web/components/debug/__tests__/debug-panel.test.tsx
```

提交信息：`feat(debug): Debug 按钮支持拖动`

---

## Task 3: GraphRunStartedEvent 加 mermaidDiagram 字段

**Files:**
- Modify: `packages/shared/src/events/graph-run.ts`
- Modify: `packages/agent/src/orchestration/graph-runner.ts`
- Modify: `packages/agent/src/orchestration/__tests__/graph-runner.test.ts`

- [ ] **Step 1: 在 graph-runner.test.ts 新增失败测试**

在文件末尾追加新的 `describe` 块：

```ts
describe('graph-runner GraphRunStarted mermaidDiagram', () => {
  it('GraphRunStarted 事件应包含非空的 mermaidDiagram 字段', async () => {
    const factory = createDeepagentsExecutorFactory({
      resolveModel: () => new FakeListChatModel({ responses: ['result value'] }),
    })

    const result = runOrchestrationGraph({
      graph: buildMinimalGraph(),
      runId: 'run_mermaid_test' as RunId,
      compileOptions: { agentExecutorFactory: factory },
    })

    const collectionPromise = collectEvents(result.events)
    await result.finished
    const collected = await collectionPromise

    const startedEvent = collected.find((e) => e.type === 'GraphRunStarted')
    expect(startedEvent).toBeDefined()
    // mermaidDiagram 由 renderOrchestrationGraphMermaid 生成，以 'flowchart' 开头
    expect((startedEvent as { type: string; mermaidDiagram: string }).mermaidDiagram).toMatch(
      /^flowchart/
    )
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /workspaces/dev_docker/tianji-ai/packages/agent
pnpm test -- --reporter=verbose src/orchestration/__tests__/graph-runner.test.ts
```

期望：新测试 FAIL（`mermaidDiagram` 为 `undefined`），已有测试 PASS。

- [ ] **Step 3: 更新 GraphRunStartedEvent 类型**

在 `packages/shared/src/events/graph-run.ts` 中，将 `GraphRunStartedEvent` 改为：

```ts
export interface GraphRunStartedEvent extends GraphRunFields {
  readonly type: 'GraphRunStarted'
  readonly mermaidDiagram: string
}
```

- [ ] **Step 4: 更新 graph-runner.ts 发出 mermaidDiagram**

在 `packages/agent/src/orchestration/graph-runner.ts` 中，将现有的 `onMermaid` 调用和 `emit GraphRunStarted` 段落（第 94-104 行）替换为：

```ts
const mermaidDiagram = renderOrchestrationGraphMermaid(options.graph)

if (options.onMermaid !== undefined) {
  options.onMermaid(mermaidDiagram)
}

emit({
  type: 'GraphRunStarted',
  runId: options.runId,
  graphId: options.graph.id,
  graphVersion: options.graph.version,
  mermaidDiagram,
  timestamp: Date.now(),
})
```

- [ ] **Step 5: 运行测试确认全部通过**

```bash
cd /workspaces/dev_docker/tianji-ai/packages/agent
pnpm test -- --reporter=verbose src/orchestration/__tests__/graph-runner.test.ts
```

期望：全部 PASS。

- [ ] **Step 6: 运行 pnpm check**

```bash
cd /workspaces/dev_docker/tianji-ai
pnpm check
```

期望：无错误、无警告。

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/events/graph-run.ts
git add packages/agent/src/orchestration/graph-runner.ts
git add packages/agent/src/orchestration/__tests__/graph-runner.test.ts
```

提交信息：`feat(agent): GraphRunStarted 事件加入 mermaidDiagram 字段`

---

## Task 4: MermaidDiagram 组件

**Files:**
- Modify: `apps/controlplane/package.json`
- Create: `apps/controlplane/src/web/components/debug/mermaid-diagram.tsx`
- Create: `apps/controlplane/src/web/components/debug/__tests__/mermaid-diagram.test.tsx`

- [ ] **Step 1: 写失败测试**

新建 `apps/controlplane/src/web/components/debug/__tests__/mermaid-diagram.test.tsx`：

```tsx
/** @vitest-environment jsdom */
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg data-testid="mock-svg">diagram</svg>' }),
  },
}))

import mermaid from 'mermaid'
import { MermaidDiagram } from '../mermaid-diagram.js'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('MermaidDiagram', () => {
  test('挂载后调用 mermaid.render 并注入 SVG', async () => {
    const { container } = render(<MermaidDiagram diagram="flowchart TD\n  A-->B" />)

    await vi.waitFor(() => {
      expect(mermaid.render).toHaveBeenCalledOnce()
      expect(mermaid.render).toHaveBeenCalledWith(
        expect.stringContaining('mermaid-'),
        'flowchart TD\n  A-->B'
      )
      expect(container.querySelector('[data-testid="mock-svg"]')).not.toBeNull()
    })
  })

  test('diagram 更新时重新渲染', async () => {
    const { rerender } = render(<MermaidDiagram diagram="flowchart TD\n  A-->B" />)
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1))

    rerender(<MermaidDiagram diagram="flowchart TD\n  C-->D" />)
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2))
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /workspaces/dev_docker/tianji-ai/apps/controlplane
pnpm test -- --reporter=verbose src/web/components/debug/__tests__/mermaid-diagram.test.tsx
```

期望：FAIL，`Cannot find module '../mermaid-diagram.js'`

- [ ] **Step 3: 添加 mermaid 依赖**

在 `apps/controlplane/package.json` 的 `dependencies` 中添加：

```json
"mermaid": "^11.14.0"
```

安装（pnpm 会从 store 直接链接，不需要网络）：

```bash
cd /workspaces/dev_docker/tianji-ai
pnpm install --frozen-lockfile=false
```

- [ ] **Step 4: 创建 mermaid-diagram.tsx**

新建 `apps/controlplane/src/web/components/debug/mermaid-diagram.tsx`：

```tsx
import type { JSX } from 'react'
import { useEffect, useId, useRef } from 'react'
import mermaid from 'mermaid'

mermaid.initialize({ startOnLoad: false, theme: 'dark' })

interface Props {
  diagram: string
}

/** 将 mermaid 文本渲染为内联 SVG。diagram 变化时重新渲染。 */
export function MermaidDiagram({ diagram }: Props): JSX.Element {
  const rawId = useId()
  const id = `mermaid-${rawId.replace(/:/g, '')}`
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    void mermaid.render(id, diagram).then(({ svg }) => {
      if (!cancelled && ref.current !== null) {
        ref.current.innerHTML = svg
      }
    })
    return () => {
      cancelled = true
    }
  }, [diagram, id])

  return <div ref={ref} data-testid="mermaid-diagram" style={{ padding: 8 }} />
}
```

- [ ] **Step 5: 运行测试确认通过**

```bash
cd /workspaces/dev_docker/tianji-ai/apps/controlplane
pnpm test -- --reporter=verbose src/web/components/debug/__tests__/mermaid-diagram.test.tsx
```

期望：2 tests PASS

- [ ] **Step 6: 运行 pnpm check**

```bash
cd /workspaces/dev_docker/tianji-ai
pnpm check
```

期望：无错误、无警告。

- [ ] **Step 7: Commit**

```bash
git add apps/controlplane/package.json
git add apps/controlplane/src/web/components/debug/mermaid-diagram.tsx
git add apps/controlplane/src/web/components/debug/__tests__/mermaid-diagram.test.tsx
```

提交信息：`feat(debug): 新增 MermaidDiagram 组件，调用 mermaid.render 渲染 SVG`

---

## Task 5: EventDetailDrawer + EventListTab 渲染 mermaid

**Files:**
- Modify: `apps/controlplane/src/web/components/debug/event-detail-drawer.tsx`
- Modify: `apps/controlplane/src/web/components/debug/event-list-tab.tsx`
- Modify: `apps/controlplane/src/web/components/debug/__tests__/event-list-tab.test.tsx`

- [ ] **Step 1: 在 event-list-tab.test.tsx 新增失败测试**

在文件末尾追加（`mockEvent` 函数已在文件中定义，复用即可）：

```tsx
describe('GraphRunCompleted mermaid 联动', () => {
  test('选中 GraphRunCompleted 事件时，详情抽屉展示 mermaid 图', async () => {
    const runAggregateId = 'run-abc123'
    const mermaidText = 'flowchart TD\n  A-->B'

    useDebugStore.setState({
      panelOpen: true,
      tab: 'events',
      mode: 'history',
      events: [
        {
          ...mockEvent(2),
          type: 'GraphRunCompleted',
          aggregateType: 'GraphRun',
          aggregateId: runAggregateId,
          payload: { finalState: {}, runId: runAggregateId },
        },
        {
          ...mockEvent(1),
          type: 'GraphRunStarted',
          aggregateType: 'GraphRun',
          aggregateId: runAggregateId,
          payload: { mermaidDiagram: mermaidText, runId: runAggregateId },
        },
      ],
    })

    render(<EventListTab />)
    const rows = screen.getAllByTestId('event-row')

    // 第一行是 GraphRunCompleted（cursor 2，排在前面）
    fireEvent.click(rows[0]!)

    // mermaid-diagram 容器应出现
    await screen.findByTestId('mermaid-diagram')
  })

  test('选中非 GraphRunCompleted 事件时，不展示 mermaid 图', () => {
    useDebugStore.setState({
      panelOpen: true,
      tab: 'events',
      mode: 'history',
      events: [mockEvent(1)],
    })

    render(<EventListTab />)
    fireEvent.click(screen.getByTestId('event-row'))

    expect(screen.queryByTestId('mermaid-diagram')).toBeNull()
  })
})
```

在 `event-list-tab.test.tsx` 文件顶部（在所有 import 之前）加入 mermaid mock，避免 jsdom 环境下 mermaid 初始化失败：

```ts
import { vi } from 'vitest'

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg></svg>' }),
  },
}))
```

注意：Vitest 自动将 `vi.mock` 提升（hoist）到模块顶部，因此可以放在 import 语句之前写，也可以放在 describe 块外的顶层，效果相同。

- [ ] **Step 2: 运行测试确认失败**

```bash
cd /workspaces/dev_docker/tianji-ai/apps/controlplane
pnpm test -- --reporter=verbose src/web/components/debug/__tests__/event-list-tab.test.tsx
```

期望：新增测试 FAIL，已有测试 PASS。

- [ ] **Step 3: 更新 event-detail-drawer.tsx**

完整替换文件内容：

```tsx
import type { JSX } from 'react'

import type { DebugEvent } from '../../services/debug-api.js'
import { MermaidDiagram } from './mermaid-diagram.js'

interface Props {
  event: DebugEvent | null
  mermaidDiagram?: string | null
  onClose: () => void
}

/** 展示单个事件原始 envelope JSON 的侧边抽屉。GraphRunCompleted 时附加 mermaid 编排图。 */
export function EventDetailDrawer({ event, mermaidDiagram, onClose }: Props): JSX.Element | null {
  if (event === null) return null
  return (
    <div
      style={{
        position: 'absolute',
        right: 0,
        top: 0,
        bottom: 0,
        width: '45%',
        background: '#0f0f0f',
        borderLeft: '1px solid #333',
        padding: 12,
        overflow: 'auto',
      }}
    >
      <button type="button" onClick={onClose} aria-label="关闭详情">
        ×
      </button>
      {mermaidDiagram != null && <MermaidDiagram diagram={mermaidDiagram} />}
      <pre data-testid="event-detail-json" style={{ margin: 0, fontSize: 12 }}>
        {JSON.stringify(event, null, 2)}
      </pre>
    </div>
  )
}
```

- [ ] **Step 4: 更新 event-list-tab.tsx**

完整替换文件内容：

```tsx
import type { JSX, UIEvent } from 'react'
import { useRef, useState } from 'react'

import type { DebugEvent } from '../../services/debug-api.js'
import { MAX_EVENTS, useDebugStore } from '../../stores/debug-store.js'
import { EventDetailDrawer } from './event-detail-drawer.js'
import { useHistoryPagination } from './hooks/use-history-pagination.js'

const SCROLL_THRESHOLD_PX = 200

/** 选中 GraphRunCompleted 事件时，从 store 找同 aggregateId 的 GraphRunStarted，取其 mermaidDiagram。 */
function findMermaidDiagram(
  selectedEvent: DebugEvent,
  events: DebugEvent[]
): string | null {
  if (selectedEvent.type !== 'GraphRunCompleted') return null
  const started = events.find(
    (e) => e.type === 'GraphRunStarted' && e.aggregateId === selectedEvent.aggregateId
  )
  return (started?.payload.mermaidDiagram as string | undefined) ?? null
}

/** 事件列表主体 Tab，含降序渲染、溢出提示、错误 banner 与历史分页。 */
export function EventListTab(): JSX.Element {
  const events = useDebugStore((s) => s.events)
  const lastError = useDebugStore((s) => s.lastError)
  const reachedEnd = useDebugStore((s) => s.historyReachedEnd)
  const reportFailure = useDebugStore((s) => s.reportFailure)
  const loadMore = useHistoryPagination()
  const [selected, setSelected] = useState<DebugEvent | null>(null)
  const [mermaidDiagram, setMermaidDiagram] = useState<string | null>(null)
  const loadingRef = useRef(false)

  const handleSelect = (ev: DebugEvent): void => {
    setSelected(ev)
    setMermaidDiagram(findMermaidDiagram(ev, events))
  }

  const handleClose = (): void => {
    setSelected(null)
    setMermaidDiagram(null)
  }

  const onScroll = (e: UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    if (el.scrollHeight - el.scrollTop - el.clientHeight > SCROLL_THRESHOLD_PX) return
    if (loadingRef.current || reachedEnd) return
    loadingRef.current = true
    loadMore()
      .catch((err: unknown) => {
        reportFailure(err instanceof Error ? err.message : 'unknown')
      })
      .finally(() => {
        loadingRef.current = false
      })
  }

  return (
    <div style={{ position: 'relative', height: '100%' }}>
      {lastError !== null && (
        <output
          aria-live="polite"
          style={{ display: 'block', background: '#5a1f1f', color: '#fff', padding: 6 }}
        >
          轮询失败：{lastError}
        </output>
      )}
      {events.length >= MAX_EVENTS && (
        <div style={{ background: '#3a3a1f', color: '#fff', padding: 6 }}>
          已加载 3000 条达到上限，如需继续请缩小时间范围。
        </div>
      )}
      <div
        data-testid="event-list-scroll"
        onScroll={onScroll}
        style={{ overflowY: 'auto', height: 'calc(100% - 40px)' }}
      >
        {events.map((ev) => (
          <button
            key={ev.eventId}
            type="button"
            data-testid="event-row"
            onClick={() => handleSelect(ev)}
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              cursor: 'pointer',
              padding: '4px 8px',
              borderBottom: '1px solid #222',
              fontFamily: 'monospace',
              fontSize: 12,
              background: 'transparent',
              border: 'none',
              color: 'inherit',
            }}
          >
            {ev.occurredAt} · {ev.type} · {ev.aggregateType} · {ev.aggregateId.slice(0, 12)} · #
            {ev.cursor} · {ev.eventId}
          </button>
        ))}
        {reachedEnd && <div style={{ padding: 8, color: '#888' }}>已到底部</div>}
      </div>
      <EventDetailDrawer event={selected} mermaidDiagram={mermaidDiagram} onClose={handleClose} />
    </div>
  )
}
```

- [ ] **Step 5: 运行所有 debug 组件测试**

```bash
cd /workspaces/dev_docker/tianji-ai/apps/controlplane
pnpm test -- --reporter=verbose src/web/components/debug/__tests__/
```

期望：全部 PASS（含原有 event-list-tab 测试 + 新增 mermaid 联动测试）。

- [ ] **Step 6: 运行 pnpm check**

```bash
cd /workspaces/dev_docker/tianji-ai
pnpm check
```

期望：无错误、无警告。

- [ ] **Step 7: Commit**

```bash
git add apps/controlplane/src/web/components/debug/event-detail-drawer.tsx
git add apps/controlplane/src/web/components/debug/event-list-tab.tsx
git add apps/controlplane/src/web/components/debug/__tests__/event-list-tab.test.tsx
```

提交信息：`feat(debug): GraphRunCompleted 事件详情展示 mermaid 编排图`
