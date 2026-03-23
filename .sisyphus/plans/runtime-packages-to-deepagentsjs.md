# runtime packages → deepagentsjs 迁移计划

## TL;DR
> **Summary**: 将 `@tianji/runtime` 从当前自建 LangGraph 会话运行时重构为基于 `deepagentsjs` 的运行时外壳，停止维护自实现 agent runtime，同时尽量保持 `@tianji/contracts` 的消息、事件、快照与工具契约稳定。
> **Deliverables**:
> - `@tianji/runtime` v2 公共 API（deepagents-native 配置，仍保留 `createSessionRuntime` 入口）
> - deepagents 引擎接入与内部适配层：`ToolAdapter`、`EventAdapter`、`SnapshotAdapter`
> - 语义兼容矩阵与 parity 测试套件（事件、回放、取消、恢复、工具、快照）
> - 会话级引擎选择与回滚窗口
> - 最终移除 legacy 自建 runtime 实现
> **Effort**: Large
> **Parallel**: YES - 3 waves
> **Critical Path**: T1 → T3 → T6 → T7 → T9 → T11 → T12

## Context
### Original Request
将 runtime packages 替换为 `https://github.com/langchain-ai/deepagentsjs`，不再自行实现 agent runtime，并输出计划文档。

### Interview Summary
- 兼容策略：**彻底重做 runtime 接口**，不保留现有 runtime API/配置兼容层。
- 契约边界：**重做 runtime package，但尽量保持 `@tianji/contracts` 稳定**。
- 测试策略：**tests-after**；实现切片完成后立即补 parity/回归，不把测试拖到迁移末尾。
- 当前运行时中心：`packages/runtime/src/runtime.ts` 管理生命周期、事件、工具执行、取消/恢复；`packages/runtime/src/workflow.ts` 仅是单节点 LangGraph 工作流。
- 现有验证基线：根目录 `pnpm check`，运行时使用 Vitest，现有 `packages/runtime/src/__tests__/runtime.test.ts` 已覆盖核心 happy path 与流式事件顺序。

### Metis Review (gaps addressed)
- 高风险不在 `workflow.ts` 替换本身，而在 `RuntimeEvent` 顺序、`ReplayableEventStream` 回放、`RunSnapshot` / `SessionSnapshot` 兼容、`resumeHint`、工具上下文与取消传播。
- 计划锁定为**语义守恒迁移**，而不是图引擎替换或 contracts 重设计。
- 迁移期必须保留 legacy runtime，且**同一 session 绑定单一引擎**，禁止中途跨引擎恢复。
- `deepagentsjs` 仅作为内部运行时内核；对外仍以 `@tianji/contracts` 为公共协议层，对 deepagents 专有状态使用 `workflowState`/`metadata` namespacing 承载。

## Work Objectives
### Core Objective
以 `deepagentsjs` 替换 `@tianji/runtime` 的自建 agent runtime 实现，交付一个 deepagents-backed 的 `@tianji/runtime` v2，同时保留当前 contracts 语义边界，确保事件、快照、取消/恢复、工具与回放行为可被自动化验证。

### Deliverables
- `packages/runtime/src/` 下的 deepagents 运行时外壳与适配层
- 更新后的 `SessionRuntimeOptions` / `SessionRuntime` / `createSessionRuntime` v2 导出
- parity 测试文件与 legacy snapshot fixture
- runtime README 与包元数据更新
- legacy runtime 下线后的精简依赖图

### Definition of Done (verifiable conditions with commands)
- [ ] `pnpm --filter @tianji/runtime typecheck`
- [ ] `pnpm --filter @tianji/runtime vitest run src/__tests__/runtime.test.ts src/__tests__/runtime-parity.test.ts src/__tests__/runtime-cancel-resume.test.ts src/__tests__/legacy-snapshot-compat.test.ts`
- [ ] `pnpm check`
- [ ] `pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-parity.test.ts -t "replays runtime events in exact legacy order"`
- [ ] `pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-cancel-resume.test.ts -t "preserves resumeHint and resumedFromRunId semantics"`

### Must Have
- `@tianji/contracts` 中的 `RuntimeEvent`、`RunSnapshot`、`SessionSnapshot`、`ToolSpec`、`ToolInvocation`、`ToolResult` 保持稳定，除非出现无法规避的 deepagents 适配缺口。
- 对外继续保留 `createSessionRuntime` 与 `SessionRuntime` 方法族；只重做 `SessionRuntimeOptions` 配置形态。
- 迁移期必须支持 session-bound 引擎选择；同一 session 的 `runTurn` / `resumeRun` / `streamEvents` / `cancelRun` 只能落到同一引擎。
- `ReplayableEventStream` 继续作为对外事件回放机制，不能把 deepagents 原生 streaming 结构直接暴露到 contracts。
- `ToolCatalog` 继续作为工具权限、超时和上下文注入的唯一策略边界。
- deepagents 内部线程/检查点/后端状态仅写入 `RunSnapshot.workflowState` 或 namespaced `metadata`。

### Must NOT Have (guardrails, AI slop patterns, scope boundaries)
- 不做 repo 级 contracts v2 重设计。
- 不把 deepagents 的 `todos`、`subagents`、`interruptOn` 直接升级成新的公共 contracts 能力。
- 不做破坏性 snapshot 迁移；旧 snapshot 至少要可读取，或者返回显式 typed incompatibility error。
- 不把 `ToolCatalog` 绕开为 deepagents 原生工具直连层。
- 不在本次迁移里顺带重做 `@tianji/shared` 配置 schema 或全仓 `zod` 升级，除非安装/类型冲突证明不可避免。
- 不允许 mid-session engine swap。

## Verification Strategy
> ZERO HUMAN INTERVENTION — all verification is agent-executed.
- Test decision: **tests-after** + **Vitest**
- QA policy: 每个任务都必须包含 happy path 与 failure/edge path 两个 agent-executed 场景。
- Evidence: `.sisyphus/evidence/task-{N}-{slug}.txt`
- Gate rule: parity 测试必须在 legacy 模式与 deepagents 模式都可执行；默认切换前，deepagents 模式必须先完全通过。

## Execution Strategy
### Parallel Execution Waves
Wave 1: T1-T5（兼容矩阵、依赖矩阵、v2 API、元数据契约、验证脚手架）
Wave 2: T6-T10（runtime facade、deepagents bootstrap、tool/event/snapshot adapter）
Wave 3: T11-T12（默认切换、legacy 删除、最终清理）

### Dependency Matrix (full, all tasks)
- T1: —
- T2: —
- T3: —
- T4: —
- T5: —
- T6: T1, T3, T4
- T7: T2, T3, T4
- T8: T1, T2, T3, T6, T7
- T9: T1, T3, T5, T6, T7
- T10: T1, T4, T5, T6, T7, T8, T9
- T11: T1, T3, T5, T8, T9, T10
- T12: T11

### Agent Dispatch Summary (wave → task count → categories)
- Wave 1 → 5 tasks → `deep` ×2, `quick` ×2, `unspecified-high` ×1
- Wave 2 → 5 tasks → `deep` ×3, `unspecified-high` ×2
- Wave 3 → 2 tasks → `deep` ×1, `quick` ×1

## TODOs
> Implementation + Test = ONE task. Never separate.
> EVERY task MUST have: Agent Profile + Parallelization + QA Scenarios.

- [x] 1. 锁定 legacy 语义兼容矩阵与 parity 测试基线

  **What to do**: 扩展 `packages/runtime/src/__tests__/runtime.test.ts` 为显式 parity 基线；新增 `runtime-parity.test.ts`、`runtime-cancel-resume.test.ts`，覆盖事件顺序、late replay、tool success/failure、cancel、resume、`resumeHint`、`resumedFromRunId`、tool context 注入。把“当前行为”写成可在 legacy/deepagents 两种引擎上复用的断言辅助，不允许以实现细节替代 contracts 断言。
  **Must NOT do**: 不改业务行为；不在本任务引入 deepagents；不修改 `@tianji/contracts`。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 需要把运行时语义转成可重复执行的兼容门槛
  - Skills: [] — 现有 Vitest 约定已足够
  - Omitted: [`playwright`] — 无浏览器场景

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T6, T8, T9, T10, T11 | Blocked By: None

  **References**:
  - Pattern: `packages/runtime/src/__tests__/runtime.test.ts:126-290` — 现有 happy path、delta 顺序与 snapshot 断言基线
  - Pattern: `packages/runtime/src/runtime.ts:350-447` — run started/completed/cancelled/failed 事件与 snapshot 更新顺序
  - Pattern: `packages/runtime/src/runtime.ts:455-674` — message.delta、tool.started/completed/failed、timeout/cancel 逻辑
  - Pattern: `packages/runtime/src/event-stream.ts:1-60` — `ReplayableEventStream` late subscriber 回放语义
  - API/Type: `packages/contracts/src/events.ts:28-272` — `RuntimeEvent` 全量契约
  - API/Type: `packages/contracts/src/snapshot.ts:15-76` — `RunSnapshot` / `resumeHint` / `workflowState`

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @tianji/runtime vitest run src/__tests__/runtime.test.ts src/__tests__/runtime-parity.test.ts`
  - [ ] `pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-cancel-resume.test.ts`
  - [ ] parity 测试断言的是事件类型/字段/顺序与 snapshot 字段，不是内部函数调用次数

  **QA Scenarios** (MANDATORY — task incomplete without these):
  ```
  Scenario: legacy happy path parity locked
    Tool: Bash
    Steps:
      1. pnpm --filter @tianji/runtime vitest run src/__tests__/runtime.test.ts src/__tests__/runtime-parity.test.ts
    Expected: Exit code 0; 包含对 run/message/tool 事件顺序与 replay 行为的通过断言
    Evidence: .sisyphus/evidence/task-01-runtime-parity.txt

  Scenario: cancel/resume edge semantics locked
    Tool: Bash
    Steps:
      1. pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-cancel-resume.test.ts -t "preserves resumeHint and resumedFromRunId semantics"
    Expected: Exit code 0; 测试证明 cancelled run 只能 resume，且 resume 产出新 runId 与正确 metadata
    Evidence: .sisyphus/evidence/task-01-runtime-cancel-resume.txt
  ```

  **Commit**: YES | Message: `test(runtime): lock legacy parity matrix before deepagents cutover` | Files: `packages/runtime/src/__tests__/*`

- [ ] 2. 固化 deepagents 依赖矩阵与安装边界

  **What to do**: 在 `packages/runtime/package.json` 引入 `deepagents` 及其要求的 `langchain` / `@langchain/core` / `@langchain/langgraph` 版本矩阵，保持 legacy 依赖暂时并存；仅在确有解析冲突时才添加根级 overrides。明确本迁移默认**不**触发 `@tianji/shared` 的 `zod` 升级，除非安装或类型检查有硬证据表明无法共存。
  **Must NOT do**: 不把 `@tianji/shared` 一起升级到 zod v4；不在本任务删除 legacy 依赖；不改 runtime 源码行为。

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: 以包依赖矩阵与边界收敛为主
  - Skills: []
  - Omitted: [`git-master`] — 非 git 历史类任务

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T7, T8 | Blocked By: None

  **References**:
  - Pattern: `packages/runtime/package.json:15-33` — 当前 runtime scripts 与依赖入口
  - Pattern: `package.json:6-23` — 根级 `pnpm check` / `typecheck` 约定
  - Pattern: `packages/shared/package.json:21-23` — 当前 `zod@^3.24.0` 风险锚点
  - External: `https://docs.langchain.com/oss/javascript/deepagents/overview` — 官方安装与整体能力说明
  - External: `https://github.com/langchain-ai/deepagentsjs/blob/main/libs/deepagents/src/types.ts` — 官方类型入口

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @tianji/runtime typecheck`
  - [ ] `pnpm check`
  - [ ] runtime package 的 deepagents 依赖版本在 `package.json` 中显式可审计，且未顺带引入 repo 级 schema 升级

  **QA Scenarios**:
  ```
  Scenario: dependency matrix compiles cleanly
    Tool: Bash
    Steps:
      1. pnpm --filter @tianji/runtime typecheck
    Expected: Exit code 0; deepagents 类型可解析且不破坏 runtime 包编译
    Evidence: .sisyphus/evidence/task-02-runtime-typecheck.txt

  Scenario: root validation remains green after dependency changes
    Tool: Bash
    Steps:
      1. pnpm check
    Expected: Exit code 0; 根级 Biome + typecheck 在新依赖图下仍通过
    Evidence: .sisyphus/evidence/task-02-root-check.txt
  ```

  **Commit**: YES | Message: `chore(runtime): add deepagents dependency matrix and migration scaffolding` | Files: `packages/runtime/package.json`, `package.json` (only if overrides strictly required)

- [x] 3. 定义 `@tianji/runtime` v2 公共 API

  **What to do**: 保留 `createSessionRuntime` 与 `SessionRuntime` 方法族，但重做 `SessionRuntimeOptions`。明确 v2 以 deepagents-native 配置为主：`engine?: 'legacy' | 'deepagents'`；`snapshotStore` / `toolCatalog` 继续保留；新增 `deepagents` 配置块（`model`、`middleware`、`backend`、`checkpointer`、`store`、`subagents`、`skills`、`interruptOn`）；legacy 仅保留临时迁移块供回滚窗口使用。README 与导出类型同步为 v2 语义。
  **Must NOT do**: 不改 `SessionRuntime` 方法签名；不把 deepagents 私有类型直接暴露进 `@tianji/contracts`；不把 `ToolCatalog` 从公共 API 中移除。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 需要在 breaking API 与 contracts 稳定间做边界收敛
  - Skills: []
  - Omitted: [`frontend-ui-ux`] — 无 UI

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T6, T7, T8, T9, T11 | Blocked By: None

  **References**:
  - Pattern: `packages/runtime/src/runtime.ts:39-120` — 当前 options 与 `SessionRuntime` 方法族
  - Pattern: `packages/runtime/src/index.ts:1-18` — 当前 runtime 公共导出面
  - Pattern: `packages/runtime/README.md`（tool result 中附带）— 当前 runtime README 使用方式
  - API/Type: `packages/contracts/src/tool.ts:77-156` — 工具公共契约必须保留
  - External: `https://github.com/langchain-ai/deepagentsjs/blob/main/libs/deepagents/src/agent.ts` — `createDeepAgent` 入口
  - External: `https://docs.langchain.com/oss/javascript/deepagents/customization` — middleware / subagents / backend 配置面

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @tianji/runtime typecheck`
  - [ ] `pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-public-api.test.ts`
  - [ ] README 与导出类型都指向 v2 options，而非旧 `llmGateway` 单一路径

  **QA Scenarios**:
  ```
  Scenario: v2 public API compiles
    Tool: Bash
    Steps:
      1. pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-public-api.test.ts
    Expected: Exit code 0; `createSessionRuntime` 在 deepagents 配置块下可正确构造，且 `SessionRuntime` 方法类型未变化
    Evidence: .sisyphus/evidence/task-03-runtime-public-api.txt

  Scenario: legacy-only constructor no longer documented as default
    Tool: Bash
    Steps:
      1. pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-public-api.test.ts -t "marks legacy engine as migration-only"
    Expected: Exit code 0; 测试/断言证明 public API 将 `legacy` 标记为迁移期能力而不是默认入口
    Evidence: .sisyphus/evidence/task-03-legacy-migration-only.txt
  ```

  **Commit**: YES | Message: `refactor(runtime): define v2 public api around deepagents` | Files: `packages/runtime/src/runtime.ts`, `packages/runtime/src/index.ts`, `packages/runtime/README.md`, `packages/runtime/src/__tests__/runtime-public-api.test.ts`

- [x] 4. 固化 snapshot metadata 与 session-bound engine 契约

  **What to do**: 在 runtime 内部定义并测试 metadata/workflowState 约定：`SessionSnapshot.metadata.runtime.engine` 记录 session 绑定引擎；`RunSnapshot.metadata.runtime.engine`、`RunSnapshot.metadata.runtime.threadId`、`RunSnapshot.metadata.runtime.checkpointId` 记录 deepagents 恢复锚点；保留现有 `metadata.systemPrompt`、`metadata.generationConfig`、`metadata.resumedFromRunId` 语义；`workflowState` 仅存放 deepagents 专有状态快照，不污染 contracts 顶层字段。
  **Must NOT do**: 不重写旧 snapshot；不把 deepagents checkpoint 直接映射成新的 contracts 字段；不允许缺失 engine 元数据的 session 在 deepagents/legacy 间随意切换。

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: 需要兼顾持久化兼容与 rollout/rollback 约束
  - Skills: []
  - Omitted: [`postgresql-table-design`] — 非数据库 schema 任务

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T6, T7, T10 | Blocked By: None

  **References**:
  - Pattern: `packages/runtime/src/runtime.ts:241-266` — `resumeRun` 当前读取 previous run / `resumedFromRunId` 逻辑
  - Pattern: `packages/runtime/src/runtime.ts:298-311` — 当前 run metadata 保存 `systemPrompt` / `generationConfig` / `resumedFromRunId`
  - Pattern: `packages/contracts/src/snapshot.ts:51-76` — `RunSnapshot` 可用扩展位：`resumeHint` / `workflowState` / `metadata`
  - Pattern: `packages/runtime/src/snapshot-store.ts:8-125` — snapshot 存储边界

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @tianji/runtime vitest run src/__tests__/legacy-snapshot-compat.test.ts`
  - [ ] `pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-engine-selection.test.ts`
  - [ ] 旧 snapshot 读取要么成功，要么抛出显式 typed incompatibility error，不能 silent fallback

  **QA Scenarios**:
  ```
  Scenario: legacy snapshots remain readable
    Tool: Bash
    Steps:
      1. pnpm --filter @tianji/runtime vitest run src/__tests__/legacy-snapshot-compat.test.ts
    Expected: Exit code 0; fixture 中的 legacy session/run snapshot 可被新 runtime 读取并保留 contracts 语义
    Evidence: .sisyphus/evidence/task-04-legacy-snapshot-compat.txt

  Scenario: session-bound engine is enforced
    Tool: Bash
    Steps:
      1. pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-engine-selection.test.ts -t "rejects mid-session engine switching"
    Expected: Exit code 0; 同一 session 尝试跨引擎 resume 或 runTurn 会被明确拒绝
    Evidence: .sisyphus/evidence/task-04-session-engine-binding.txt
  ```

  **Commit**: YES | Message: `test(runtime): codify snapshot metadata and engine binding contract` | Files: `packages/runtime/src/__tests__/legacy-snapshot-compat.test.ts`, `packages/runtime/src/__tests__/runtime-engine-selection.test.ts`, runtime metadata helpers

- [ ] 5. 建立 dual-engine 验证脚手架与 legacy fixture 目录

  **What to do**: 为 runtime 测试提供统一 harness：`createRuntimeHarness({ engine })`、legacy snapshot fixture、event sequence fixture、tool failure fixture。所有 parity 测试必须能在 `legacy` 与 `deepagents` 模式下复用同一套断言。README/测试注释明确 deepagents 为目标引擎，legacy 仅为迁移窗口保留。
  **Must NOT do**: 不在此任务切换默认引擎；不复制两套断言逻辑；不让 fixture 依赖 deepagents 私有序列化格式。

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: 以测试基础设施与 fixture 组织为主
  - Skills: []
  - Omitted: [`playwright`] — 无 UI

  **Parallelization**: Can Parallel: YES | Wave 1 | Blocks: T9, T10, T11 | Blocked By: None

  **References**:
  - Pattern: `packages/runtime/src/__tests__/runtime.test.ts:16-124` — 现有 mock gateway、collect helpers、delta 聚合辅助
  - Pattern: `vitest.config.ts:7-37` — 仓库级 Vitest 约定
  - Pattern: `packages/runtime/src/event-stream.ts:27-60` — replay 断言所需 iterator 行为

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-parity.test.ts`
  - [ ] `pnpm --filter @tianji/runtime vitest run src/__tests__/legacy-snapshot-compat.test.ts`
  - [ ] parity helpers 不依赖 legacy-only API 或 llm mock 特性

  **QA Scenarios**:
  ```
  Scenario: dual-engine harness runs the same parity suite
    Tool: Bash
    Steps:
      1. pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-parity.test.ts -t "runs against both legacy and deepagents harnesses"
    Expected: Exit code 0; 同一断言集合可在双引擎模式下执行
    Evidence: .sisyphus/evidence/task-05-dual-engine-harness.txt

  Scenario: failure fixture remains engine-agnostic
    Tool: Bash
    Steps:
      1. pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-parity.test.ts -t "emits stable tool failure events across engines"
    Expected: Exit code 0; tool failure fixture 不依赖任一引擎的私有 payload 结构
    Evidence: .sisyphus/evidence/task-05-tool-failure-fixture.txt
  ```

  **Commit**: YES | Message: `test(runtime): add dual-engine parity harness and legacy fixtures` | Files: `packages/runtime/src/__tests__/fixtures/*`, `packages/runtime/src/__tests__/helpers/*`, parity tests

- [ ] 6. 提取 runtime facade 与 session-bound engine selector

  **What to do**: 把当前 `SessionRuntimeImpl` 拆为 engine-neutral facade + internal selector。facade 继续暴露 `createSessionRuntime` / `runTurn` / `resumeRun` / `streamEvents` / `cancelRun`；selector 按 session 记录的 engine 元数据将请求路由到 `legacy` 或 `deepagents` 引擎。stream/replay 继续由 facade 层维护，禁止把 deepagents 原生 stream 直接暴露出去。
  **Must NOT do**: 不在此任务实现 deepagents 细节；不删除 legacy 引擎；不改变 `SessionRuntime` 方法返回值与异常语义。

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: 需要重构 runtime 主骨架而不改变对外行为
  - Skills: []
  - Omitted: [`refactor`] — 当前计划已给出明确 seam，不需要命令式大重构工具

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: T8, T9, T10 | Blocked By: T1, T3, T4

  **References**:
  - Pattern: `packages/runtime/src/runtime.ts:153-168` — 当前 `SessionRuntimeImpl` 构造边界
  - Pattern: `packages/runtime/src/runtime.ts:212-294` — `runTurn` / `resumeRun` / `streamEvents` / `cancelRun` 当前 facade 行为
  - Pattern: `packages/runtime/src/index.ts:11-18` — 对外入口必须保持

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-engine-selection.test.ts`
  - [ ] `pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-public-api.test.ts`
  - [ ] legacy 引擎在 selector 引入后仍通过原始 parity 套件

  **QA Scenarios**:
  ```
  Scenario: facade preserves current runtime method semantics
    Tool: Bash
    Steps:
      1. pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-public-api.test.ts src/__tests__/runtime-engine-selection.test.ts
    Expected: Exit code 0; facade 路由后 `runTurn`/`resumeRun`/`streamEvents`/`cancelRun` 的 contracts 行为未改变
    Evidence: .sisyphus/evidence/task-06-runtime-facade.txt

  Scenario: legacy path still passes through selector
    Tool: Bash
    Steps:
      1. pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-parity.test.ts -t "preserves legacy parity through selector"
    Expected: Exit code 0; selector 不破坏 legacy 模式事件与 snapshot 行为
    Evidence: .sisyphus/evidence/task-06-legacy-through-selector.txt
  ```

  **Commit**: YES | Message: `refactor(runtime): introduce v2 facade and session-bound engine selector` | Files: `packages/runtime/src/runtime.ts`, new internal engine modules, selector tests

- [ ] 7. 接入 deepagents 引擎骨架并绑定 runtime v2 配置

  **What to do**: 新增 `deepagents` 引擎实现，使用 `createDeepAgent` 构建内部 agent；把 v2 `deepagents` 配置块映射到 `model`、`middleware`、`backend`、`checkpointer`、`store`、`subagents`、`skills`、`interruptOn`。sessionId 与 deepagents thread/checkpoint 必须建立一一对应映射，并通过 T4 约定写回 metadata/workflowState。当前仓库没有 apps，故本任务只覆盖 runtime package 内部接线，不新增 app 入口。
  **Must NOT do**: 不暴露 deepagents 原生 agent 实例给上层；不在本任务翻默认引擎；不删除 legacy 路径。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: deepagents bootstrap + identity/persistence 映射属于迁移主难点
  - Skills: []
  - Omitted: [`agent-browser`] — 无浏览器交互

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: T8, T9, T10 | Blocked By: T2, T3, T4

  **References**:
  - Pattern: `packages/runtime/src/workflow.ts:18-31` — 当前 LangGraph 单节点工作流，可整体下沉为 deepagents 引擎入口
  - Pattern: `packages/runtime/src/runtime.ts:330-370` — 当前 run 执行骨架与 invoke 时机
  - Pattern: `packages/contracts/src/snapshot.ts:64-75` — deepagents thread/checkpoint 必须停留在 metadata/workflowState
  - External: `https://github.com/langchain-ai/deepagentsjs/blob/main/libs/deepagents/src/agent.ts` — `createDeepAgent` 主入口
  - External: `https://docs.langchain.com/oss/javascript/deepagents/backends` — backend / checkpointer / store 官方说明

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @tianji/runtime typecheck`
  - [ ] `pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-deepagents-bootstrap.test.ts`
  - [ ] deepagents engine 能在测试中构造、运行单轮请求并产生可路由的内部结果

  **QA Scenarios**:
  ```
  Scenario: deepagents engine boots from v2 options
    Tool: Bash
    Steps:
      1. pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-deepagents-bootstrap.test.ts
    Expected: Exit code 0; deepagents 引擎可从 `SessionRuntimeOptions.deepagents` 完成初始化并记录 thread/checkpoint 元数据
    Evidence: .sisyphus/evidence/task-07-deepagents-bootstrap.txt

  Scenario: deepagents bootstrap rejects incomplete configuration
    Tool: Bash
    Steps:
      1. pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-deepagents-bootstrap.test.ts -t "fails fast when model is missing"
    Expected: Exit code 0; 缺失必需 deepagents 配置时抛出明确 runtime construction error
    Evidence: .sisyphus/evidence/task-07-deepagents-bootstrap-error.txt
  ```

  **Commit**: YES | Message: `feat(runtime): bootstrap deepagents engine behind adapters` | Files: deepagents engine modules, bootstrap tests, runtime option wiring

- [ ] 8. 实现 ToolAdapter，保持 `ToolCatalog` 为唯一策略边界

  **What to do**: 将 `ToolCatalog` / `RuntimeToolDefinition` / `ToolSpec` 转换为 deepagents 可用工具，但**执行仍必须回到 `ToolCatalog.executeTool`**。保留 `ensureToolAllowed`、`ExecutionPolicy.tool.timeoutMs`、`RuntimeToolExecutionContext(sessionId/runId/toolCallId/abortSignal)`、tool side effect 语义。对于 deepagents 需要的 richer schema，只能内部转换，不能反向污染 contracts。
  **Must NOT do**: 不允许上层绕过 `ToolCatalog` 直接把 deepagents 工具塞进 runtime；不改变 `ToolSpec` / `ToolInvocation` / `ToolResult` 结构。

  **Recommended Agent Profile**:
  - Category: `unspecified-high` — Reason: 涉及 schema 转换、权限控制、超时与上下文保真
  - Skills: []
  - Omitted: [`postgresql-table-design`] — 无关

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: T10, T11 | Blocked By: T1, T2, T3, T6, T7

  **References**:
  - Pattern: `packages/runtime/src/tool-catalog.ts:10-137` — sideEffect、registry、permission 边界
  - Pattern: `packages/runtime/src/runtime.ts:547-673` — 当前 `buildLlmRequest` / `executeToolCall` 逻辑
  - API/Type: `packages/contracts/src/tool.ts:77-156` — 工具 spec/invocation/result 必须稳定
  - API/Type: `packages/contracts/src/policy.ts:55-87` — timeout / allowDestructive 约束
  - External: `https://docs.langchain.com/oss/javascript/deepagents/customization` — deepagents tool / middleware 扩展点

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-tool-adapter.test.ts`
  - [ ] `pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-parity.test.ts -t "injects sessionId runId and toolCallId into tool execution"`
  - [ ] tool permission denial、timeout、destructive block 都映射为稳定 contracts 错误

  **QA Scenarios**:
  ```
  Scenario: tool adapter preserves happy path context
    Tool: Bash
    Steps:
      1. pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-tool-adapter.test.ts -t "passes sessionId runId and toolCallId through ToolCatalog"
    Expected: Exit code 0; ToolAdapter 经由 `ToolCatalog.executeTool` 执行且上下文字段完整
    Evidence: .sisyphus/evidence/task-08-tool-adapter-context.txt

  Scenario: tool adapter preserves failure semantics
    Tool: Bash
    Steps:
      1. pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-tool-adapter.test.ts -t "blocks destructive tools and preserves timeout errors"
    Expected: Exit code 0; destructive blocked 与 timeout 都产生 contracts 期望的错误与事件
    Evidence: .sisyphus/evidence/task-08-tool-adapter-failure.txt
  ```

  **Commit**: YES | Message: `feat(runtime): map tools through stable ToolCatalog adapter` | Files: tool adapter modules, runtime tool adapter tests

- [ ] 9. 实现 EventAdapter 与 replay bridge

  **What to do**: 将 deepagents 的 message/tool lifecycle 与流式输出映射到现有 `RuntimeEvent` 联合，并继续通过 `ReplayableEventStream` 对外暴露。严格保持 legacy 事件顺序：`run.started` → `message.started` → `message.delta*` → `tool.*` → `message.completed` → `run.completed|run.failed|run.cancelled`。late subscriber 必须拿到完整缓冲事件序列。
  **Must NOT do**: 不使用 deepagents 原生 event payload 直接透传；不改变 `message.delta.sequence`、`channel`、`payload.content` 的 contracts 语义。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 事件映射与 replay 行为是最核心的语义风险点
  - Skills: []
  - Omitted: [`playwright`] — 无 UI

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: T10, T11 | Blocked By: T1, T3, T5, T6, T7

  **References**:
  - Pattern: `packages/runtime/src/runtime.ts:350-545` — 当前 run/message 事件发射顺序
  - Pattern: `packages/runtime/src/event-stream.ts:1-60` — 外部 replay 契约必须保持
  - API/Type: `packages/contracts/src/events.ts:47-272` — event 字段与 union 契约
  - External: `https://docs.langchain.com/oss/javascript/deepagents/overview` — deepagents 流式消息概念

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-parity.test.ts`
  - [ ] `pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-parity.test.ts -t "replays runtime events in exact legacy order"`
  - [ ] late replay 与实时订阅都输出一致事件序列

  **QA Scenarios**:
  ```
  Scenario: deepagents event stream matches legacy order
    Tool: Bash
    Steps:
      1. pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-parity.test.ts -t "replays runtime events in exact legacy order"
    Expected: Exit code 0; deepagents 模式事件类型、字段、顺序与 legacy 基线一致
    Evidence: .sisyphus/evidence/task-09-event-order-parity.txt

  Scenario: late subscriber replay remains intact
    Tool: Bash
    Steps:
      1. pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-parity.test.ts -t "replays buffered events to late subscribers"
    Expected: Exit code 0; 晚订阅者收到与实时消费一致的完整 buffered event 序列
    Evidence: .sisyphus/evidence/task-09-late-replay.txt
  ```

  **Commit**: YES | Message: `feat(runtime): map deepagents events to stable runtime contracts` | Files: event adapter modules, parity tests

- [ ] 10. 实现 SnapshotAdapter 与 cancel/resume 语义映射

  **What to do**: 将 deepagents checkpoint/store 状态映射为 `RunSnapshot` / `SessionSnapshot` 外部真相源。取消时保持 `cancelPoint`、`pendingOperations`、`resumeHint`；恢复时继续产生新 `runId`，并保留 `metadata.resumedFromRunId`。对于 tool side effect，沿用现有 `aborted-clean` / `aborted-with-side-effect` 与 `require-user-confirmation|replay` 语义。旧 snapshot 继续可加载；同一 session 的 resume 必须回到其原绑定引擎。
  **Must NOT do**: 不做 destructive migration；不把 deepagents checkpoint id 当作外部 runId；不在恢复时跨引擎切换。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 快照与 cancel/resume 是最大迁移风险面
  - Skills: []
  - Omitted: [`git-master`] — 无 git 历史需求

  **Parallelization**: Can Parallel: YES | Wave 2 | Blocks: T11 | Blocked By: T1, T4, T5, T6, T7, T8, T9

  **References**:
  - Pattern: `packages/runtime/src/runtime.ts:241-268` — 当前 `resumeRun` 新建 runId 语义
  - Pattern: `packages/runtime/src/runtime.ts:405-425` — cancel snapshot 与 `resumeHint` 计算
  - Pattern: `packages/runtime/src/runtime.ts:635-662` — tool cancel / side effect 状态映射
  - API/Type: `packages/contracts/src/snapshot.ts:15-76` — pending operation / resumeHint 合法值
  - Pattern: `packages/runtime/src/snapshot-store.ts:46-125` — 文件 snapshot 读写边界

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-cancel-resume.test.ts`
  - [ ] `pnpm --filter @tianji/runtime vitest run src/__tests__/legacy-snapshot-compat.test.ts`
  - [ ] cancel/resume 的 deepagents 模式与 legacy 模式在 contracts 语义上等价

  **QA Scenarios**:
  ```
  Scenario: cancel and resume semantics remain stable
    Tool: Bash
    Steps:
      1. pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-cancel-resume.test.ts
    Expected: Exit code 0; cancel 后的 pendingOperations、resumeHint、new runId、resumedFromRunId 与 legacy 一致
    Evidence: .sisyphus/evidence/task-10-cancel-resume.txt

  Scenario: side-effect cancellation requires explicit confirmation
    Tool: Bash
    Steps:
      1. pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-cancel-resume.test.ts -t "uses require-user-confirmation for destructive side effects"
    Expected: Exit code 0; destructive tool 被取消时 `resumeHint` 为 `require-user-confirmation`
    Evidence: .sisyphus/evidence/task-10-side-effect-resume-hint.txt
  ```

  **Commit**: YES | Message: `feat(runtime): preserve snapshots and cancel-resume semantics in deepagents engine` | Files: snapshot adapter modules, cancel/resume tests, fixture updates

- [ ] 11. 切换默认引擎到 deepagents，并完成 consumers/tests/docs 迁移

  **What to do**: 在 parity 套件全部通过后，把新 session 默认引擎切到 `deepagents`；保留显式 `engine: 'legacy'` 回滚开关直到 T12 完成。更新 runtime README、公共测试、usage fixtures，使 deepagents 成为唯一文档化默认路径；仍保留 migration-only 说明，明确 legacy 仅用于回滚窗口和历史 snapshot 恢复验证。
  **Must NOT do**: 不在 parity 未全部通过前翻默认值；不移除 legacy override；不省略 README 与测试样例迁移。

  **Recommended Agent Profile**:
  - Category: `deep` — Reason: 默认切换必须依赖完整兼容证据与回滚约束
  - Skills: []
  - Omitted: [`agent-browser`] — 无浏览器

  **Parallelization**: Can Parallel: YES | Wave 3 | Blocks: T12 | Blocked By: T1, T3, T5, T8, T9, T10

  **References**:
  - Pattern: `packages/runtime/README.md`（tool result 中附带）— 默认使用样例必须更新
  - Pattern: `packages/runtime/src/index.ts:11-18` — 对外导出不变，但默认路径切换
  - Pattern: `package.json:7-15` — 根级 `pnpm check` / precommit 仍是最终静态门槛

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @tianji/runtime vitest run src/__tests__/runtime.test.ts src/__tests__/runtime-parity.test.ts src/__tests__/runtime-cancel-resume.test.ts src/__tests__/legacy-snapshot-compat.test.ts`
  - [ ] `pnpm check`
  - [ ] README 样例与 public API 测试默认使用 deepagents 配置路径

  **QA Scenarios**:
  ```
  Scenario: deepagents becomes the validated default
    Tool: Bash
    Steps:
      1. pnpm --filter @tianji/runtime vitest run src/__tests__/runtime.test.ts src/__tests__/runtime-parity.test.ts src/__tests__/runtime-cancel-resume.test.ts src/__tests__/legacy-snapshot-compat.test.ts
    Expected: Exit code 0; 默认 deepagents 路径通过全量 runtime 回归与 parity 套件
    Evidence: .sisyphus/evidence/task-11-default-deepagents.txt

  Scenario: legacy override still works during rollback window
    Tool: Bash
    Steps:
      1. pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-engine-selection.test.ts -t "allows explicit legacy override before final removal"
    Expected: Exit code 0; 默认已切 deepagents，但显式 legacy override 仍可运行并通过契约断言
    Evidence: .sisyphus/evidence/task-11-legacy-override.txt
  ```

  **Commit**: YES | Message: `feat(runtime): flip default runtime to deepagents with rollback guard` | Files: runtime defaults, README, public API tests, engine selection tests

- [ ] 12. 删除 legacy 自建 runtime 实现并清理 LangGraph-specific 编排代码

  **What to do**: 在 T11 证据完备后，移除 legacy runtime engine、旧 `llmGateway` 默认路径、`workflow.ts` 主流程对自建 LangGraph 编排的依赖，以及不再需要的实现细节。保留 deepagents 所需的依赖即可；如果 `@langchain/langgraph` 仍为 deepagents 传递依赖，则不再作为 runtime 自己的编排实现直接使用。同步清理 README、注释、包描述与 keywords。
  **Must NOT do**: 不删除 parity 测试；不留下失效导出；不在未完成 T11 的情况下提前移除回滚窗口。

  **Recommended Agent Profile**:
  - Category: `quick` — Reason: 基于已验证 cutover 做最后的实现删除与清理
  - Skills: []
  - Omitted: [`git-master`] — 非 git 任务

  **Parallelization**: Can Parallel: NO | Wave 3 | Blocks: None | Blocked By: T11

  **References**:
  - Pattern: `packages/runtime/src/workflow.ts:1-31` — 旧 LangGraph 编排文件，完成 cutover 后应删除或降为 deepagents 内部桥接
  - Pattern: `packages/runtime/src/runtime.ts:63-101` — 旧 `SessionRuntimeLlmGateway` 边界
  - Pattern: `packages/runtime/package.json:22-33` — 运行时依赖与 keywords 需要最终清理

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @tianji/runtime typecheck`
  - [ ] `pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-parity.test.ts src/__tests__/runtime-cancel-resume.test.ts src/__tests__/legacy-snapshot-compat.test.ts`
  - [ ] `pnpm check`
  - [ ] runtime package 中不再保留 legacy 自建编排主路径

  **QA Scenarios**:
  ```
  Scenario: runtime works after legacy removal
    Tool: Bash
    Steps:
      1. pnpm --filter @tianji/runtime typecheck
      2. pnpm --filter @tianji/runtime vitest run src/__tests__/runtime-parity.test.ts src/__tests__/runtime-cancel-resume.test.ts src/__tests__/legacy-snapshot-compat.test.ts
    Expected: Exit code 0; 删除 legacy 实现后 deepagents 仍满足全部 contracts parity
    Evidence: .sisyphus/evidence/task-12-post-removal-runtime.txt

  Scenario: root quality gate stays clean after cleanup
    Tool: Bash
    Steps:
      1. pnpm check
    Expected: Exit code 0; 最终清理未引入 lint/type 回归
    Evidence: .sisyphus/evidence/task-12-root-check.txt
  ```

  **Commit**: YES | Message: `refactor(runtime): remove legacy custom runtime implementation` | Files: legacy engine modules, `packages/runtime/src/workflow.ts`, runtime package metadata/docs

## Final Verification Wave (MANDATORY — after ALL implementation tasks)
> 4 review agents run in PARALLEL. ALL must APPROVE. Present consolidated results to user and get explicit "okay" before completing.
> Do NOT auto-proceed after verification. Wait for user's explicit approval before marking work complete.
> Never mark F1-F4 as checked before getting user's okay. Rejection or user feedback -> fix -> re-run -> present again -> wait for okay.
- [ ] F1. Plan Compliance Audit — oracle
- [ ] F2. Code Quality Review — unspecified-high
- [ ] F3. Real Manual QA — unspecified-high (+ playwright if UI)
- [ ] F4. Scope Fidelity Check — deep

## Commit Strategy
- C1 `test(runtime): lock legacy parity matrix before deepagents cutover`
- C2 `chore(runtime): add deepagents dependency matrix and migration scaffolding`
- C3 `refactor(runtime): introduce v2 facade and session-bound engine selector`
- C4 `feat(runtime): bootstrap deepagents engine behind adapters`
- C5 `feat(runtime): map tools and runtime events to stable contracts`
- C6 `feat(runtime): preserve snapshots and cancel-resume semantics in deepagents engine`
- C7 `feat(runtime): flip default runtime to deepagents with rollback guard`
- C8 `refactor(runtime): remove legacy custom runtime implementation`

## Success Criteria
- deepagents 成为 `@tianji/runtime` 唯一长期维护的运行时内核。
- 对外 contracts 语义未泄漏 deepagents 私有概念。
- 运行时 parity 套件覆盖 happy path、tool failure、cancel、resume、late replay、legacy snapshot 读取。
- 默认切换前后均存在 agent-executed 证据文件，可证明 rollback 与 final cutover 都经过验证。
