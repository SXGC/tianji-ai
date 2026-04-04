# Controlplane SPA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `apps/controlplane` 中接入 `src/web/` React SPA，并由现有 Hono 服务同源提供最小聊天界面。

**Architecture:** 保留现有 `/api/*` 后端接口，新增 Vite 构建的前端产物目录 `dist/web`，并通过新的 web 路由返回静态资源与 `index.html`。前端使用单路由首页，依赖现有 REST/SSE 完成节点选择、task 创建、流式消息展示与 session 复用。

**Tech Stack:** TypeScript, Hono, Vite, React, React DOM, TanStack Router, TanStack Query, Vitest, Biome

---

## File Map

- Modify: `apps/controlplane/package.json`
  - 增加 web 依赖与构建脚本
- Create: `apps/controlplane/vite.config.ts`
  - Vite 构建配置，输出到 `dist/web`
- Create: `apps/controlplane/src/routes/web-ui.ts`
  - 提供静态文件与 SPA fallback
- Modify: `apps/controlplane/src/app.ts`
  - 移除内联 HTML 页面路由，接入 web-ui 路由
- Delete: `apps/controlplane/src/routes/ui-chat-page.ts`
  - 删除临时 HTML 实现
- Modify: `apps/controlplane/src/__tests__/app.test.ts`
  - 改为断言 SPA shell
- Create: `apps/controlplane/src/web/index.html`
  - SPA HTML 模板
- Create: `apps/controlplane/src/web/main.tsx`
  - React 入口
- Create: `apps/controlplane/src/web/router.tsx`
  - TanStack Router 配置
- Create: `apps/controlplane/src/web/routes/__root.tsx`
  - 根路由布局
- Create: `apps/controlplane/src/web/routes/index.tsx`
  - 聊天首页
- Create: `apps/controlplane/src/web/components/chat-shell.tsx`
  - 首页主布局
- Create: `apps/controlplane/src/web/components/node-list.tsx`
  - 节点列表
- Create: `apps/controlplane/src/web/components/message-list.tsx`
  - 消息列表
- Create: `apps/controlplane/src/web/components/chat-composer.tsx`
  - 输入区
- Create: `apps/controlplane/src/web/lib/api.ts`
  - REST 请求与类型
- Create: `apps/controlplane/src/web/lib/query-client.ts`
  - QueryClient 工厂
- Create: `apps/controlplane/src/web/lib/task-stream.ts`
  - SSE 订阅封装
- Create: `apps/controlplane/src/web/styles.css`
  - 最小样式
- Modify: `README.md`
  - 更新 controlplane 浏览器入口说明

### Task 1: 调整 server 根路由测试为 SPA shell

**Files:**
- Modify: `apps/controlplane/src/__tests__/app.test.ts`
- Test: `apps/controlplane/src/__tests__/app.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
it('returns the controlplane spa shell at root', async () => {
  const db = createDatabase(':memory:')
  const { app, monitor } = createApp(db)

  const response = await app.request('http://localhost/')
  const html = await response.text()

  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/html')
  expect(html).toContain('<div id="root"></div>')
  expect(html).toContain('/src/web/main.tsx')

  monitor.stop()
  db.close()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tianji/controlplane test -- src/__tests__/app.test.ts --reporter=verbose`

Expected: FAIL，因为当前仍返回内联 HTML，断言中不会包含 `<div id="root"></div>` 与 `/src/web/main.tsx`

- [ ] **Step 3: Write minimal implementation**

先只修改测试，不改实现。此步无生产代码改动，进入下一任务实现最小 server 支撑。

- [ ] **Step 4: Run test to verify it still fails for the expected reason**

Run: `pnpm --filter @tianji/controlplane test -- src/__tests__/app.test.ts --reporter=verbose`

Expected: FAIL，失败原因仍为缺少 SPA shell 内容，而不是语法错误或类型错误。

- [ ] **Step 5: Commit**

```bash
git add apps/controlplane/src/__tests__/app.test.ts
git commit -m "test: define controlplane spa shell root response"
```

### Task 2: 以最小方式提供 SPA shell 与静态路由

**Files:**
- Create: `apps/controlplane/src/routes/web-ui.ts`
- Modify: `apps/controlplane/src/app.ts`
- Delete: `apps/controlplane/src/routes/ui-chat-page.ts`
- Test: `apps/controlplane/src/__tests__/app.test.ts`

- [ ] **Step 1: Write the failing test**

在 `apps/controlplane/src/__tests__/app.test.ts` 追加静态资源测试：

```ts
it('does not intercept api routes when serving web ui', async () => {
  const db = createDatabase(':memory:')
  const { app, monitor } = createApp(db)

  const response = await app.request('http://localhost/api/ui/nodes')

  expect(response.status).not.toBe(200)
  expect(response.headers.get('content-type') ?? '').not.toContain('text/html')

  monitor.stop()
  db.close()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tianji/controlplane test -- src/__tests__/app.test.ts --reporter=verbose`

Expected: FAIL，根路由断言不满足，或 web fallback 还不存在。

- [ ] **Step 3: Write minimal implementation**

创建 `apps/controlplane/src/routes/web-ui.ts`：

```ts
import { existsSync, readFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

import { Hono } from 'hono'

const WEB_DIST_DIR = resolve(process.cwd(), 'dist/web')
const WEB_SRC_DIR = resolve(process.cwd(), 'src/web')

function getContentType(filePath: string): string {
  const extension = extname(filePath)
  if (extension === '.js') {
    return 'text/javascript; charset=utf-8'
  }
  if (extension === '.css') {
    return 'text/css; charset=utf-8'
  }
  return 'text/html; charset=utf-8'
}

function readWebFile(relativePath: string): { content: string; contentType: string } | null {
  const normalizedPath = relativePath === '/' ? '/index.html' : relativePath
  const distPath = join(WEB_DIST_DIR, normalizedPath)
  if (existsSync(distPath)) {
    return {
      content: readFileSync(distPath, 'utf8'),
      contentType: getContentType(distPath),
    }
  }

  const srcPath = join(WEB_SRC_DIR, normalizedPath)
  if (existsSync(srcPath)) {
    return {
      content: readFileSync(srcPath, 'utf8'),
      contentType: getContentType(srcPath),
    }
  }

  return null
}

export function createWebUiRoute(): Hono {
  const app = new Hono()

  app.get('*', (c) => {
    const requestPath = c.req.path
    if (requestPath.startsWith('/api/')) {
      return c.notFound()
    }

    const asset = readWebFile(requestPath)
    if (asset !== null) {
      return c.body(asset.content, 200, {
        'content-type': asset.contentType,
      })
    }

    const indexFile = readWebFile('/index.html')
    if (indexFile === null) {
      return c.text('Controlplane web UI is not built', 503)
    }

    return c.body(indexFile.content, 200, {
      'content-type': 'text/html; charset=utf-8',
    })
  })

  return app
}
```

修改 `apps/controlplane/src/app.ts`：

```ts
import { createWebUiRoute } from './routes/web-ui.js'

export function createApp(db: ControlPlaneDb): ControlPlaneApp {
  const app = new Hono()

  app.get('/health', (c) => c.json({ status: 'ok' }))

  app.route('/', createNodeRegisterRoute(db))
  app.route('/', createNodeHeartbeatRoute(db))
  app.route('/', createCommandPollRoute(db))
  app.route('/', createTaskEventsRoute(db))
  app.route('/', createUiNodesRoute(db))
  app.route('/', createUiTasksRoute(db))
  app.route('/', createUiSessionsRoute(db))
  app.route('/', createUiTaskEventsRoute(db))
  app.route('/', createTaskStreamRoute(db))
  app.route('/', createWebUiRoute())

  return {
    app,
    monitor: new ObservationMonitor(db),
  }
}
```

删除 `apps/controlplane/src/routes/ui-chat-page.ts`

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tianji/controlplane test -- src/__tests__/app.test.ts --reporter=verbose`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/controlplane/src/app.ts apps/controlplane/src/routes/web-ui.ts apps/controlplane/src/__tests__/app.test.ts apps/controlplane/src/routes/ui-chat-page.ts
git commit -m "feat: serve controlplane web ui shell"
```

### Task 3: 引入 Vite + React + TanStack 基础前端壳

**Files:**
- Modify: `apps/controlplane/package.json`
- Create: `apps/controlplane/vite.config.ts`
- Create: `apps/controlplane/src/web/index.html`
- Create: `apps/controlplane/src/web/main.tsx`
- Create: `apps/controlplane/src/web/router.tsx`
- Create: `apps/controlplane/src/web/routes/__root.tsx`
- Create: `apps/controlplane/src/web/routes/index.tsx`
- Create: `apps/controlplane/src/web/lib/query-client.ts`
- Create: `apps/controlplane/src/web/styles.css`
- Test: `apps/controlplane/src/__tests__/app.test.ts`

- [ ] **Step 1: Write the failing test**

继续使用 Task 1 的根路由断言，不新增新的自动化测试。先让 `pnpm check` 在缺少 web 依赖和 TS 文件时失败。

- [ ] **Step 2: Run check to verify it fails**

Run: `pnpm check`

Expected: FAIL，原因是前端入口文件或依赖未定义。

- [ ] **Step 3: Write minimal implementation**

修改 `apps/controlplane/package.json`：

```json
{
  "scripts": {
    "build": "pnpm build:web && tsc --project tsconfig.build.json",
    "build:web": "vite build",
    "typecheck": "tsc --noEmit && tsc --project tsconfig.web.json --noEmit"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.66.9",
    "@tanstack/react-router": "^1.120.5",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.10",
    "@types/react-dom": "^19.0.4",
    "@vitejs/plugin-react": "^4.3.4",
    "vite": "^6.2.0"
  }
}
```

创建 `apps/controlplane/vite.config.ts`：

```ts
import { resolve } from 'node:path'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, 'src/web'),
  build: {
    outDir: resolve(__dirname, 'dist/web'),
    emptyOutDir: false,
  },
})
```

创建 `apps/controlplane/src/web/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Tianji Controlplane</title>
    <script type="module" src="/main.tsx"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
```

创建 `apps/controlplane/src/web/main.tsx`：

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'

import { queryClient } from './lib/query-client'
import { router } from './router'
import './styles.css'

const rootElement = document.getElementById('root')

if (rootElement === null) {
  throw new Error('Missing root element')
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>
)
```

创建 `apps/controlplane/src/web/lib/query-client.ts`：

```ts
import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient()
```

创建 `apps/controlplane/src/web/routes/__root.tsx`：

```tsx
import { Outlet, createRootRoute } from '@tanstack/react-router'

export const Route = createRootRoute({
  component: () => <Outlet />,
})
```

创建 `apps/controlplane/src/web/routes/index.tsx`：

```tsx
export function IndexRouteComponent() {
  return <main>Tianji Controlplane</main>
}
```

创建 `apps/controlplane/src/web/routes/__root.tsx`：

```tsx
import { Outlet } from '@tanstack/react-router'

export function RootRouteComponent() {
  return <Outlet />
}
```

创建 `apps/controlplane/src/web/router.tsx`：

```tsx
import { createRouter, createRoute, createRootRoute } from '@tanstack/react-router'

import { RootRouteComponent } from './routes/__root'
import { IndexRouteComponent } from './routes/index'

const rootRoute = createRootRoute({
  component: RootRouteComponent,
})

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: IndexRouteComponent,
})

const routeTree = rootRoute.addChildren([indexRoute])

export const router = createRouter({ routeTree })
```

创建 `apps/controlplane/src/web/styles.css`：

```css
:root {
  color-scheme: dark;
  font-family: Inter, system-ui, sans-serif;
  background: #0b1020;
  color: #edf2ff;
}

body {
  margin: 0;
}
```

- [ ] **Step 4: Run check to verify it passes**

Run: `pnpm check`

Expected: PASS，或出现明确的前端类型问题后在当前任务内修正到通过

- [ ] **Step 5: Commit**

```bash
git add apps/controlplane/package.json apps/controlplane/vite.config.ts apps/controlplane/src/web
git commit -m "feat: scaffold controlplane react spa"
```

### Task 4: 实现最小聊天数据访问与 SSE 封装

**Files:**
- Create: `apps/controlplane/src/web/lib/api.ts`
- Create: `apps/controlplane/src/web/lib/task-stream.ts`
- Test: `apps/controlplane/src/routes/__tests__/task-stream.test.ts`

- [ ] **Step 1: Write the failing test**

在 `apps/controlplane/src/routes/__tests__/task-stream.test.ts` 已有 `agent.message.delta` 覆盖基础上，再追加 session 事件断言：

```ts
it('streams lifecycle session attach events', async () => {
  const app = setup()
  const response = await app.request('/api/ui/tasks/task-1/stream', {
    headers: { Accept: 'text/event-stream' },
  })

  const text = await response.text()
  expect(text).toContain('event: task.lifecycle')
})
```

- [ ] **Step 2: Run test to verify it fails only if coverage is missing**

Run: `pnpm --filter @tianji/controlplane test -- src/routes/__tests__/task-stream.test.ts --reporter=verbose`

Expected: 若当前覆盖已满足，可直接 PASS；若失败，先补最小后端支撑后继续。

- [ ] **Step 3: Write minimal implementation**

创建 `apps/controlplane/src/web/lib/api.ts`：

```ts
export interface UiNodeAgent {
  readonly agentId: string
}

export interface UiNode {
  readonly nodeId: string
  readonly hostname: string
  readonly status: string
  readonly agents: readonly UiNodeAgent[]
}

export interface CreatedTask {
  readonly taskId: string
}

export async function fetchNodes(): Promise<readonly UiNode[]> {
  const response = await fetch('/api/ui/nodes')
  if (!response.ok) {
    throw new Error(`Failed to fetch nodes: ${response.status}`)
  }
  return (await response.json()) as UiNode[]
}

export async function createTask(input: {
  readonly nodeId: string
  readonly agentId: string
  readonly goal: string
  readonly sessionId: string | null
}): Promise<CreatedTask> {
  const response = await fetch('/api/ui/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      nodeId: input.nodeId,
      agentId: input.agentId,
      goal: input.goal,
      sessionIds: input.sessionId === null ? undefined : [input.sessionId],
    }),
  })

  if (!response.ok) {
    throw new Error(await response.text())
  }

  return (await response.json()) as CreatedTask
}
```

创建 `apps/controlplane/src/web/lib/task-stream.ts`：

```ts
export interface TaskStreamHandlers {
  readonly onSessionAttached: (sessionId: string) => void
  readonly onMessageDelta: (delta: string) => void
  readonly onDone: () => void
  readonly onError: () => void
}

/**
 * 订阅 task SSE，并将生命周期与消息增量映射为前端回调。
 */
export function streamTask(taskId: string, handlers: TaskStreamHandlers): () => void {
  const eventSource = new EventSource(`/api/ui/tasks/${encodeURIComponent(taskId)}/stream`)

  eventSource.addEventListener('task.lifecycle', (event) => {
    const data = JSON.parse(event.data) as {
      payload?: {
        type?: string
        sessionId?: string
      }
    }

    if (
      data.payload?.type === 'task.session.attached' &&
      typeof data.payload.sessionId === 'string'
    ) {
      handlers.onSessionAttached(data.payload.sessionId)
    }
  })

  eventSource.addEventListener('agent.message.delta', (event) => {
    const data = JSON.parse(event.data) as {
      payload?: {
        payload?: {
          content?: string
        }
      }
    }

    if (typeof data.payload?.payload?.content === 'string') {
      handlers.onMessageDelta(data.payload.payload.content)
    }
  })

  eventSource.addEventListener('done', () => {
    handlers.onDone()
    eventSource.close()
  })

  eventSource.onerror = () => {
    handlers.onError()
    eventSource.close()
  }

  return () => {
    eventSource.close()
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @tianji/controlplane test -- src/routes/__tests__/task-stream.test.ts --reporter=verbose`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/controlplane/src/web/lib/api.ts apps/controlplane/src/web/lib/task-stream.ts apps/controlplane/src/routes/__tests__/task-stream.test.ts
git commit -m "feat: add controlplane web data clients"
```

### Task 5: 实现最小聊天 UI 组件与首页状态流转

**Files:**
- Create: `apps/controlplane/src/web/components/chat-shell.tsx`
- Create: `apps/controlplane/src/web/components/node-list.tsx`
- Create: `apps/controlplane/src/web/components/message-list.tsx`
- Create: `apps/controlplane/src/web/components/chat-composer.tsx`
- Modify: `apps/controlplane/src/web/routes/index.tsx`
- Modify: `apps/controlplane/src/web/styles.css`

- [ ] **Step 1: Write the failing test**

本轮不新增前端测试框架。先通过 `pnpm check` 捕获类型与导入错误。

- [ ] **Step 2: Run check to verify it fails before UI exists**

Run: `pnpm check`

Expected: FAIL，因为 `index.tsx` 还未接入真实页面或引用缺失。

- [ ] **Step 3: Write minimal implementation**

创建 `apps/controlplane/src/web/components/node-list.tsx`：

```tsx
import type { UiNode } from '../lib/api'

interface NodeListProps {
  readonly nodes: readonly UiNode[]
  readonly selectedNodeId: string | null
  readonly onSelect: (nodeId: string, agentId: string | null) => void
}

export function NodeList(props: NodeListProps) {
  return (
    <div className="node-list">
      {props.nodes.map((node) => {
        const firstAgent = node.agents[0]
        const disabled = node.status !== 'online' || firstAgent === undefined
        const active = node.nodeId === props.selectedNodeId

        return (
          <button
            key={node.nodeId}
            className={active ? 'node-item active' : 'node-item'}
            disabled={disabled}
            onClick={() => props.onSelect(node.nodeId, firstAgent?.agentId ?? null)}
            type="button"
          >
            <strong>{node.hostname}</strong>
            <div className="node-meta">
              {node.nodeId} · {node.status} · agents: {node.agents.length}
            </div>
          </button>
        )
      })}
    </div>
  )
}
```

创建 `apps/controlplane/src/web/components/message-list.tsx`：

```tsx
export interface ChatMessage {
  readonly id: string
  readonly role: 'user' | 'assistant' | 'system'
  readonly text: string
}

interface MessageListProps {
  readonly messages: readonly ChatMessage[]
}

export function MessageList(props: MessageListProps) {
  return (
    <section className="messages">
      {props.messages.map((message) => (
        <article key={message.id} className={`bubble ${message.role}`}>
          {message.text}
        </article>
      ))}
    </section>
  )
}
```

创建 `apps/controlplane/src/web/components/chat-composer.tsx`：

```tsx
import { FormEvent, useState } from 'react'

interface ChatComposerProps {
  readonly disabled: boolean
  readonly onSubmit: (value: string) => Promise<void>
}

export function ChatComposer(props: ChatComposerProps) {
  const [value, setValue] = useState('')

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextValue = value.trim()
    if (nextValue.length === 0) {
      return
    }

    setValue('')
    await props.onSubmit(nextValue)
  }

  return (
    <form className="composer" onSubmit={(event) => void handleSubmit(event)}>
      <textarea
        disabled={props.disabled}
        onChange={(event) => setValue(event.target.value)}
        placeholder="输入你的任务或问题"
        value={value}
      />
      <button disabled={props.disabled} type="submit">
        发送
      </button>
    </form>
  )
}
```

创建 `apps/controlplane/src/web/components/chat-shell.tsx`：

```tsx
import type { UiNode } from '../lib/api'
import { ChatComposer } from './chat-composer'
import { type ChatMessage, MessageList } from './message-list'
import { NodeList } from './node-list'

interface ChatShellProps {
  readonly nodes: readonly UiNode[]
  readonly selectedNodeId: string | null
  readonly selectedAgentId: string | null
  readonly sessionId: string | null
  readonly messages: readonly ChatMessage[]
  readonly statusText: string
  readonly sending: boolean
  readonly onSelectNode: (nodeId: string, agentId: string | null) => void
  readonly onSubmit: (value: string) => Promise<void>
}

export function ChatShell(props: ChatShellProps) {
  return (
    <div className="chat-app">
      <aside className="sidebar">
        <h1 className="brand">Tianji</h1>
        <p className="subtitle">Controlplane 最小聊天页</p>
        <div className="status">{props.statusText}</div>
        <NodeList
          nodes={props.nodes}
          onSelect={props.onSelectNode}
          selectedNodeId={props.selectedNodeId}
        />
      </aside>
      <main className="chat">
        <header className="chat-header">
          <div>
            <h2>{props.selectedNodeId ?? '选择一个在线节点'}</h2>
            <p>{props.selectedAgentId === null ? '当前没有可用 agent' : `agent: ${props.selectedAgentId}`}</p>
          </div>
          <div className="session-pill">
            {props.sessionId === null ? 'session: 未建立' : `session: ${props.sessionId}`}
          </div>
        </header>
        <MessageList messages={props.messages} />
        <ChatComposer disabled={props.sending} onSubmit={props.onSubmit} />
      </main>
    </div>
  )
}
```

修改 `apps/controlplane/src/web/routes/index.tsx`：

```tsx
import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { ChatShell } from '../components/chat-shell'
import { type ChatMessage } from '../components/message-list'
import { createTask, fetchNodes } from '../lib/api'
import { streamTask } from '../lib/task-stream'

export function IndexRouteComponent() {
  const { data: nodes = [], error } = useQuery({
    queryKey: ['ui-nodes'],
    queryFn: fetchNodes,
  })
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sending, setSending] = useState(false)
  const streamCleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (selectedNodeId !== null) {
      return
    }
    const firstOnlineNode = nodes.find((node) => node.status === 'online' && node.agents[0] !== undefined)
    if (firstOnlineNode !== undefined) {
      setSelectedNodeId(firstOnlineNode.nodeId)
      setSelectedAgentId(firstOnlineNode.agents[0]?.agentId ?? null)
    }
  }, [nodes, selectedNodeId])

  useEffect(() => {
    return () => {
      streamCleanupRef.current?.()
    }
  }, [])

  async function handleSubmit(value: string): Promise<void> {
    if (selectedNodeId === null || selectedAgentId === null) {
      setMessages((current) => [
        ...current,
        { id: `system-${Date.now()}`, role: 'system', text: '请先选择一个在线节点。' },
      ])
      return
    }

    const assistantId = `assistant-${Date.now()}`
    setMessages((current) => [
      ...current,
      { id: `user-${Date.now()}`, role: 'user', text: value },
      { id: assistantId, role: 'assistant', text: '' },
    ])
    setSending(true)

    try {
      const createdTask = await createTask({
        nodeId: selectedNodeId,
        agentId: selectedAgentId,
        goal: value,
        sessionId,
      })

      streamCleanupRef.current?.()
      streamCleanupRef.current = streamTask(createdTask.taskId, {
        onSessionAttached: (nextSessionId) => {
          setSessionId(nextSessionId)
        },
        onMessageDelta: (delta) => {
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId ? { ...message, text: message.text + delta } : message
            )
          )
        },
        onDone: () => {
          setSending(false)
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId && message.text.trim().length === 0
                ? { ...message, text: '任务已完成，但当前没有可显示的文本输出。' }
                : message
            )
          )
        },
        onError: () => {
          setSending(false)
        },
      })
    } catch (submitError) {
      setSending(false)
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                text: submitError instanceof Error ? submitError.message : String(submitError),
              }
            : message
        )
      )
    }
  }

  return (
    <ChatShell
      messages={messages}
      nodes={nodes}
      onSelectNode={(nodeId, agentId) => {
        setSelectedNodeId(nodeId)
        setSelectedAgentId(agentId)
        setSessionId(null)
      }}
      onSubmit={handleSubmit}
      selectedAgentId={selectedAgentId}
      selectedNodeId={selectedNodeId}
      sending={sending}
      sessionId={sessionId}
      statusText={error instanceof Error ? error.message : '选择一个在线节点开始。'}
    />
  )
}
```

- [ ] **Step 4: Run check to verify it passes**

Run: `pnpm check`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/controlplane/src/web/components apps/controlplane/src/web/routes/index.tsx apps/controlplane/src/web/styles.css
git commit -m "feat: build controlplane chat spa"
```

### Task 6: 打通 Vite 构建与回归验证

**Files:**
- Modify: `apps/controlplane/package.json`
- Modify: `README.md`

- [ ] **Step 1: Write the failing verification**

Run: `pnpm --filter @tianji/controlplane build`

Expected: 在未完全接好构建路径前可能 FAIL，例如输出目录、Vite root、类型配置等问题。

- [ ] **Step 2: Fix minimal build issues**

若需要，补充 `apps/controlplane/tsconfig.web.json`：

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "jsx": "react-jsx",
    "noEmit": true
  },
  "include": ["src/web/**/*.ts", "src/web/**/*.tsx", "vite.config.ts"]
}
```

并根据实际构建错误修正 `package.json` 中 `typecheck` 或 `build:web` 命令。

更新 `README.md`，补充一段最小说明：

```md
### Controlplane Web UI

`apps/controlplane` 现在会在 `/` 提供浏览器聊天界面。启动 controlplane 与 node 后，可直接访问 `http://127.0.0.1:3100/`，选择在线节点并发送 task。
```

- [ ] **Step 3: Run full verification**

Run: `pnpm --filter @tianji/controlplane test -- --reporter=verbose`

Expected: PASS

- [ ] **Step 4: Run repo verification**

Run: `pnpm check`

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/controlplane/package.json apps/controlplane/tsconfig.web.json README.md
git commit -m "docs: document controlplane web ui entrypoint"
```

## Self-Review

- Spec coverage:
  - SPA 目录与技术栈：Task 3
  - Hono serve SPA：Task 2
  - 节点选择、task 创建、SSE、session 复用：Task 4-5
  - README 更新：Task 6
  - 回归验证：Task 6
- Placeholder scan:
  - 无 `TODO` / `TBD`
  - 所有任务都给出明确文件与命令
- Type consistency:
  - 统一使用 `sessionId` 前端状态，并映射到 `sessionIds`
  - 统一使用 `agent.message.delta` 作为前端监听事件名
