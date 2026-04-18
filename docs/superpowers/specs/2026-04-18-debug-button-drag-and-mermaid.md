# Debug 按钮拖动 + GraphRunCompleted Mermaid 渲染

## 背景

两个独立的 Debug 面板增强功能：
1. 右下角 Debug 按钮支持拖动，避免遮挡内容
2. 在事件详情抽屉中，点击 `GraphRunCompleted` 事件时展示该次 GraphRun 的编排图（Mermaid 渲染）

---

## 功能一：Debug 按钮可拖动

### 现状

`DebugToggleButton`（`debug-toggle-button.tsx`）是 `position: fixed; right: 16px; bottom: 16px` 的静态按钮，不可移动。

### 设计

新建 hook `use-draggable.ts`（`apps/controlplane/src/web/components/debug/hooks/`），只管 `(x, y)` 坐标，不包含 resize / minimize 状态（区别于 `use-debug-window.ts`）。

**接口：**
```ts
interface UseDraggableOptions {
  initialX: number
  initialY: number
}

interface UseDraggableResult {
  x: number
  y: number
  startDrag: (e: PointerEvent) => void
}
```

**行为：**
- `pointerdown` 在按钮本身注册，记录 `(e.clientX - x, e.clientY - y)` 作为偏移量
- `pointermove` / `pointerup` 挂在 `document` 上（`setPointerCapture` 确保拖出窗口不丢失）
- 坐标存 React `useState`，不持久化（刷新回默认位置）

**初始位置：**
- `initialX = window.innerWidth - 80`，`initialY = window.innerHeight - 52`（等效于右下角）

**`DebugToggleButton` 改动：**
- 从 `right/bottom` 改为 `left/top`，值来自 `use-draggable` 返回的 `x, y`
- 整个按钮的 `onPointerDown` 触发 `startDrag`

### 边界

- 不做边界夹紧（拖出屏幕外由用户负责，Keep It Simple）
- `use-debug-window.ts` 不改动，两个 hook 独立共存

---

## 功能二：GraphRunCompleted 展示 Mermaid 图

### 现状

- `GraphRunStartedEvent` 没有 mermaid 字段
- `graph-runner.ts` 通过 `onMermaid` 回调发出 mermaid 文本，不进入事件流
- `EventDetailDrawer` 只展示原始 JSON

### 数据流设计

**后端（packages 层）：**

1. `GraphRunStartedEvent`（`packages/shared/src/events/graph-run.ts`）加字段：
   ```ts
   readonly mermaidDiagram: string
   ```

2. `graph-runner.ts` 在发出 `GraphRunStarted` 事件时，同时生成 mermaid 文本并写入：
   ```ts
   const mermaidDiagram = renderOrchestrationGraphMermaid(options.graph)
   if (options.onMermaid !== undefined) {
     options.onMermaid(mermaidDiagram)
   }
   emit({ type: 'GraphRunStarted', ..., mermaidDiagram })
   ```
   `onMermaid` 回调保留（不破坏现有调用方）。

**前端（event detail 层）：**

事件抵达前端时，`DebugEvent.payload` 是完整的序列化事件对象。`GraphRunStarted` 的 payload 里包含 `mermaidDiagram: string`。

`EventDetailDrawer` 增强逻辑：
- 若 `event.type === 'GraphRunCompleted'`：
  1. 从 `useDebugStore` 的 `events` 列表中，按 `aggregateId === event.aggregateId` 找到同一 GraphRun 的 `GraphRunStarted` 事件
  2. 取 `startedEvent.payload.mermaidDiagram as string`
  3. 若找到则渲染 Mermaid 图，否则不展示

### Mermaid 渲染组件

新建 `MermaidDiagram`（`apps/controlplane/src/web/components/debug/mermaid-diagram.tsx`）：

- 接受 `diagram: string` prop
- 在 `useEffect` 里调用 `mermaid.render(id, diagram)` 获取 SVG 字符串
- 用 `dangerouslySetInnerHTML` 注入 SVG（SVG 由 mermaid 库生成，非用户输入，可接受）
- `mermaid.initialize({ startOnLoad: false, theme: 'dark' })` 在模块顶层调用一次

**依赖：**
- `mermaid@11.14.0` 已在 pnpm store（CopilotKit 间接依赖），加为 `apps/controlplane` 的 direct dep

### EventDetailDrawer 布局

展示 GraphRunCompleted 时，抽屉分两块：
1. 顶部：Mermaid 图（若有）
2. 底部：原始 JSON（与现有一致）

---

## 不改动范围

- `use-debug-window.ts`：不改，职责仅限 panel
- `debug-store.ts`：不改，只读 events 查找 GraphRunStarted
- `GraphRunCompleted` 事件结构：不改，mermaid 信息来自 `GraphRunStarted`
- `onMermaid` 回调：保留，不破坏现有调用方

---

## 测试

- `use-draggable`：单元测试 pointerdown/move/up 坐标计算
- `MermaidDiagram`：单元测试 mocked mermaid，验证 render 被调用
- `EventDetailDrawer`：集成测试，给定 GraphRunCompleted + 对应 GraphRunStarted 在 store 里，验证 mermaid 图区域渲染
- `graph-runner`：现有测试回归，确认 GraphRunStarted 事件包含 mermaidDiagram
