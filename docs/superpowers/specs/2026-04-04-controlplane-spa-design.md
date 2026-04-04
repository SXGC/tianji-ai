# Controlplane SPA Design

## Goal

在 `apps/controlplane` 内新增一个可构建、可由 Hono 同源提供的 SPA，替换现有内联 HTML 聊天页。该 SPA 使用 `Vite + React + TanStack Router + TanStack Query`，通过现有 `/api/ui/*` 与 `/api/ui/tasks/:taskId/stream` 完成最小聊天闭环：选择在线节点、创建 task、订阅 SSE、展示 `message.delta`、复用 `sessionId`。

## Non-Goals

- 本轮不拆分 `/nodes`、`/sessions` 等多页面信息架构
- 本轮不实现独立前端 dev server 联调体验优化
- 本轮不新增反向查询聊天历史能力
- 本轮不改动现有 node/controlplane 协议，只消费既有 REST 与 SSE 接口

## Constraints

- 前端源码目录必须为 `apps/controlplane/src/web/`
- 后端仍由 `apps/controlplane` 的 Hono 应用统一提供 `/api/*`
- 非 `/api/*` 请求需要返回 SPA 页面，以支持浏览器直接访问 `/`
- 代码变更后必须通过 `pnpm check`
- 前端与后端均保持 TypeScript，禁止通过 `any` 绕过类型问题

## Architecture

采用单包内嵌 SPA 方案：`apps/controlplane` 同时承载 server 与 web 两套入口。Vite 负责构建 `src/web` 到 `dist/web`，后端继续由 `tsc` 构建到 `dist`。运行时由 Hono 提供 `/api/*` 路由，同时对静态资源路径提供文件返回，并对其他非 `/api/*` 路径 fallback 到 `dist/web/index.html`。

前端采用单路由结构，首页直接渲染聊天界面。节点列表通过 TanStack Query 从 `/api/ui/nodes` 拉取；发送消息通过 `POST /api/ui/tasks` 创建 task；task 创建后通过浏览器 `EventSource` 订阅 `/api/ui/tasks/:taskId/stream`；SSE 中的 `task.lifecycle` 用于提取 `task.session.attached.sessionId`，`agent.message.delta` 用于增量拼接 assistant 输出。

## Components

### Server Integration

- `src/app.ts`
  - 移除临时内联 HTML 路由接入
  - 保留现有 API 路由装配
  - 新增 SPA 静态资源与 fallback 路由装配
- `src/routes/web-ui.ts`
  - 负责返回 `dist/web` 下的静态资源与 `index.html`
  - 仅处理非 `/api/*` 请求

### Frontend Entry

- `src/web/main.tsx`
  - 创建 React 根节点
  - 挂载 QueryClientProvider 与 RouterProvider
- `src/web/router.tsx`
  - 定义最小 TanStack Router 路由树
- `src/web/routes/__root.tsx`
  - 导出根布局组件，供 `router.tsx` 复用
- `src/web/routes/index.tsx`
  - 导出首页组件，供 `router.tsx` 复用

### Frontend Domain Modules

- `src/web/lib/api.ts`
  - 定义节点列表与 task 创建的请求函数及类型
- `src/web/lib/task-stream.ts`
  - 封装 EventSource 订阅，统一处理 `task.lifecycle`、`agent.message.delta`、`done` 与超时清理
- `src/web/lib/query-client.ts`
  - 导出 QueryClient 实例工厂
- `src/web/components/chat-shell.tsx`
  - 页面主布局，组合节点列表、消息区、输入区
- `src/web/components/node-list.tsx`
  - 展示并选择在线节点
- `src/web/components/message-list.tsx`
  - 展示 user / assistant / system 消息
- `src/web/components/chat-composer.tsx`
  - 输入框与发送按钮

## Data Flow

1. 页面加载后，`index.tsx` 使用 Query 拉取 `/api/ui/nodes`
2. 默认选中第一个 `status === "online"` 且存在 agent 的节点
3. 用户提交输入后，前端立即追加 user 消息与一个空 assistant 消息
4. 前端调用 `POST /api/ui/tasks`，若已有 `sessionId` 则传入 `sessionIds: [sessionId]`
5. 创建成功后开启 `EventSource`
6. 收到 `task.lifecycle` 且 payload 类型为 `task.session.attached` 时，更新当前 `sessionId`
7. 收到 `agent.message.delta` 时，把 `payload.payload.content` 追加到 assistant 消息
8. 收到 `done` 或超时/错误时关闭 `EventSource`
9. 若 assistant 最终没有文本，展示“任务已完成，但当前没有可显示的文本输出。”

## Error Handling

- 节点加载失败：在页面状态区与消息区给出错误提示
- 无在线节点或无 agent：禁止发送，并提示先选择可用节点
- task 创建失败：保留 user 消息，将 assistant 气泡写成错误文本
- SSE 中断：关闭连接并结束当前发送态，不自动重试
- SSE 无正文：保留默认完成提示，避免空白 assistant 消息

## Testing

### Server

- 修改 `apps/controlplane/src/__tests__/app.test.ts`
- 从校验内联 HTML 具体脚本内容，改为校验：
  - `/` 返回 `text/html`
  - HTML 中包含 Vite 产物挂载点，如 `<div id="root"></div>`
- 保留健康检查测试

### Frontend

- 本轮不引入额外前端测试框架扩展
- 依赖 TypeScript 类型检查保障前端基础正确性
- 通过现有后端测试与后续手工回归验证聊天链路

### Regression

- `pnpm --filter @tianji/controlplane test -- --reporter=verbose`
- `pnpm check`
- 手工验证：启动 controlplane 与 node，浏览器访问 `/`，创建一轮 task，确认能看到 assistant 输出

## README Impact

需要更新根 `README.md` 中与 controlplane 使用方式相关的说明，至少补充：

- `apps/controlplane` 现在包含浏览器 SPA
- 浏览器访问入口为 `/`
- 若有构建步骤差异，需要反映在开发/运行说明中

## Acceptance Criteria

- `apps/controlplane/src/web/` 存在基于 Vite + React + TanStack Router + TanStack Query 的最小 SPA
- Hono 在保留 `/api/*` 的同时，可以提供 SPA 页面与静态资源
- 浏览器访问 `/` 能看到聊天页
- 聊天页可以选择在线节点并创建 task
- 聊天页能通过 SSE 展示 `agent.message.delta`
- 聊天页能复用 `task.session.attached` 里的 `sessionId`
- `pnpm --filter @tianji/controlplane test -- --reporter=verbose` 通过
- `pnpm check` 通过
