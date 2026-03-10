# Tianji AI 基础架构构建计划 (Phase 0-2)

## TL;DR

> **Quick Summary**: 从零构建 tianji-ai 基础架构，覆盖 Phase 0 (contracts + 工程骨架)、Phase 1 (llm + AI SDK)、Phase 2 (runtime + LangGraph)。
> 
> **Deliverables**:
> - `packages/contracts` - 公共领域协议（零依赖）
> - `packages/shared` - 通用配置 schema 和工具
> - `packages/llm` - AI SDK 封装（OpenAI/Anthropic/Google）
> - `packages/runtime` - LangGraph 编排的 Session Runtime
> - 工程骨架 - pnpm/turbo/biome/vitest 配置
> 
> **Estimated Effort**: XL
> **Parallel Execution**: YES - 6 waves
> **Critical Path**: contracts → llm → runtime

---

## Context

### Original Request
根据 `docs/ARCHITECTURE_V1.md` 构建 tianji-ai 基础架构，采用 AI SDK 作为 LLM 接入层，LangGraph 作为 Agent 编排层。

### Interview Summary
**Key Discussions**:
- 计划范围: Phase 0 + 1 + 2 全覆盖（contracts/llm/runtime）
- 迁移策略: 从零开始，不复制 pi-mono 代码
- Provider 支持: OpenAI + Anthropic + Google
- 测试策略: TDD（Vitest 配置作为 Phase 0 一部分）
- 排除范围: Phase 3-5 (tools-node, observer, apps 暂不包含)

**Research Findings**:
- pi-mono 位于 `/workspaces/dev_docker/pi-mono`，包含完整实现可供参考
- 关键类型映射: AgentEvent → RuntimeEvent, ToolDefinition → ToolSpec
- 当前 tianji-ai 为空白项目，无任何代码

### Metis Review
**Identified Gaps** (addressed):
- 配置系统范围: 锁定为仅 project 层 + env 解析
- SnapshotStore 后端: 锁定为内存 + 文件系统
- Delta 聚合范围: 锁定为 MessageDelta text channel
- 取消传播范围: 锁定为基础 AbortSignal 传播

---

## Work Objectives

### Core Objective
构建 tianji-ai v1 基础架构，实现单会话、多轮对话、流式输出、基础工具调用的最小能力集。

### Concrete Deliverables
- `packages/contracts/` - 零依赖的公共协议
- `packages/shared/` - 配置 schema 和通用工具
- `packages/llm/` - AI SDK 封装层
- `packages/runtime/` - LangGraph 编排层
- `pnpm-workspace.yaml` - monorepo 配置
- `turbo.json` - 构建编排
- `biome.json` - 代码质量
- `vitest.config.ts` - 测试框架

### Definition of Done
- [ ] `pnpm check` 通过（无错误、警告）
- [ ] `pnpm --filter @tianji/contracts test` 通过
- [ ] `pnpm --filter @tianji/llm test` 通过
- [ ] `pnpm --filter @tianji/runtime test` 通过
- [ ] contracts 包零内部依赖验证
- [ ] 端到端测试：单轮对话 + 流式输出

### Must Have
- contracts 包必须零依赖（零内部依赖、零外部依赖）
- 不暴露 AI SDK/LangChain 内部类型
- ToolCatalog 是工具定义的唯一真相来源
- 所有公共类型在 contracts 中定义

### Must NOT Have (Guardrails)
- 不复制 pi-mono 代码
- 不在 Phase 0-2 实现 fallback provider 策略
- 不在 Phase 0-2 实现熔断器
- 不在 Phase 0-2 实现 user/workspace 层配置
- 不在 runtime 之外定义任何 agent loop
- 不允许 apps/* 直接依赖 @langchain/* 或 ai 包

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed.

### Test Decision
- **Infrastructure exists**: NO (需要从零搭建)
- **Automated tests**: TDD
- **Framework**: Vitest
- **TDD Flow**: 每个任务遵循 RED (failing test) → GREEN (minimal impl) → REFACTOR

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Library/Module**: Use Bash (node REPL) — Import, call functions, compare output
- **API/Backend**: Use Bash (curl) — Send requests, assert status + response fields

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (Start Immediately — foundation, 7 tasks parallel):
├── Task 1: Root package.json + pnpm-workspace.yaml [quick]
├── Task 2: turbo.json build orchestration [quick]
├── Task 3: biome.json linting/formatting [quick]
├── Task 4: Root tsconfig.json + base config [quick]
├── Task 5: packages/contracts package setup [quick]
├── Task 6: packages/shared package setup [quick]
└── Task 7: Vitest config + test infrastructure [quick]

Wave 2 (After Wave 1 — contracts types, 6 tasks parallel):
├── Task 8: Identifiers (SessionId/ThreadId/RunId) [quick]
├── Task 9: Message types (AppMessage/MessagePart) [quick]
├── Task 10: RuntimeEvent types [quick]
├── Task 11: Tool types (ToolSpec/ToolInvocation/ToolResult) [quick]
├── Task 12: Error types [quick]
└── Task 13: ExecutionPolicy types [quick]

Wave 3 (After Wave 2 — contracts advanced + shared, 6 tasks parallel):
├── Task 14: Delta types (MessageDelta/ToolProgressDelta) [quick]
├── Task 15: DeltaAggregator implementation [deep]
├── Task 16: Artifact types [quick]
├── Task 17: Snapshot types (SessionSnapshot/RunSnapshot) [quick]
├── Task 18: shared/config schema [quick]
└── Task 19: shared/utils [quick]

Wave 4 (After Wave 3 — llm package, 7 tasks parallel):
├── Task 20: llm package setup + LlmGateway interface [quick]
├── Task 21: Message conversion (AppMessage ↔ ModelMessage) [quick]
├── Task 22: OpenAI provider adapter [unspecified-high]
├── Task 23: Anthropic provider adapter [unspecified-high]
├── Task 24: Google provider adapter [unspecified-high]
├── Task 25: Tool schema bridge [quick]
└── Task 26: Usage/cost collection [quick]

Wave 5 (After Wave 4 — runtime package, 7 tasks parallel):
├── Task 27: runtime package setup + API interface [quick]
├── Task 28: Session lifecycle management [deep]
├── Task 29: LangGraph workflow definition [deep]
├── Task 30: ToolCatalog/ToolRegistry [quick]
├── Task 31: SnapshotStore (memory + file) [unspecified-high]
├── Task 32: RuntimeEvent emission [quick]
└── Task 33: Cancel propagation [deep]

Wave 6 (After Wave 5 — integration + verification, 4 tasks parallel):
├── Task 34: E2E test: single turn conversation [deep]
├── Task 35: E2E test: streaming output [deep]
├── Task 36: Dependency constraint verification [quick]
└── Task 37: Final type exports verification [quick]

Critical Path: Task 5 → Task 8-13 → Task 20 → Task 27 → Task 34-35
Parallel Speedup: ~65% faster than sequential
Max Concurrent: 7 (Waves 1 & 4)
```

### Dependency Matrix (abbreviated)

- **1-7**: — — 8-19
- **8-13**: 5 — 14-17, 20-26
- **14-19**: 5, 8-13 — 27-33
- **20-26**: 5, 8-13, 18 — 27-33
- **27-33**: 5, 8-19, 20-26 — 34-37
- **34-37**: 27-33 — —

### Agent Dispatch Summary

- **Wave 1**: **7** — T1-T4 → `quick`, T5-T7 → `quick`
- **Wave 2**: **6** — T8-T13 → `quick`
- **Wave 3**: **6** — T14, T16-T19 → `quick`, T15 → `deep`
- **Wave 4**: **7** — T20-T21, T25-T26 → `quick`, T22-T24 → `unspecified-high`
- **Wave 5**: **7** — T27, T30, T32 → `quick`, T28-T29, T33 → `deep`, T31 → `unspecified-high`
- **Wave 6**: **4** — T34-T35 → `deep`, T36-T37 → `quick`

---

## TODOs

> Implementation + Test = ONE Task. Never separate.
> EVERY task MUST have: Recommended Agent Profile + Parallelization info + QA Scenarios.

### Wave 1: 工程骨架 (7 tasks, parallel)

- [ ] 1. Root package.json + pnpm-workspace.yaml

  **What to do**:
  - 创建根目录 `package.json` (name: tianji-ai, private: true)
  - 创建 `pnpm-workspace.yaml` 定义 packages/* 和 apps/*
  - 添加基础 scripts: check, build, test, lint, format

  **Must NOT do**:
  - 不添加任何 dependencies (monorepo root 应该是空的)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1 (with Tasks 2-7)
  - **Blocks**: Tasks 5-7 (需要 workspace 配置)
  - **Blocked By**: None

  **References**:
  - pnpm docs: https://pnpm.io/workspaces

  **Acceptance Criteria**:
  - [ ] `pnpm install` 成功执行
  - [ ] `pnpm list -r --depth 0` 显示空列表（暂无包）

  **QA Scenarios**:
  ```
  Scenario: pnpm workspace config valid
    Tool: Bash
    Steps:
      1. pnpm install
      2. pnpm list -r --depth 0
    Expected Result: Command succeeds, shows empty or valid packages
    Evidence: .sisyphus/evidence/task-01-workspace.txt
  ```

  **Commit**: NO (groups with Wave 1)

- [ ] 2. turbo.json build orchestration

  **What to do**:
  - 创建 `turbo.json` 配置文件
  - 定义 pipeline: build, test, lint, format, check
  - 配置缓存策略
  - 添加 typecheck task

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocked By**: None

  **References**:
  - Turborepo docs: https://turbo.build/repo/docs

  **Acceptance Criteria**:
  - [ ] `turbo build --dry-run` 显示有效的 pipeline

  **QA Scenarios**:
  ```
  Scenario: turbo config valid
    Tool: Bash
    Steps:
      1. npx turbo build --dry-run=json
    Expected Result: Returns valid JSON with task graph
    Evidence: .sisyphus/evidence/task-02-turbo.json
  ```

  **Commit**: NO (groups with Wave 1)

- [ ] 3. biome.json linting/formatting

  **What to do**:
  - 创建 `biome.json` 配置文件
  - 配置 linter rules (推荐 strict)
  - 配置 formatter (推荐 2 spaces, no semicolons)
  - 配置 import organization
  - 添加 scripts: lint, format, check

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocked By**: None

  **References**:
  - Biome docs: https://biomejs.dev/

  **Acceptance Criteria**:
  - [ ] `biome check --help` 可用

  **QA Scenarios**:
  ```
  Scenario: biome config valid
    Tool: Bash
    Steps:
      1. npx biome check --help
    Expected Result: Shows help text without errors
    Evidence: .sisyphus/evidence/task-03-biome.txt
  ```

  **Commit**: NO (groups with Wave 1)

- [ ] 4. Root tsconfig.json + base config

  **What to do**:
  - 创建根 `tsconfig.json` 作为 base config
  - 启用 strict mode
  - 配置 moduleResolution: bundler
  - 配置 target: ES2022
  - 创建 `tsconfig.build.json` 用于构建

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocked By**: None

  **References**:
  - TSConfig docs: https://www.typescriptlang.org/tsconfig

  **Acceptance Criteria**:
  - [ ] `tsc --showConfig` 显示有效配置

  **QA Scenarios**:
  ```
  Scenario: tsconfig valid
    Tool: Bash
    Steps:
      1. npx tsc --showConfig
    Expected Result: Returns valid JSON config with strict: true
    Evidence: .sisyphus/evidence/task-04-tsconfig.json
  ```

  **Commit**: NO (groups with Wave 1)

- [ ] 5. packages/contracts package setup

  **What to do**:
  - 创建 `packages/contracts/` 目录
  - 创建 `package.json` (name: @tianji/contracts)
  - **确保 dependencies 为空对象或不存在**
  - 创建 `tsconfig.json` 继承根配置
  - 创建 `src/index.ts` 作为 barrel export
  - 创建 `vitest.config.ts`
  - 创建基础测试文件 `src/__tests__/index.test.ts`

  **Must NOT do**:
  - 不添加任何 dependencies (contracts 必须零依赖)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with Tasks 6-7)
  - **Parallel Group**: Wave 1
  - **Blocks**: Tasks 8-19 (contracts types)
  - **Blocked By**: Task 1 (workspace config)

  **References**:
  - 架构文档 4.1 节: contracts 职责定义

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @tianji/contracts build` 成功
  - [ ] `pnpm --filter @tianji/contracts test` 成功
  - [ ] contracts package.json 的 dependencies 为空

  **QA Scenarios**:
  ```
  Scenario: contracts zero dependency
    Tool: Bash
    Steps:
      1. node -e "const pkg = require('./packages/contracts/package.json'); console.log(Object.keys(pkg.dependencies || {}).length)"
    Expected Result: Output is '0'
    Evidence: .sisyphus/evidence/task-05-zero-deps.txt
  ```

  **Commit**: NO (groups with Wave 1)

- [ ] 6. packages/shared package setup

  **What to do**:
  - 创建 `packages/shared/` 目录
  - 创建 `package.json` (name: @tianji/shared)
  - 允许外部 utility 依赖 (zod, type-fest 等)
  - 创建 `tsconfig.json` 继承根配置
  - 创建 `src/index.ts` 作为 barrel export
  - 创建 `vitest.config.ts`

  **Must NOT do**:
  - 不依赖任何内部包 (contracts, llm, runtime 等)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocks**: Tasks 18-19 (shared types)
  - **Blocked By**: Task 1

  **References**:
  - 架构文档 6.3 节: shared 允许依赖外部 utility

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @tianji/shared build` 成功

  **QA Scenarios**:
  ```
  Scenario: shared no internal deps
    Tool: Bash
    Steps:
      1. node -e "const pkg = require('./packages/shared/package.json'); const deps = Object.keys(pkg.dependencies || {}); console.log(deps.filter(d => d.startsWith('@tianji/')).length)"
    Expected Result: Output is '0'
    Evidence: .sisyphus/evidence/task-06-no-internal-deps.txt
  ```

  **Commit**: NO (groups with Wave 1)

- [ ] 7. Vitest config + test infrastructure

  **What to do**:
  - 创建根 `vitest.config.ts` 作为 base config
  - 配置 coverage reporter
  - 配置 test match pattern
  - 在根 package.json 添加 test script
  - 创建 `.github/workflows/test.yml` (可选，Phase 0 后)

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 1
  - **Blocked By**: Task 1

  **References**:
  - Vitest docs: https://vitest.dev/config/

  **Acceptance Criteria**:
  - [ ] `vitest --version` 显示版本
  - [ ] `pnpm test` 可执行（即使无测试）

  **QA Scenarios**:
  ```
  Scenario: vitest config valid
    Tool: Bash
    Steps:
      1. npx vitest --version
    Expected Result: Shows version number
    Evidence: .sisyphus/evidence/task-07-vitest.txt
  ```

  **Commit**: YES (Wave 1 complete)
  - Message: `chore(scaffold): initialize monorepo with pnpm/turbo/biome/vitest`
  - Files: All Wave 1 files
  - Pre-commit: `pnpm check`

### Wave 2: Contracts 核心类型 (6 tasks, parallel)

- [ ] 8. Identifiers (SessionId/ThreadId/RunId)

  **What to do**:
  - 创建 `packages/contracts/src/identifiers.ts`
  - 定义 `SessionId = string & { readonly __brand: unique symbol }`
  - 定义 `ThreadId = string & { readonly __brand: unique symbol }`
  - 定义 `RunId = string & { readonly __brand: unique symbol }`
  - 创建 factory functions: `createSessionId()`, `createThreadId()`, `createRunId()`
  - 创建 type guards: `isSessionId()`, `isThreadId()`, `isRunId()`
  - 导出至 `src/index.ts`
  - 编写单元测试

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2 (with Tasks 9-13)
  - **Blocked By**: Task 5 (contracts package setup)

  **References**:
  - 架构文档 4.1 节: SessionId, ThreadId, RunId 定义

  **Acceptance Criteria**:
  - [ ] 类型为 branded type，防止普通 string 赋值
  - [ ] `pnpm --filter @tianji/contracts test -- --grep identifiers` 通过

  **QA Scenarios**:
  ```
  Scenario: branded types prevent string assignment
    Tool: Bash (node)
    Steps:
      1. Import { SessionId, createSessionId } from '@tianji/contracts'
      2. const id: SessionId = createSessionId()
      3. const str: string = id // should work
      4. // const id2: SessionId = 'plain-string' // should NOT compile
    Expected Result: TypeScript compiles valid assignments, rejects invalid
    Evidence: .sisyphus/evidence/task-08-identifiers.txt
  ```

  **Commit**: NO (groups with Wave 2)

- [ ] 9. Message types (AppMessage/MessagePart)

  **What to do**:
  - 创建 `packages/contracts/src/message.ts`
  - 定义 `MessageRole = 'user' | 'assistant' | 'system'`
  - 定义 `TextContent = { type: 'text'; text: string }`
  - 定义 `ThinkingContent = { type: 'thinking'; thinking: string }`
  - 定义 `ImageContent = { type: 'image'; url: string; mimeType?: string }`
  - 定义 `ToolCall = { type: 'tool-call'; toolCallId: string; toolName: string; args: unknown }`
  - 定义 `MessagePart = TextContent | ThinkingContent | ImageContent | ToolCall`
  - 定义 `AppMessage = { id: string; role: MessageRole; content: MessagePart[]; createdAt: number }`
  - 导出至 `src/index.ts`
  - 编写单元测试

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocked By**: Task 5, Task 8 (需要 identifiers)

  **References**:
  - 架构文档 4.1 节: AppMessage, MessagePart 定义

  **Acceptance Criteria**:
  - [ ] 所有 message content types 定义完整
  - [ ] `pnpm --filter @tianji/contracts test -- --grep message` 通过

  **QA Scenarios**:
  ```
  Scenario: message types exhaustive
    Tool: Bash (node)
    Steps:
      1. Import all message types
      2. Create valid instances of each MessagePart variant
      3. Verify TypeScript accepts each
    Expected Result: All variants compile without error
    Evidence: .sisyphus/evidence/task-09-message-types.txt
  ```

  **Commit**: NO (groups with Wave 2)

- [ ] 10. RuntimeEvent types

  **What to do**:
  - 创建 `packages/contracts/src/events.ts`
  - 定义 `RuntimeEventType` 枚举/联合类型:
    - `run.started`, `run.completed`, `run.failed`, `run.cancelled`
    - `message.started`, `message.delta`, `message.completed`
    - `tool.started`, `tool.completed`, `tool.failed`
  - 定义 `RuntimeEvent` 联合类型（每个事件类型有对应 payload）
  - 定义 `RunStartedEvent`, `MessageDeltaEvent` 等具体事件类型
  - 导出至 `src/index.ts`
  - 编写单元测试

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocked By**: Task 5, Task 8

  **References**:
  - 架构文档 4.1 节: RuntimeEvent 定义

  **Acceptance Criteria**:
  - [ ] 所有事件类型定义完整
  - [ ] 事件 payload 类型正确
  - [ ] `pnpm --filter @tianji/contracts test -- --grep events` 通过

  **QA Scenarios**:
  ```
  Scenario: event types discriminable
    Tool: Bash (node)
    Steps:
      1. Create instance of each RuntimeEvent variant
      2. Use switch/if on event.type
      3. Verify TypeScript narrows type correctly
    Expected Result: Type narrowing works for all variants
    Evidence: .sisyphus/evidence/task-10-events.txt
  ```

  **Commit**: NO (groups with Wave 2)

- [ ] 11. Tool types (ToolSpec/ToolInvocation/ToolResult)

  **What to do**:
  - 创建 `packages/contracts/src/tool.ts`
  - 定义 `ToolSpec = { name: string; description: string; parameters: JSONSchema; permissions?: string[] }`
  - 定义 `ToolInvocation = { toolCallId: string; toolName: string; args: unknown }`
  - 定义 `ToolResult = { toolCallId: string; result: unknown; error?: ToolError }`
  - 定义 `ToolError` 类型
  - 导出至 `src/index.ts`
  - 编写单元测试

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocked By**: Task 5

  **References**:
  - 架构文档 10.1 节: 工具抽象定义

  **Acceptance Criteria**:
  - [ ] ToolSpec 包含必要字段
  - [ ] `pnpm --filter @tianji/contracts test -- --grep tool` 通过

  **QA Scenarios**:
  ```
  Scenario: tool types valid
    Tool: Bash (node)
    Steps:
      1. Create valid ToolSpec instance
      2. Create valid ToolInvocation instance
      3. Create valid ToolResult instance
    Expected Result: All instances compile
    Evidence: .sisyphus/evidence/task-11-tool-types.txt
  ```

  **Commit**: NO (groups with Wave 2)

- [ ] 12. Error types

  **What to do**:
  - 创建 `packages/contracts/src/errors.ts`
  - 定义错误基类 `TianjiError extends Error`
  - 定义 `ProviderError`, `ToolError`, `PolicyError`, `TimeoutError`, `CancelledError`
  - 每个错误包含 `code`, `message`, `cause?`
  - 定义 `ErrorCategory = 'provider' | 'tool' | 'policy' | 'timeout' | 'cancelled' | 'state' | 'internal'`
  - 导出至 `src/index.ts`
  - 编写单元测试

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocked By**: Task 5

  **References**:
  - 架构文档 9.5 节: 错误模型定义

  **Acceptance Criteria**:
  - [ ] 所有错误类型定义完整
  - [ ] 错误可序列化
  - [ ] `pnpm --filter @tianji/contracts test -- --grep errors` 通过

  **QA Scenarios**:
  ```
  Scenario: errors serializable
    Tool: Bash (node)
    Steps:
      1. Create ProviderError instance
      2. JSON.stringify(error.toPlainObject())
    Expected Result: JSON is valid and contains all fields
    Evidence: .sisyphus/evidence/task-12-errors.txt
  ```

  **Commit**: NO (groups with Wave 2)

- [ ] 13. ExecutionPolicy types

  **What to do**:
  - 创建 `packages/contracts/src/policy.ts`
  - 定义 `RetryPolicy = { maxAttempts: number; baseDelayMs: number; maxDelayMs: number }`
  - 定义 `ToolPolicy = { timeoutMs: number; maxConcurrency: number; allowDestructive: boolean }`
  - 定义 `PathPolicy = { forbidDirectories: string[]; filenameDenyPatterns: string[] }`
  - 定义 `ExecutionPolicy = { retry: RetryPolicy; tool: ToolPolicy; toolPath: PathPolicy }`
  - 定义 `DEFAULT_EXECUTION_POLICY`
  - 导出至 `src/index.ts`
  - 编写单元测试

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES
  - **Parallel Group**: Wave 2
  - **Blocked By**: Task 5

  **References**:
  - 架构文档 4.1 节: ExecutionPolicy 定义

  **Acceptance Criteria**:
  - [ ] v1 core fields 全部定义
  - [ ] DEFAULT_EXECUTION_POLICY 提供合理默认值
  - [ ] `pnpm --filter @tianji/contracts test -- --grep policy` 通过

  **QA Scenarios**:
  ```
  Scenario: default policy valid
    Tool: Bash (node)
    Steps:
      1. Import DEFAULT_EXECUTION_POLICY
      2. Verify all required fields present
    Expected Result: Default has all required fields with valid values
    Evidence: .sisyphus/evidence/task-13-policy.txt
  ```

  **Commit**: YES (Wave 2 complete)
  - Message: `feat(contracts): add core type definitions (identifiers, messages, events, tools, errors, policy)`
  - Files: packages/contracts/src/*.ts

### Wave 3: Contracts Advanced + Shared (6 tasks, parallel)

- [ ] 14. Delta types (MessageDelta/ToolProgressDelta)
  **What to do**: 创建 delta.ts，定义 DeltaOp, MessageDelta, ToolProgressDelta 类型
  **Acceptance**: `pnpm --filter @tianji/contracts test -- --grep delta` 通过
  **Commit**: NO

- [ ] 15. DeltaAggregator implementation
  **What to do**: 创建 delta-aggregator.ts，实现 applyMessageDelta 和 isComplete 纯函数
  **Category**: `deep`
  **Acceptance**: append/complete 操作正确，测试通过
  **Commit**: NO

- [ ] 16. Artifact types
  **What to do**: 创建 artifact.ts，定义 ArtifactType 和 Artifact 类型
  **Acceptance**: `pnpm --filter @tianji/contracts test -- --grep artifact` 通过
  **Commit**: NO

- [ ] 17. Snapshot types (SessionSnapshot/RunSnapshot)
  **What to do**: 创建 snapshot.ts，定义 SessionSnapshot 和 RunSnapshot
  **Acceptance**: `pnpm --filter @tianji/contracts test -- --grep snapshot` 通过
  **Commit**: NO

- [ ] 18. shared/config schema
  **What to do**: 创建 config schema，使用 zod 定义配置，实现 env 占位符解析
  **Acceptance**: `pnpm --filter @tianji/shared test -- --grep config` 通过
  **Commit**: NO

- [ ] 19. shared/utils
  **What to do**: 创建 utils，实现 deepClone, sleep, retry 函数
  **Acceptance**: `pnpm --filter @tianji/shared test -- --grep utils` 通过
  **Commit**: YES (Wave 3)
  - Message: `feat(contracts,shared): add delta types, aggregator, snapshots, config schema`

### Wave 4: LLM Package (7 tasks, parallel)

- [ ] 20. llm package setup + LlmGateway interface
  **What to do**: 创建 packages/llm，定义 LlmGateway 和 LlmStream 接口
  **Must NOT do**: 不依赖 @langchain/*
  **Acceptance**: `pnpm --filter @tianji/llm build` 成功
  **Commit**: NO

- [ ] 21. Message conversion (AppMessage ↔ ModelMessage)
  **What to do**: 实现 AppMessage 到 AI SDK ModelMessage 的双向转换
  **Acceptance**: 双向转换无损，测试通过
  **Commit**: NO

- [ ] 22. OpenAI provider adapter
  **What to do**: 使用 @ai-sdk/openai 实现 OpenAI provider
  **Category**: `unspecified-high`
  **Acceptance**: streaming 和 tool calling 测试通过
  **Commit**: NO

- [ ] 23. Anthropic provider adapter
  **What to do**: 使用 @ai-sdk/anthropic 实现 Anthropic provider
  **Category**: `unspecified-high`
  **Acceptance**: streaming 和 tool calling 测试通过
  **Commit**: NO

- [ ] 24. Google provider adapter
  **What to do**: 使用 @ai-sdk/google 实现 Google provider
  **Category**: `unspecified-high`
  **Acceptance**: streaming 和 tool calling 测试通过
  **Commit**: NO

- [ ] 25. Tool schema bridge
  **What to do**: 实现 ToolSpec 到 AI SDK tool schema 的转换
  **Acceptance**: 工具参数正确映射，测试通过
  **Commit**: NO

- [ ] 26. Usage/cost collection
  **What to do**: 实现 token usage 和 cost 收集
  **Acceptance**: usage 数据正确收集，测试通过
  **Commit**: YES (Wave 4)
  - Message: `feat(llm): implement AI SDK wrapper with OpenAI/Anthropic/Google`

### Wave 5: Runtime Package (7 tasks, parallel)

- [ ] 27. runtime package setup + API interface
  **What to do**: 创建 packages/runtime，定义 createSession/runTurn/resumeRun/streamEvents API
  **Must NOT do**: 不暴露 LangChain 内部类型
  **Acceptance**: `pnpm --filter @tianji/runtime build` 成功
  **Commit**: NO

- [ ] 28. Session lifecycle management
  **What to do**: 实现 Session 创建、恢复、关闭生命周期
  **Category**: `deep`
  **Acceptance**: 生命周期测试通过
  **Commit**: NO

- [ ] 29. LangGraph workflow definition
  **What to do**: 使用 LangGraph 定义 agent 工作流图
  **Category**: `deep`
  **Acceptance**: 工作流执行正确，测试通过
  **Commit**: NO

- [ ] 30. ToolCatalog/ToolRegistry
  **What to do**: 实现工具注册和查找
  **Acceptance**: 工具注册和查找正确，测试通过
  **Commit**: NO

- [ ] 31. SnapshotStore (memory + file)
  **What to do**: 实现内存和文件系统 SnapshotStore
  **Category**: `unspecified-high`
  **Acceptance**: save/load 测试通过
  **Commit**: NO

- [ ] 32. RuntimeEvent emission
  **What to do**: 实现 RuntimeEvent 发射和流式传输
  **Acceptance**: 事件流正确，测试通过
  **Commit**: NO

- [ ] 33. Cancel propagation
  **What to do**: 实现 AbortSignal 到 LLM/tool/retry 的传播
  **Category**: `deep`
  **Acceptance**: 取消传播测试通过
  **Commit**: YES (Wave 5)
  - Message: `feat(runtime): implement LangGraph-based session runtime`

### Wave 6: Integration + Verification (4 tasks, parallel)

- [ ] 34. E2E test: single turn conversation
  **What to do**: 编写端到端测试，验证完整对话流程
  **Category**: `deep`
  **Acceptance**: createSession → runTurn → 验证输出 测试通过
  **Commit**: NO

- [ ] 35. E2E test: streaming output
  **What to do**: 编写流式输出测试
  **Category**: `deep`
  **Acceptance**: 流式 delta 正确聚合，测试通过
  **Commit**: NO

- [ ] 36. Dependency constraint verification
  **What to do**: 验证 contracts 零依赖，llm 无 @langchain/*
  **Acceptance**: 约束验证通过
  **Commit**: NO

- [ ] 37. Final type exports verification
  **What to do**: 验证所有类型正确导出
  **Acceptance**: 类型导出验证通过
  **Commit**: YES (Wave 6)
  - Message: `test: add e2e integration tests`

---
## Final Verification Wave (MANDATORY — after ALL implementation tasks)

- [ ] F1. **Plan Compliance Audit** — `oracle`
  Read the plan end-to-end. For each "Must Have": verify implementation exists. For each "Must NOT Have": search codebase for forbidden patterns. Compare deliverables against plan.
  Output: `Must Have [N/N] | Must NOT Have [N/N] | Tasks [N/N] | VERDICT: APPROVE/REJECT`

- [ ] F2. **Code Quality Review** — `unspecified-high`
  Run `pnpm check` (tsc + biome + vitest). Review all files for: `as any`/`@ts-ignore`, empty catches, unused imports. Check AI slop patterns.
  Output: `Build [PASS/FAIL] | Lint [PASS/FAIL] | Tests [N pass/N fail] | VERDICT`

- [ ] F3. **Dependency Constraint Verification** — `quick`
  Verify contracts has zero dependencies. Verify llm does not depend on @langchain/*. Verify no circular dependencies.
  Output: `Contracts [0 deps] | LLM [no langchain] | Circular [CLEAN/N issues] | VERDICT`

- [ ] F4. **E2E Integration Test** — `deep`
  Execute full flow: createSession → runTurn (with tool) → streamEvents → verify output. Test all 3 providers.
  Output: `Session [PASS] | Streaming [PASS] | Tools [PASS] | Providers [3/3] | VERDICT`

---

## Commit Strategy

注意，commit 需要加载 git commit skill。
采用 atomic commits，每个完成的 wave 作为一组提交：

- **Wave 1**: `chore(scaffold): initialize monorepo with pnpm/turbo/biome/vitest`
- **Wave 2**: `feat(contracts): add core type definitions (identifiers, messages, events)`
- **Wave 3**: `feat(contracts): add delta types and aggregator`
- **Wave 4**: `feat(llm): implement AI SDK wrapper with OpenAI/Anthropic/Google`
- **Wave 5**: `feat(runtime): implement LangGraph-based session runtime`
- **Wave 6**: `test: add e2e integration tests`

---

## Success Criteria

### Verification Commands
```bash
# 1. Full check
pnpm check
# Expected: No errors, no warnings

# 2. Contracts zero dependency
node -e "const pkg = require('./packages/contracts/package.json'); console.log(Object.keys(pkg.dependencies || {}).length)"
# Expected: 0

# 3. All tests pass
pnpm -r test
# Expected: All tests pass

# 4. Type exports
pnpm --filter @tianji/contracts exec tsc --noEmit --declaration
pnpm --filter @tianji/llm exec tsc --noEmit --declaration
pnpm --filter @tianji/runtime exec tsc --noEmit --declaration
# Expected: No errors
```

### Final Checklist
- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] All tests pass
- [ ] contracts 零依赖
- [ ] 不暴露框架内部类型
- [ ] E2E 测试通过（3 providers）
