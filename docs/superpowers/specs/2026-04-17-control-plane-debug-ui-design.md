# Control Plane Debug UI 设计文档

- **日期**：2026-04-17
- **作者**：brainstorming 会话结论
- **范围**：Control Plane 前端 + 后端（apps/controlplane）
- **目标用户**：开发者、运维人员
- **状态**：设计已确认，待撰写实现计划

## 1. 背景与目标

### 1.1 问题

Tianji-AI 的控制平面在运行时会产生大量领域事件（DomainEventEnvelope），这些事件经过 EventBus 分发、被 TianjiAgent 映射为 AG-UI 事件后推送给前端 CopilotKit 渲染。当前链路中的调试信息仅散落在结构化日志（stdout、JSONL 文件）和 SQLite 的 `event_log` 表中，开发者需要切到日志或数据库才能排查事件流问题，调试效率低。

### 1.2 目标

在 Control Plane 前端页面内集成一个**面向开发者与运维的浮动调试面板**，可观察：

- 事件的产生、传播、关键字段（envelope 元数据和 payload）
- 节点（Daemon Node）的健康状态与运维级别信息

使开发者和运维人员无需离开 Web 界面即可定位事件链路异常、节点在线状态异常等问题。

### 1.3 非目标

- 不面向终端用户，不展示产品级的"任务执行进度"
- 不提供事件回放、事件修改等写操作，Debug 面板是只读的
- 不支持分布式场景的跨控制平面查询，当前仅针对单实例部署

## 2. 设计概览

### 2.1 架构选型

**方案**：前端轮询 + REST 接口（已与方案 B SSE、方案 C WebSocket 对比后确认）。

**理由**：

- 调试工具不要求亚秒级实时性，2 秒轮询足够
- 和项目现有 HTTP 传输架构一致，不引入新基础设施
- 实现量最小，出问题时排查简单
- 符合 KISS 原则

**代价**：实时模式有最多 2 秒延迟，高频轮询对 SQLite 读取有少量压力（评估可接受）。

### 2.2 数据流

```
[EventBus 订阅者] -> [event_log 表 (SQLite)]
                         |
                         | SELECT with filters
                         v
[GET /api/debug/events] -> [DebugPanel (前端)]
                         ^
                         | 每 2 秒轮询（实时模式）
                         | 或按游标翻页（历史模式）

[nodes / agents 表] -> [GET /api/debug/nodes] -> [NodeStatusTab]
```

所有 Debug 相关数据均从数据库读取，不与 EventBus 做直接耦合，Debug 层故障不会影响主链路。

## 3. 后端设计

### 3.1 新增路由组

在 `apps/controlplane/src/app.ts` 中挂载 `/api/debug/*` 路由组。

路由组注册条件：

- 仅当环境变量 `TIANJI_DEBUG=true` 时注册
- 生产环境不传该变量，路由不存在，外部请求返回 404

### 3.2 GET /api/debug/events

**用途**：查询 `event_log` 表中的事件。

**关键设计决策：全局游标使用 `event_log.rowid`**

`event_log` 表的 `sequence` 列是按聚合体（aggregate）递增的，不是全局单调自增（schema 约束 `UNIQUE(aggregate_type, aggregate_id, sequence)`）。因此单个全局 `sequence` 游标会跳过其他聚合体的事件。本设计统一使用 SQLite 的 `rowid`（隐式自增的插入序）作为全局游标字段 `cursor`，该值按事件插入 event_log 的时间顺序严格单调递增，与聚合体无关。

**查询参数**：

| 参数 | 类型 | 说明 |
|------|------|------|
| `mode` | `realtime` \| `history` | 必填。决定排序与过滤语义 |
| `since_cursor` | number | 实时模式。只返回 rowid > 此值的事件。未传时表示 bootstrap（见下文） |
| `start_time` | ISO string | 历史模式。时间范围下界（occurred_at）|
| `end_time` | ISO string | 历史模式。时间范围上界（occurred_at）|
| `before_cursor` | number | 历史模式。游标分页，返回 rowid < 此值的事件 |
| `aggregate_type` | string | 可选。过滤聚合类型（Session / GraphRun / Run / Task / Node）|
| `aggregate_id` | string | 可选。过滤特定聚合体 ID |
| `limit` | number | 默认 200，最大 500 |

**Bootstrap 语义**：

- 实时模式首次进入、面板重新打开、或过滤条件变更时，前端不传 `since_cursor`
- 此时后端返回最近 100 条匹配事件（按 rowid 降序），以及当前库中匹配条件下的最大 `rowid`（`maxCursor` 字段）
- 前端用 `maxCursor` 作为下一次轮询的 `since_cursor`
- 这样保证切换过滤条件后游标从新过滤条件的最新位置开始，不会跳过新条件下的历史事件

**硬编码过滤规则**（接口层恒定执行）：

- 排除 `MessageDelta` 类型
- 排除 `TaskMessageDelta` 类型
- 两者与现有 `event-diagnostics.ts` 的策略保持一致
- 过滤在 SQL 层完成（WHERE 子句），不进入返回体

**排序**：

- 实时模式与历史模式均按 `rowid` 降序返回（新的在前）
- 前端无需反转，直接 prepend（realtime）或 append（history 下一页）

**返回体**：

```
{
  events: DomainEventEnvelope[],
  maxCursor: number,   // 本次返回事件的最大 rowid（即数组第一条）
  minCursor: number,   // 本次返回事件的最小 rowid（即数组最后一条，用于 history 下一页游标）
  hasMore: boolean     // 历史模式下，是否还有更早的事件（即是否命中 limit）
}
```

返回体每条事件在 envelope 外带一个 `cursor` 字段（rowid 的拷贝），便于前端定位和调试。

**错误处理**：

- 参数缺失或非法：400，响应体含简短错误字符串
- 数据库异常：500，响应体含简短错误字符串
- 不做降级兜底，错误直接返回

### 3.3 GET /api/debug/nodes

**用途**：返回节点运维级别的状态信息。

**查询参数**：无（返回全部节点）。

**返回体**：

```
{
  nodes: [
    {
      nodeId: string,
      status: 'online' | 'offline',
      lastHeartbeatAt: ISO string | null,
      registeredAt: ISO string,
      executionState: 'idle' | 'running' | ...,
      agents: [{ agentId, name, ... }]
    },
    ...
  ]
}
```

**数据源**：`nodes` 表 + `agents` 表联表查询。

### 3.4 文件与代码组织

- `apps/controlplane/src/routes/debug-events.ts`
- `apps/controlplane/src/routes/debug-nodes.ts`
- `apps/controlplane/src/routes/__tests__/debug-events.test.ts`
- `apps/controlplane/src/routes/__tests__/debug-nodes.test.ts`

`app.ts` 仅负责条件注册，不承载路由实现。

## 4. 前端设计

### 4.1 组件结构

```
DebugToggleButton        固定右下角的开关按钮
  └─ DebugPanel          浮动窗口容器（可拖拽、调整大小、最小化）
       ├─ DebugToolbar   Tab 切换 / 模式切换 / 过滤器 / 控制按钮
       ├─ EventListTab   事件列表（实时和历史共用同一列表组件）
       ├─ NodeStatusTab  节点健康状态卡片
       └─ EventDetailDrawer  右侧滑出的 envelope 原始 JSON
```

### 4.2 各组件职责

**DebugToggleButton**

- 位置：页面右下角（`position: fixed`，高 z-index）
- 交互：点击切换 `DebugPanel` 的显隐
- 仅当 `VITE_ENABLE_DEBUG=true` 时挂载

**DebugPanel**

- 默认尺寸约 800x500，可拖拽移动、可调整大小
- 面板关闭时清理所有 interval 和订阅，防止内存泄漏
- z-index 高于主界面，但不阻断主界面交互（允许鼠标穿透到面板外区域）

**DebugToolbar**

- Tab 切换：「事件流」「节点状态」
- 模式切换（仅事件流 Tab 下显示）：「实时」「历史」
- 过滤器（仅事件流 Tab 下显示）：`aggregate_type` 下拉 + `aggregate_id` 文本输入
- 历史模式额外显示：时间范围选择器（start_time、end_time）
- 控制按钮：
  - 暂停 / 恢复（仅实时模式下显示）
  - 清空（清空当前列表，不影响数据库）

**EventListTab**

- 表格列：时间戳、事件类型、聚合类型、聚合 ID（截断）、sequence
- 新事件在**顶部**（prepend）
- 内存上限 **3000 条**，超出时从尾部丢弃，并在顶部显示提示
- 点击任一行，右侧滑出 `EventDetailDrawer`
- 历史模式下支持无限滚动分页（详见 4.4）

**NodeStatusTab**

- 卡片列表布局，每个节点一张卡片
- 显示：nodeId、status、lastHeartbeatAt、registeredAt、executionState、关联 agents 列表
- 随 `/api/debug/nodes` 定时刷新（5 秒一次，频率低于事件流）
- **仅当该 Tab 处于激活状态时才启用刷新定时器**；切到事件流 Tab 或关闭面板时立即清理定时器。事件流 Tab 的轮询定时器同理

**EventDetailDrawer**

- 在 DebugPanel 内部右侧滑出
- 展示完整 envelope 的原始 JSON
- 带语法高亮（复用项目已有的 JSON 展示组件或引入轻量库）

### 4.3 状态管理

新建 `apps/controlplane/src/web/stores/debug-store.ts`（Zustand）。

store 持有：

- 面板开关
- 当前 Tab
- 当前模式（realtime / history）
- 过滤条件（aggregate_type、aggregate_id、时间范围）
- 事件列表
- 轮询状态（是否暂停、最新错误）
- 历史模式的分页游标、是否已到底部

主业务 store（`app-store.ts`）不受影响。

### 4.4 轮询与分页策略

**实时模式**：

- 启用条件：面板打开 + 当前 Tab 为事件流 + 模式为 realtime + 未暂停
- Bootstrap（面板首次打开 / 重新打开 / 过滤条件变更 / 熔断后恢复）：不传 `since_cursor`，后端返回最近 100 条 + `maxCursor`；前端清空列表后直接设置为返回事件（已是降序），记录 `since_cursor = maxCursor`
- 增量轮询：每 2 秒调用 `/api/debug/events?mode=realtime&since_cursor=X`；返回的事件（已降序）直接 prepend 到列表头；更新 `since_cursor = max(maxCursor, since_cursor)`
- 过滤器变更：视为 Bootstrap，清空列表 + 不带 `since_cursor` 重新请求
- 失败时顶部显示红色 banner "轮询失败: {reason}"，下一个周期自动重试
- **熔断**：连续 3 次轮询失败后自动切换到暂停态（停止定时器），banner 提示"连续 3 次失败，已暂停"。用户点击"恢复"按钮后重新 Bootstrap

**历史模式**：

- 用户选择时间范围后手动触发查询
- 加载第一页：`/api/debug/events?mode=history&start_time=...&end_time=...&limit=200`
- 事件列表容器监听滚动事件，距底部 < 200px 时触发下一页
- 下一页参数：`before_cursor = 当前列表最末尾事件的 cursor`（即列表中 rowid 最小的那条）
- 某次返回 `hasMore: false` 或空数组时，标记"已到底部"，不再触发后续加载
- 命中 3000 条内存上限时，顶部显示提示"已加载 3000 条，如需继续请缩小时间范围"
- 过滤条件变更（含时间范围、aggregate_type、aggregate_id）：清空列表 + 重新加载第一页

### 4.5 文件与代码组织

新增文件（职责明确拆分，规避 800 行上限风险）：

组件：

- `apps/controlplane/src/web/components/debug/debug-toggle-button.tsx`
- `apps/controlplane/src/web/components/debug/debug-panel.tsx`
- `apps/controlplane/src/web/components/debug/debug-toolbar.tsx`
- `apps/controlplane/src/web/components/debug/event-list-tab.tsx`
- `apps/controlplane/src/web/components/debug/node-status-tab.tsx`
- `apps/controlplane/src/web/components/debug/event-detail-drawer.tsx`

Hook（从组件中抽离的复杂逻辑）：

- `apps/controlplane/src/web/components/debug/hooks/use-debug-window.ts`（拖拽、调整大小、最小化逻辑，从 `debug-panel.tsx` 抽离）
- `apps/controlplane/src/web/components/debug/hooks/use-event-polling.ts`（实时模式轮询、bootstrap、熔断逻辑，从 `event-list-tab.tsx` 抽离）
- `apps/controlplane/src/web/components/debug/hooks/use-history-pagination.ts`（历史模式无限滚动分页逻辑）

Store / Service：

- `apps/controlplane/src/web/stores/debug-store.ts`
- `apps/controlplane/src/web/services/debug-api.ts`（封装 fetch 调用）

挂载点：

- `apps/controlplane/src/web/routes/__root.tsx`（或 `index.tsx`）条件渲染 `DebugToggleButton`

**每个文件必须保持在 CLAUDE.md 规定的 800 行以内**，若实现中超出需按职责进一步拆分。

## 5. 环境隔离

### 5.1 前端

- Vite 环境变量 `VITE_ENABLE_DEBUG`，默认 `false`
- **严格比较规则**：Vite 在构建时将 `import.meta.env.VITE_ENABLE_DEBUG` 替换为字符串字面量（如 `"true"` / `"false"`）而非布尔值。由于字符串 `"false"` 在 JS 中是 truthy，简单的 `if (import.meta.env.VITE_ENABLE_DEBUG)` 会误判。所有条件判断必须使用严格比较：

  ```
  if (import.meta.env.VITE_ENABLE_DEBUG === 'true') { ... }
  ```

- 挂载点按该严格条件渲染 `DebugToggleButton`，tree-shaking 才能正确移除整棵组件子树
- 生产构建脚本中显式设置 `VITE_ENABLE_DEBUG=false`（或不设置，默认即 `"false"`）

### 5.2 后端

- 环境变量 `TIANJI_DEBUG`
- 默认未设置
- `app.ts` 中条件注册：仅当 `process.env.TIANJI_DEBUG === 'true'` 时挂载 `/api/debug/*` 路由组
- 生产环境部署时不传该变量，所有 debug 接口返回 404

### 5.3 环境变量新增审批

`TIANJI_DEBUG` 和 `VITE_ENABLE_DEBUG` 两个新变量已在本设计中向用户明确列出。

## 6. 测试策略

### 6.1 后端单元测试

文件：`apps/controlplane/src/routes/__tests__/debug-events.test.ts`、`debug-nodes.test.ts`

覆盖场景：

- `/api/debug/events` 实时模式
  - Bootstrap（不传 `since_cursor`）返回最近 100 条 + `maxCursor`，按 rowid 降序
  - 传较大 `since_cursor` 返回增量事件
  - 跨聚合体的事件顺序正确（写入 aggregate A 的事件 rowid=1、aggregate B 的事件 rowid=2，since_cursor=0 两条都返回）
- `/api/debug/events` 历史模式
  - 时间范围过滤正确（`occurred_at` 字段）
  - `before_cursor` 游标分页正确
  - 结果按 rowid 降序
  - `hasMore` 字段：返回条数命中 limit 时为 true，否则 false
- 过滤器组合
  - `aggregate_type` 生效
  - `aggregate_id` 生效
  - 组合过滤生效
- 硬编码过滤
  - 注入含 `MessageDelta` 的事件，返回不含该类型
  - 注入含 `TaskMessageDelta` 的事件，返回不含该类型
- 参数边界
  - `limit` 超过 500 被截断
  - 缺失 `mode` 返回 400
  - `mode` 非法值返回 400
- `/api/debug/nodes`
  - 返回字段完整
  - 包含在线/离线状态
  - 关联 agents 正确

### 6.2 后端集成测试

覆盖：

- 真实写入 event_log 后通过接口查询
- 真实 nodes/agents 联表查询

### 6.3 前端组件测试

工具：Vitest + React Testing Library

覆盖场景（**聚焦业务行为，不测纯代码细节**）：

- `DebugToggleButton` 仅在 `VITE_ENABLE_DEBUG === 'true'` 时渲染
- `DebugPanel` 打开 / 关闭 / 拖拽 / 调整大小
- `EventListTab`
  - 渲染事件行
  - 点击触发 `EventDetailDrawer`
  - 内存上限 3000 条，注入 3100 条时尾部被丢弃，显示溢出提示
  - 滚动到底部触发 `before_cursor` 下一页请求，返回 `hasMore: false` 后不再触发
- 模式切换
  - 实时 → 历史 停止实时轮询定时器
  - 历史 → 实时 触发 Bootstrap（不带 `since_cursor`），清空旧列表
- Tab 切换（关键业务行为）
  - 切到节点状态 Tab，事件流轮询定时器必须停止
  - 切回事件流 Tab，触发 Bootstrap
  - 节点状态 Tab 的刷新定时器仅在该 Tab 激活时运行
- **游标正确性（关键业务行为，修复自 review 发现的 bug）**
  - 过滤器变更后不带 `since_cursor` 发起 Bootstrap 请求，列表重置
  - pause → 变更过滤条件 → resume：以新过滤条件的最新 `maxCursor` 作为起点，不重复也不丢失事件
  - 跨聚合体事件顺序正确（mock 返回 aggregate A/B 的混合事件，验证按 rowid 降序渲染）
- 轮询逻辑
  - mock 接口，验证每 2 秒调用一次
  - 单次失败：显示 banner，下一个周期自动重试
  - **熔断**：mock 连续 3 次失败，验证定时器被停止、banner 提示已暂停、用户点击恢复后重新 Bootstrap
  - 暂停后不再轮询，恢复后继续

### 6.4 环境隔离验收

- 生产构建：`vite build` 后在产物中 `grep` 下列关键字，期望全部搜不到（minifier 可能重命名，但这些字符串会保留在 JSX 标签名、组件 displayName、store 调试名或 import 路径中）：
  - `DebugPanel`
  - `DebugToggleButton`
  - `debug-store`
  - `debug-api`
  - `/api/debug/events`
  - `/api/debug/nodes`
- 生产启动（不设 `TIANJI_DEBUG`）：`curl /api/debug/events?mode=realtime` 返回 404

### 6.5 端到端手工验收清单

1. 开发环境页面右下角出现 Debug 按钮
2. 点击按钮弹出浮动面板，可拖拽、可调整大小
3. 事件流 Tab 实时显示新事件，无 MessageDelta
4. 点击任一事件，右侧抽屉显示完整 envelope JSON
5. 切到历史模式，选择时间范围查询，滚动到底部自动加载下一页
6. 过滤器生效
7. 节点状态 Tab 显示心跳、注册信息、关联 agents
8. 生产构建无 Debug 代码，`/api/debug/*` 返回 404

## 7. 风险与权衡

| 风险 | 影响 | 缓解 |
|------|------|------|
| 2 秒轮询下 SQLite 读压力 | 低 | `event_log` 表已有 rowid 隐式索引 + `(aggregate_type, aggregate_id, sequence)` 索引 + `occurred_at` 索引；三类查询都走索引 |
| 前端 3000 条上限仍可能导致内存压力 | 中 | 上限触发时显示提示，用户可手动清空；列表使用虚拟滚动优化渲染性能 |
| 环境变量误配置导致生产环境出现 Debug 面板 | 高 | CI 构建脚本显式设置 `VITE_ENABLE_DEBUG=false`；生产 Docker 镜像不传 `TIANJI_DEBUG`；§6.4 构建产物 grep 校验 |
| 历史模式查询量大导致响应慢 | 低 | 单页 limit 默认 200、最大 500；UI 上提示"如需更多请缩小时间范围" |
| 未来 `event_log` 做 rotation/trim 导致历史 `before_cursor` 翻页中断 | 低 | 当前无 rotation 策略；若未来引入，rowid 不回收（SQLite 默认），只会出现游标返回空页正确终止翻页，不会错位 |
| `/api/debug/nodes` 无分页 | 低 | 单实例部署假设下节点数量有限（通常 < 100）；若未来突破该假设需引入分页 |
| 时钟偏差：前端输入的时间范围与服务端 `occurred_at` 偏移 | 低 | 本地开发场景两端常在同一主机；跨机器时由运维自行校准 NTP；不做特殊处理 |
| 未来多实例部署时，Debug 接口仅反映单实例本地数据库 | 低 | §1.3 已声明单实例范围；若未来多实例，需要改造为聚合查询或每实例独立 debug 入口 |

## 8. 开放问题

无。所有设计决策已在 brainstorming 过程中确认。

## 9. 与现有代码的影响面

- 新增文件为主，不修改现有主链路代码
- `app.ts` 增加条件路由注册（低侵入）
- `__root.tsx` 或 `index.tsx` 增加条件渲染 `DebugToggleButton`（低侵入）
- `packages/runtime`、`packages/shared`、`packages/observer` 不改动
- `packages/daemon`、`packages/node` 不改动
