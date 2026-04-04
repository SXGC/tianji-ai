# V3 分布式节点与控制平面 - 实现计划总览

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each plan task-by-task.

**Goal:** 将 tianji 扩展为分布式多节点架构，实现 ACP 生态接入和统一控制平面。

**设计文档:** `docs/superpowers/specs/2026-04-03-v3-distributed-node-controlplane-design.md`

---

## 子系统分解

V3 设计涉及 4 个独立子系统，每个子系统有独立的实现计划：

| # | 计划 | 目标 | 关键产物 |
|---|------|------|----------|
| 01 | [shared 协议扩展](./01-shared-protocol.md) | TaskEvent 类型、任务状态、Command 协议 | `packages/shared/src/task-event.ts`, `task-status.ts`, `command.ts` |
| 02 | [Agent ACP 适配](./02-agent-acp.md) | 原生 agent 实现 AgentSideConnection，编译为独立可执行文件 | `packages/agent/src/acp/`, `scripts/build-agent-binary.ts` |
| 03 | [Node 重构](./03-node-refactor.md) | CLI 重命名为 Node，ACP 客户端适配，Daemon 迁移，控制平面连接，Task 管理 | `apps/node/` |
| 04 | [Control Plane Web 应用](./04-controlplane-app.md) | 新建 Web 应用，Node 注册、心跳、长轮询、事件持久化、SSE、REST API | `apps/controlplane/` |

---

## 依赖关系

```
01-shared-protocol (基础，无依赖)
    │
    ├──► 02-agent-acp (依赖 01 的类型定义)
    │       │
    │       └──► 03-node-refactor (依赖 02 的 agent 可执行文件)
    │
    └──► 04-controlplane-app (依赖 01 的类型定义，与 02/03 无代码依赖)
```

**推荐执行顺序：**

1. **Phase 1:** 01-shared-protocol（所有后续计划的基础）
2. **Phase 2:** 02-agent-acp 和 04-controlplane-app（可并行）
3. **Phase 3:** 03-node-refactor（依赖 02 完成）
4. **Phase 4:** 端到端集成测试（03 + 04 联调）

---

## 技术栈

| 组件 | 技术 |
|------|------|
| 语言 | TypeScript 5.8+ |
| 包管理 | pnpm + Turbo |
| ACP SDK | `@agentclientprotocol/sdk` |
| Web 框架 | Hono（候选，需验证长轮询能力） |
| 数据库 | SQLite + better-sqlite3（WAL 模式） |
| 测试 | Vitest |
| 构建 | esbuild（agent 独立可执行文件） |
| Lint | Biome |

---

## 全局约束

1. **分层依赖规则**：严格遵守 `shared → runtime → agent` 和 `shared → apps/*` 的依赖方向
2. **apps/node 不 import @tianji/agent**：原生 agent 以独立进程运行，通过 ACP stdio 通信
3. **apps/node 不 import @tianji/runtime**：RuntimeEvent 类型从 shared 取
4. **单任务模型**：V3 每个 node 同一时刻只执行一个任务
5. **受信内网**：不实现多租户、Web UI 认证、token 轮换
6. **有限保留**：事件缓存 10 MB / 7 天，不是完整审计日志

---

## 验收标准

### Phase 1 完成时
- [ ] `@tianji/shared` 导出 TaskEvent、TaskStatus、Command 类型
- [ ] 所有现有测试通过（`pnpm check` 无错误）

### Phase 2 完成时
- [ ] 原生 agent 可通过 ACP stdio 与外部进程通信
- [ ] agent 可编译为独立可执行文件
- [ ] controlplane 框架搭建完成，4 项能力验证通过
- [ ] controlplane 数据库 schema 就位

### Phase 3 完成时
- [ ] `apps/cli` 成功重命名为 `apps/node`
- [ ] Node 可 spawn 原生 agent 子进程并通过 ACP 通信
- [ ] Daemon 不再直接 import `@tianji/agent`
- [ ] Node 可向 controlplane 注册、发送心跳、长轮询取指令
- [ ] Node 可通过 NDJSON 流式上报 TaskEvent

### Phase 4 完成时
- [ ] 端到端：用户在 controlplane 创建 task → node 接收 → agent 执行 → 事件流回显
- [ ] 端到端：用户在 controlplane 直接聊天 → node 代理 → 消息往返
- [ ] 本地模式：node 不连控制平面时仍可正常 CLI 使用

---

## 已知延后项

以下功能在设计文档中定义但本轮计划中未覆盖，需后续独立计划：

| 项目 | 原因 | 建议时机 |
|------|------|----------|
| 前端 SPA（Vite + React + TanStack Router + TanStack Query ） | 独立子系统，规模大 | Phase 5 独立计划 |
| 完整聊天内容代理（controlplane → node 反向查询） | 需 node 侧 HTTP 端点支持 | Phase 5 |
| NDJSON 环形缓冲区 + 指数退避重连 | Node 侧可靠性增强 | Phase 5 |
| enrollmentToken 管理 CLI 子命令 | 运维工具 | Phase 5 |
| Node 侧 agent 配置管理（多 agent 注册表、binary 路径发现） | 需配置 schema 扩展 | Phase 5 |
| SOUL.md 自主加载路径验证 | agent 侧实现细节 | 02-agent-acp 补充 |
