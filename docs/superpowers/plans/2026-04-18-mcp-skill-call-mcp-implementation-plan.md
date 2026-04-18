# MCP Skill + call_mcp 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不引入动态 tool hot-swap 的前提下，为编排图落地 MCP 渐进式披露能力：MCP server 摘要走 `Skill`，真实执行走单一 `call_mcp` 工具，并且每个节点只能看到图运行能力上限中显式授予给它的 `skills`、`tools` 和 `mcpTargets` 子集。

**Architecture:** 本次只落 V1。图运行入口先解析一份 graph-run 级能力上限；`@tianji/agent` 用它生成 session-scoped MCP skills、构造共享 `ToolRegistry` 和 capability resolver；deepagents 节点执行时不再继承整包共享能力，而是按节点声明裁剪 `skills` 和 `tools`，并把 `mcpTargets` 注入 `call_mcp` 的节点上下文。`call_mcp` 只支持 `discover` 和白名单只读 `invoke`，不做字符串语法解析、不做模糊匹配、不做自动修正。

**Tech Stack:** TypeScript, Vitest, pnpm workspace, `@tianji/agent`, `@tianji/runtime`, `packages/shared`, deepagents

---

## 文件结构与职责

### `packages/shared`

- Modify: `packages/shared/src/orchestration-graph.ts`
  给 `AgentNode.agent` 增加 `mcpTargets?: readonly string[]`，并把能力声明语义固定为显式 allowlist。
- Modify: `packages/shared/src/index.ts`
  导出新增的能力声明与 `call_mcp` 相关类型。
- Create: `packages/shared/src/mcp.ts`
  定义 `McpServerSummary`、`CallMcpInput`、`CallMcpDiscoverResult`、`CallMcpInvokeResult`、图运行能力上限类型、节点能力解析结果类型。
- Test: `packages/shared/src/__tests__/mcp.test.ts`
  校验共享类型导出与最小契约快照。

### `packages/agent`

- Create: `packages/agent/src/mcp/registry.ts`
  定义 graph-run 可用 MCP server、只读白名单 target、skill 元信息的解析入口。
- Create: `packages/agent/src/mcp/skill-generator.ts`
  根据 graph-run 能力上限生成 session-scoped `SKILL.md` 目录，并返回逻辑 skill id 到真实路径的映射。
- Create: `packages/agent/src/mcp/call-mcp-tool.ts`
  实现单一 `call_mcp` 工具，支持 `discover` 和白名单只读 `invoke`。
- Create: `packages/agent/src/orchestration/capability-resolver.ts`
  负责图运行能力上限的构造、节点级 `skills/tools/mcpTargets` 子集校验和解析。
- Modify: `packages/agent/src/orchestration/executors/deepagents-executor.ts`
  不再把共享 `toolCatalog` 整包塞给节点 runtime；改成按节点声明裁剪。
- Modify: `packages/agent/src/orchestration/executors/executor-types.ts`
  给节点执行上下文增加能力解析结果或能力解析器依赖。
- Modify: `packages/agent/src/default-graph-builder.ts`
  在默认 graph 装配处预留 graph-run 能力上限输入。
- Modify: `packages/agent/src/index.ts`
  导出新的 MCP 与 capability resolver 公共类型/能力。
- Test: `packages/agent/src/mcp/__tests__/skill-generator.test.ts`
  校验 session-scoped skill 目录生成与逻辑 id 映射。
- Test: `packages/agent/src/mcp/__tests__/call-mcp-tool.test.ts`
  校验 `discover`、白名单只读 `invoke`、target 越权、字符串语法拒绝。
- Test: `packages/agent/src/orchestration/__tests__/deepagents-executor.test.ts`
  校验节点 runtime 只收到裁剪后的 `skills` 和 `toolCatalog`。
- Test: `packages/agent/src/orchestration/__tests__/graph-compiler.test.ts`
  校验节点声明超出 graph-run 能力上限时，编译直接失败。

### 文档

- Modify: `packages/agent/README.md`
  如果已有 runtime / graph / tool 说明，补充 `call_mcp` 和节点能力裁剪模型。
- Reference: `docs/superpowers/specs/2026-04-18-mcp-skill-call-mcp-design.md`
  实现时必须严格对齐该设计文档。

### 总体验证

- Run: `cd /workspaces/dev_docker/tianji-ai/packages/shared && pnpm test`
- Run: `cd /workspaces/dev_docker/tianji-ai/packages/agent && pnpm test`
- Run: `pnpm check`

---

## Task 1: 扩展共享契约，固定节点能力声明语义

**Files:**
- Modify: `packages/shared/src/orchestration-graph.ts`
- Create: `packages/shared/src/mcp.ts`
- Modify: `packages/shared/src/index.ts`
- Test: `packages/shared/src/__tests__/mcp.test.ts`

- [ ] **Step 1: 先读当前 graph 契约和 shared 导出边界**

Read:
- `packages/shared/src/orchestration-graph.ts`
- `packages/shared/src/index.ts`

Expected: 明确当前 `AgentNode.agent` 已有 `skills` / `tools`，但还没有 `mcpTargets`，也没有 graph-run 能力上限和 `call_mcp` 契约类型。

- [ ] **Step 2: 写失败测试**

在 `packages/shared/src/__tests__/mcp.test.ts` 中新增最小类型/导出断言：

1. `AgentNode.agent` 拥有 `mcpTargets`
2. `CallMcpInput` 可表达 `discover` / `invoke`
3. graph-run 能力上限类型存在

- [ ] **Step 3: 运行 shared 测试确认当前失败**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/shared && pnpm test -- mcp.test.ts`

Expected: FAIL，报新增类型或导出不存在。

- [ ] **Step 4: 修改 graph schema**

在 `packages/shared/src/orchestration-graph.ts` 中：

1. 给 `AgentNode.agent` 增加 `readonly mcpTargets?: readonly string[]`
2. 注释中写清楚语义：这是节点级 allowlist，不是 hint，不是默认全开

- [ ] **Step 5: 新增 MCP 共享类型**

在 `packages/shared/src/mcp.ts` 中至少定义：

1. `McpServerSummary`
2. `CallMcpInput`
3. `CallMcpDiscoverResult`
4. `CallMcpInvokeResult`
5. `GraphRunCapabilityUpperBound`
6. `ResolvedNodeCapabilities`

- [ ] **Step 6: 导出 shared 新契约**

在 `packages/shared/src/index.ts` 中显式 re-export 新类型，避免下游跨内部路径 import。

- [ ] **Step 7: 运行 shared 测试确认通过**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/shared && pnpm test -- mcp.test.ts`

Expected: PASS。

---

## Task 2: 构建 graph-run 能力上限与 capability resolver

**Files:**
- Create: `packages/agent/src/orchestration/capability-resolver.ts`
- Test: `packages/agent/src/orchestration/__tests__/capability-resolver.test.ts`

- [ ] **Step 1: 先读当前 executor 装配点**

Read:
- `packages/agent/src/orchestration/executors/deepagents-executor.ts`
- `packages/agent/src/orchestration/executors/executor-types.ts`
- `packages/agent/src/default-graph-builder.ts`

Expected: 明确当前节点 runtime 装配发生在 `buildRuntimeForNode(...)`，这是做能力裁剪的唯一正确位置。

- [ ] **Step 2: 写失败测试**

在 `capability-resolver.test.ts` 中覆盖：

1. 节点声明的 `skills` / `tools` / `mcpTargets` 必须是 graph-run 能力上限的子集
2. 节点声明未知能力时直接抛错
3. 节点默认空能力，不继承全部

- [ ] **Step 3: 运行测试确认失败**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/agent && pnpm test -- capability-resolver.test.ts`

Expected: FAIL，报 resolver 未实现。

- [ ] **Step 4: 实现 capability resolver**

在 `capability-resolver.ts` 中实现两层语义：

1. graph-run 级能力上限构造
2. 节点级能力子集解析

至少包含这些函数：

1. `createGraphRunCapabilityUpperBound(...)`
2. `resolveNodeCapabilities(node, upperBound)`
3. `assertNodeCapabilitiesWithinUpperBound(...)`

- [ ] **Step 5: 运行 agent 单测确认通过**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/agent && pnpm test -- capability-resolver.test.ts`

Expected: PASS。

---

## Task 3: 生成 session-scoped MCP skills，并建立逻辑 id 映射

**Files:**
- Create: `packages/agent/src/mcp/registry.ts`
- Create: `packages/agent/src/mcp/skill-generator.ts`
- Test: `packages/agent/src/mcp/__tests__/skill-generator.test.ts`

- [ ] **Step 1: 先读设计文档的 skill 约束**

Read:
- `docs/superpowers/specs/2026-04-18-mcp-skill-call-mcp-design.md`

Expected: 明确 skill 只能承载目录信息，图里只能写逻辑 id，不能写真实路径。

- [ ] **Step 2: 写失败测试**

在 `skill-generator.test.ts` 中覆盖：

1. 输入 MCP server 摘要后，生成 session 级目录
2. 每个 server 对应一个 `SKILL.md`
3. 返回逻辑 id -> path 的映射
4. 文本里包含 `call_mcp` 的 discover / invoke 使用规则

- [ ] **Step 3: 运行测试确认失败**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/agent && pnpm test -- skill-generator.test.ts`

Expected: FAIL，报 skill generator 未实现。

- [ ] **Step 4: 实现 registry 和 skill generator**

要求：

1. graph-run 能力上限里只纳入本次允许的 MCP server
2. 只生成 session-scoped 目录，不污染源码主结构
3. `SKILL.md` 模板内容固定，不做启发式拼接

- [ ] **Step 5: 运行测试确认通过**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/agent && pnpm test -- skill-generator.test.ts`

Expected: PASS。

---

## Task 4: 实现单一 `call_mcp` 工具

**Files:**
- Create: `packages/agent/src/mcp/call-mcp-tool.ts`
- Test: `packages/agent/src/mcp/__tests__/call-mcp-tool.test.ts`

- [ ] **Step 1: 写失败测试**

覆盖以下场景：

1. `action=discover` 时 `target` 必须是 server
2. `action=invoke` 时 `target` 必须是 `server.tool`
3. `arguments` 必须是结构化对象
4. 拒绝 `key=value`、`foo:bar`、`server.tool(...)` 这种 CLI 风格字符串
5. 节点没有 `call_mcp` 时拒绝
6. 节点 `mcpTargets` 未授权时拒绝
7. 只读白名单 target 可以 invoke
8. 非白名单写操作 target 直接拒绝

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/agent && pnpm test -- call-mcp-tool.test.ts`

Expected: FAIL，报工具不存在。

- [ ] **Step 3: 实现 `call_mcp`**

要求：

1. 输入结构严格使用共享 `CallMcpInput`
2. discover / invoke 的 `target` 语义严格分开
3. 不做字符串语法解析
4. 不做模糊匹配
5. V1 只支持白名单只读 invoke

- [ ] **Step 4: 把节点上下文所需能力注入 `call_mcp`**

`call_mcp` 执行时必须能拿到：

1. 当前节点允许的 `mcpTargets`
2. graph-run 能力上限
3. 只读 target 白名单或 target 级策略表

- [ ] **Step 5: 运行测试确认通过**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/agent && pnpm test -- call-mcp-tool.test.ts`

Expected: PASS。

---

## Task 5: 在 deepagents executor 中真正裁剪节点能力

**Files:**
- Modify: `packages/agent/src/orchestration/executors/executor-types.ts`
- Modify: `packages/agent/src/orchestration/executors/deepagents-executor.ts`
- Test: `packages/agent/src/orchestration/__tests__/deepagents-executor.test.ts`

- [ ] **Step 1: 先补失败测试**

在 `deepagents-executor.test.ts` 中新增断言：

1. 节点 runtime 只收到解析后的 skill 路径子集
2. 节点 runtime 只收到裁剪后的 `ToolCatalog`
3. 节点未声明工具时，不看到共享整包 tools

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/agent && pnpm test -- deepagents-executor.test.ts`

Expected: FAIL，断言当前 runtime 仍收到共享 `toolCatalog`。

- [ ] **Step 3: 扩展 executor context / factory options**

不要继续让 factory 只拿一个共享 `ToolCatalog`。

应改成能拿到：

1. graph-run 能力上限
2. capability resolver
3. 共享 ToolRegistry 或可切片能力，而不是已经冻结的整包 `ToolCatalog`

- [ ] **Step 4: 在 `buildRuntimeForNode(...)` 中完成节点裁剪**

逻辑必须固定为：

1. 解析节点 skill id -> path
2. 按 `node.agent.tools` 切出节点专属 `ToolCatalog`
3. 构造节点级 `mcpTargets` 上下文
4. 把这些节点级能力注入 runtime

- [ ] **Step 5: 运行测试确认通过**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/agent && pnpm test -- deepagents-executor.test.ts`

Expected: PASS。

---

## Task 6: 在 graph 编译阶段增加能力越权校验

**Files:**
- Modify: `packages/agent/src/orchestration/graph-compiler.ts`
- Test: `packages/agent/src/orchestration/__tests__/graph-compiler.test.ts`

- [ ] **Step 1: 写失败测试**

覆盖以下错误场景：

1. 节点声明未知 skill id
2. 节点声明未知 tool
3. 节点声明超出 graph-run 能力上限的 `mcpTargets`

- [ ] **Step 2: 运行测试确认失败**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/agent && pnpm test -- graph-compiler.test.ts`

Expected: FAIL，当前编译阶段不会拦截这些越权声明。

- [ ] **Step 3: 把 capability 校验接入图编译**

原则：

1. 编译前统一校验
2. 发现越权直接失败
3. 不允许自动删除非法能力后继续编译

- [ ] **Step 4: 运行测试确认通过**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/agent && pnpm test -- graph-compiler.test.ts`

Expected: PASS。

---

## Task 7: 总体验证与文档收尾

**Files:**
- Modify: `packages/agent/README.md`（如已有相关能力说明）

- [ ] **Step 1: 运行 shared 全量测试**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/shared && pnpm test`

Expected: PASS。

- [ ] **Step 2: 运行 agent 全量测试**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/agent && pnpm test`

Expected: PASS。

- [ ] **Step 3: 运行全仓检查**

Run: `pnpm check`

Expected: 无 error、warning、info。

- [ ] **Step 4: 更新 README（如确有对外暴露）**

如果 `packages/agent` 对外有 graph / node capability / MCP 使用说明，则补充：

1. 节点能力是显式 allowlist
2. `skills` 是逻辑 id，不是真实路径
3. `call_mcp` 采用 `server` / `server.tool` 目标格式

- [ ] **Step 5: 收尾提交**

提交信息建议拆分为多个小步，不要一次性把所有内容挤成一个 commit。
