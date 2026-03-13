# Tianji AI Foundation 审计整改计划

## TL;DR

> **Quick Summary**: 修复 foundation 审计中的失败项，收敛公共类型边界，补齐 provider/runtime 行为验证，完成 Final Verification Wave 和 evidence 闭环。
> 
> **Deliverables**:
> - 公共类型收敛到 `packages/contracts`
> - Provider adapter 行为测试（OpenAI/Anthropic/Google）
> - Runtime lifecycle 行为测试（resume/cancel）
> - Final Verification Wave 闭环
> - `.sisyphus/evidence` 补齐 task-22~37 和 F1~F4
> 
> **Estimated Effort**: L
> **Parallel Execution**: YES - 4 waves
> **Critical Path**: 类型迁移 → 验证补齐 → 最终审计

---

## Context

### Original Request
根据 `.sisyphus/plans/tianji-ai-foundation.md` 审计结果，修复以下失败项：
1. Must Have 违规：公共类型未集中到 `packages/contracts`
2. Task 22-24 验收不足：Provider adapter 缺少行为测试
3. Task 28/33 验收不足：Runtime lifecycle 和 cancellation 缺少行为测试
4. Final Verification Wave 未闭环：F1-F4 缺失
5. Evidence 缺失：`.sisyphus/evidence` 仅覆盖 task-01~21

### Audit Summary
**Oracle Verdict**: REJECT
- Must Have: 3/4
- Must NOT Have: 6/6
- Tasks: 32/37
- DoD: 6/6

**Key Gaps**:
- `packages/llm/src/index.ts` 导出 `LlmRequest`, `LlmResponse`, `LlmGateway`, `LlmStream`, `LlmProvider` 等公共类型
- `packages/runtime/src/runtime.ts` 导出 `SessionRuntime`, `CreateSessionOptions`, `RunTurnOptions`, `ResumeRunOptions` 等
- `packages/runtime/src/tool-catalog.ts` 导出 `ToolCatalog`, `RuntimeToolDefinition`, `RuntimeToolExecutionContext` 等
- Provider adapter 测试仅覆盖工厂创建，未覆盖 streaming/tool-calling 行为
- Runtime lifecycle 测试未覆盖 `resumeRun`、`closeSession` 的真实行为
- Cancellation 测试未覆盖 `cancelRun`、`AbortSignal` 传播、`run.cancelled` 事件
- `.sisyphus/evidence` 缺失 task-22~37 和 F1~F4

### Metis Review
**Critical Guardrails**:
- 不扩展到 Phase 3+（无 fallback provider、无 circuit breaker、无 tools-node/observer/apps）
- 类型迁移顺序：`contracts` → `llm` → `runtime` → verification
- TDD：先写/调整失败测试，再最小实现，再重构
- 不通过削弱 exports 或删除已有公开面来"解决"审计缺口
- Provider 测试使用 mock，不要求 live API key
- Cancel/resume 验证必须同时断言持久化状态和发出的事件
- 每个任务必须以 agent-executable QA 和 `.sisyphus/evidence/` 文件结尾

**Missing Acceptance Criteria** (已纳入本计划):
- 类型迁移后的包级 typecheck 必须通过
- 公共面测试：从 `@tianji/llm` 和 `@tianji/runtime` root 导入，不 deep import
- Provider contract test：`getProviderInfo()`、`isReady()`、config passthrough、stream delta propagation、tool-call/result mapping、provider error wrapping
- Runtime lifecycle：`resumeRun` 从 cancelled run 创建新 run 并设置 `metadata.resumedFromRunId`；`closeSession` 标记 `closedAt`，abort 活跃 run，阻塞后续 `runTurn`/`resumeRun`
- Cancellation：`cancelRun(runId)` 返回 `true`/`false`，发出 `run.cancelled`，持久化 `status: "cancelled"`，设置 `cancelPoint` 和 `resumeHint`；外部 `AbortSignal` 必须等价于 `cancelRun` 的持久化/结果语义
- Final verification：`.sisyphus/evidence/task-22-*.txt` ~ `task-37-*.txt` 和 `F1`~`F4` 文件存在并对应可执行验证命令

---

## Work Objectives

### Core Objective
修复 foundation 审计失败项，使项目达到计划定义的完成态。

### Concrete Deliverables
- `packages/contracts/src/llm-types.ts` - LLM 公共类型定义
- `packages/contracts/src/runtime-types.ts` - Runtime 公共类型定义
- `packages/llm/src/__tests__/provider-contract.test.ts` - Provider contract 测试
- `packages/runtime/src/__tests__/lifecycle.test.ts` - Lifecycle 行为测试
- `packages/runtime/src/__tests__/cancellation.test.ts` - Cancellation 行为测试
- `.sisyphus/evidence/task-22-*.txt` ~ `task-37-*.txt`
- `.sisyphus/evidence/F1-*.txt` ~ `F4-*.txt`
- `.sisyphus/plans/tianji-ai-foundation.md` 复选框更新

### Definition of Done
- [ ] `pnpm check` 通过（无错误、警告）
- [ ] `pnpm --filter @tianji/contracts test` 通过
- [ ] `pnpm --filter @tianji/llm test` 通过
- [ ] `pnpm --filter @tianji/runtime test` 通过
- [ ] 公共类型仅从 `@tianji/contracts` 导出
- [ ] Provider contract test 覆盖 3 providers
- [ ] Runtime lifecycle test 覆盖 resume/cancel
- [ ] `.sisyphus/evidence` 覆盖 task-22~37 和 F1~F4
- [ ] Oracle re-audit verdict: APPROVE

### Must Have
- 公共类型集中到 `contracts`，`llm`/`runtime` 从 `@tianji/contracts` 导入
- 所有整改任务有 agent-executable QA 和 evidence 文件
- 测试使用 mock，不依赖 live API
- Cancel/resume 验证同时覆盖事件和持久化状态

### Must NOT Have (Guardrails)
- 不扩展到 Phase 3+（tools-node, observer, apps）
- 不实现 fallback provider 策略
- 不实现熔断器
- 不通过删除/削弱已有 exports 来"解决"审计缺口
- 不在整改范围外重构 `SdkLlmGateway` 或 workflow 内部
- 不引入新的跨包循环依赖

---

## Verification Strategy (MANDATORY)

> **ZERO HUMAN INTERVENTION** — ALL verification is agent-executed.

### Test Decision
- **Infrastructure exists**: YES (已有 vitest)
- **Automated tests**: TDD（先写失败测试，再最小实现）
- **Framework**: Vitest
- **TDD Flow**: RED (failing test) → GREEN (minimal impl) → REFACTOR

### QA Policy
Every task MUST include agent-executed QA scenarios.
Evidence saved to `.sisyphus/evidence/task-{N}-{scenario-slug}.{ext}`.

- **Library/Module**: Use Bash (node REPL) — Import, call functions, compare output
- **API/Backend**: Use Bash (curl) — Send requests, assert status + response fields

---

## Execution Strategy

### Parallel Execution Waves

```
Wave 1 (类型迁移 — 6 tasks, mostly sequential due to dependency):
├── Task R1: Identify types to migrate [quick]
├── Task R2: Add llm-types to contracts [quick]
├── Task R3: Add runtime-types to contracts [quick]
├── Task R4: Update llm imports [quick]
├── Task R5: Update runtime imports [quick]
└── Task R6: Verify no circular dependencies [quick]

Wave 2 (Provider 验证 — 4 tasks, parallel):
├── Task R7: Provider contract test infrastructure [quick]
├── Task R8: OpenAI provider contract test [unspecified-high]
├── Task R9: Anthropic provider contract test [unspecified-high]
└── Task R10: Google provider contract test [unspecified-high]

Wave 3 (Runtime 验证 — 4 tasks, parallel):
├── Task R11: Lifecycle test infrastructure [quick]
├── Task R12: resumeRun behavior test [deep]
├── Task R13: closeSession behavior test [deep]
└── Task R14: cancelRun & AbortSignal test [deep]

Wave 4 (Final Verification + Evidence — 5 tasks, parallel):
├── Task R15: Re-run all tests [quick]
├── Task R16: Generate evidence task-22~37 [quick]
├── Task R17: Final verification F1~F4 [deep]
├── Task R18: Update foundation plan checkboxes [quick]
└── Task R19: Oracle re-audit [oracle]

Critical Path: R1-R6 → R7-R10 / R11-R14 (parallel) → R15-R19
Parallel Speedup: ~40% faster than sequential
Max Concurrent: 4 (Waves 2 & 3)
```

### Dependency Matrix (abbreviated)

- **R1-R6**: Sequential (类型迁移有依赖顺序)
- **R7-R10**: R6 — R15-R19
- **R11-R14**: R6 — R15-R19
- **R15-R19**: R7-R14 — —

---

## TODOs

> Implementation + Test = ONE Task. Never separate.
> EVERY task MUST have: Recommended Agent Profile + Parallelization info + QA Scenarios.

### Wave 1: 类型迁移 (6 tasks, sequential)

- [ ] **R1. Identify types to migrate**

  **What to do**:
  - 分析 `packages/llm/src/index.ts` 导出的所有类型
  - 分析 `packages/runtime/src/runtime.ts` 导出的所有类型
  - 分析 `packages/runtime/src/tool-catalog.ts` 导出的所有类型
  - 列出需要迁移到 `contracts` 的公共类型清单
  - 标记哪些类型是包内部使用的（不应迁移）

  **Must NOT do**:
  - 不修改任何文件
  - 不猜测，必须基于代码分析

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO（后续任务依赖此清单）
  - **Blocks**: R2-R5
  - **Blocked By**: None

  **Acceptance Criteria**:
  - [ ] 生成清单文件 `.sisyphus/drafts/type-migration-checklist.md`
  - [ ] 清单包含：类型名称、当前文件、是否迁移、理由

  **QA Scenarios**:
  ```
  Scenario: type migration checklist exists
    Tool: Bash
    Steps:
      1. ls .sisyphus/drafts/type-migration-checklist.md
    Expected Result: File exists
    Evidence: .sisyphus/evidence/task-R1-checklist.txt
  ```

  **Commit**: NO (groups with Wave 1)

- [ ] **R2. Add llm-types to contracts**

  **What to do**:
  - 在 `packages/contracts/src/` 创建 `llm-types.ts`
  - 迁移以下类型（基于 R1 清单）：
    - `LlmProvider`
    - `LlmPricing`
    - `LlmProviderConfig`
    - `LlmGenerationConfig`
    - `LlmToolExecutionOptions`
    - `LlmToolExecutor`
    - `LlmRequest`
    - `LlmCost`
    - `LlmUsage`
    - `LlmResponseMeta`
    - `LlmResponse`
    - `LlmStreamDelta`
    - `LlmStreamComplete`
    - `LlmStreamError`
    - `LlmStreamEvent`
    - `LlmStreamCallback`
    - `LlmStream`
    - `LlmGateway`
  - 在 `packages/contracts/src/index.ts` 中导出
  - 编写类型测试验证导出正确

  **Must NOT do**:
  - 不导入任何外部依赖（contracts 必须零依赖）
  - 不导入 AI SDK 或 LangChain 类型
  - 不修改 `packages/llm` 的代码（在 R4 中做）

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO（依赖 R1）
  - **Blocks**: R4
  - **Blocked By**: R1

  **Acceptance Criteria**:
  - [ ] `packages/contracts/src/llm-types.ts` 存在
  - [ ] `pnpm --filter @tianji/contracts build` 成功
  - [ ] `pnpm --filter @tianji/contracts test` 通过
  - [ ] contracts 仍然零依赖

  **QA Scenarios**:
  ```
  Scenario: llm-types exports correctly
    Tool: Bash
    Steps:
      1. node -e "const types = require('@tianji/contracts'); console.log(typeof types.LlmGateway)"
    Expected Result: Output is 'object' or 'function'
    Evidence: .sisyphus/evidence/task-R2-llm-types.txt
  ```

  **Commit**: NO (groups with Wave 1)

- [ ] **R3. Add runtime-types to contracts**

  **What to do**:
  - 在 `packages/contracts/src/` 创建 `runtime-types.ts`
  - 迁移以下类型（基于 R1 清单）：
    - `CreateSessionOptions`
    - `RunTurnOptions`
    - `ResumeRunOptions`
    - `SessionRuntimeOptions`
    - `SessionRuntime`
    - `RuntimeToolDefinition`
    - `RuntimeToolExecutionContext`
    - `RuntimeToolSideEffect`
    - `ToolCatalog`
  - 在 `packages/contracts/src/index.ts` 中导出
  - 编写类型测试验证导出正确

  **Must NOT do**:
  - 不导入任何外部依赖
  - 不导入 LangChain 类型
  - 不修改 `packages/runtime` 的代码（在 R5 中做）

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO（依赖 R2，避免同一文件冲突）
  - **Blocks**: R5
  - **Blocked By**: R2

  **Acceptance Criteria**:
  - [ ] `packages/contracts/src/runtime-types.ts` 存在
  - [ ] `pnpm --filter @tianji/contracts build` 成功
  - [ ] `pnpm --filter @tianji/contracts test` 通过
  - [ ] contracts 仍然零依赖

  **QA Scenarios**:
  ```
  Scenario: runtime-types exports correctly
    Tool: Bash
    Steps:
      1. node -e "const types = require('@tianji/contracts'); console.log(typeof types.SessionRuntime)"
    Expected Result: Output is 'object' or 'function'
    Evidence: .sisyphus/evidence/task-R3-runtime-types.txt
  ```

  **Commit**: NO (groups with Wave 1)

- [ ] **R4. Update llm imports**

  **What to do**:
  - 修改 `packages/llm/src/index.ts`：
    - 从 `@tianji/contracts` 重新导出 LLM 公共类型
    - 保留包特定的错误类导出（`ConversionError`, `ToolSchemaError`）
    - 保留工厂函数导出（`createLlmGateway`, `createOpenAIGateway`, etc.）
    - 保留 `collectLlmUsage` 工具函数
  - 修改 `packages/llm/src/sdk-gateway.ts`：
    - 从 `@tianji/contracts` 导入公共类型
  - 修改 `packages/llm/src/openai-gateway.ts`, `anthropic-gateway.ts`, `google-gateway.ts`：
    - 从 `@tianji/contracts` 导入公共类型
  - 修改所有 `__tests__` 文件：
    - 从 `@tianji/contracts` 导入公共类型
  - 运行 `pnpm --filter @tianji/llm test` 确保通过

  **Must NOT do**:
  - 不删除已有的导出（只能改为 re-export）
  - 不引入循环依赖
  - 不破坏现有测试

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO（依赖 R2，且与 R5 共享 contracts 更新）
  - **Blocks**: R6
  - **Blocked By**: R2

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @tianji/llm build` 成功
  - [ ] `pnpm --filter @tianji/llm test` 通过
  - [ ] 公共类型从 `@tianji/contracts` 导入
  - [ ] 不存在从 `@tianji/llm` deep import 公共类型的情况

  **QA Scenarios**:
  ```
  Scenario: llm types re-exported from contracts
    Tool: Bash
    Steps:
      1. node -e "const llm = require('@tianji/llm'); const contracts = require('@tianji/contracts'); console.log(llm.LlmGateway === contracts.LlmGateway)"
    Expected Result: Output is 'true'
    Evidence: .sisyphus/evidence/task-R4-llm-imports.txt
  ```

  **Commit**: NO (groups with Wave 1)

- [ ] **R5. Update runtime imports**

  **What to do**:
  - 修改 `packages/runtime/src/runtime.ts`：
    - 从 `@tianji/contracts` 导入公共类型
    - 保留包内部接口（`SessionRuntimeLlmRequest`, `SessionRuntimeLlmStream`, etc.）
  - 修改 `packages/runtime/src/tool-catalog.ts`：
    - 从 `@tianji/contracts` 导入公共类型
    - 保留包内部实现类（`ToolRegistry`, `StaticToolCatalog`）
  - 修改 `packages/runtime/src/index.ts`：
    - 从 `@tianji/contracts` 重新导出 Runtime 公共类型
    - 保留包特定的类和函数导出
  - 修改所有 `__tests__` 文件：
    - 从 `@tianji/contracts` 导入公共类型
  - 运行 `pnpm --filter @tianji/runtime test` 确保通过

  **Must NOT do**:
  - 不删除已有的导出（只能改为 re-export）
  - 不引入循环依赖
  - 不破坏现有测试

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO（依赖 R3，且与 R4 共享 contracts 更新）
  - **Blocks**: R6
  - **Blocked By**: R3

  **Acceptance Criteria**:
  - [ ] `pnpm --filter @tianji/runtime build` 成功
  - [ ] `pnpm --filter @tianji/runtime test` 通过
  - [ ] 公共类型从 `@tianji/contracts` 导入
  - [ ] 不存在从 `@tianji/runtime` deep import 公共类型的情况

  **QA Scenarios**:
  ```
  Scenario: runtime types re-exported from contracts
    Tool: Bash
    Steps:
      1. node -e "const runtime = require('@tianji/runtime'); const contracts = require('@tianji/contracts'); console.log(runtime.SessionRuntime === contracts.SessionRuntime)"
    Expected Result: Output is 'true'
    Evidence: .sisyphus/evidence/task-R5-runtime-imports.txt
  ```

  **Commit**: NO (groups with Wave 1)

- [ ] **R6. Verify no circular dependencies**

  **What to do**:
  - 运行 `pnpm --filter @tianji/contracts exec tsc --noEmit`
  - 运行 `pnpm --filter @tianji/llm exec tsc --noEmit`
  - 运行 `pnpm --filter @tianji/runtime exec tsc --noEmit`
  - 运行 `pnpm check`
  - 检查是否有循环依赖警告
  - 更新或创建循环依赖检测测试（如需要）

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO（必须在 R4, R5 完成后）
  - **Blocks**: R7-R14
  - **Blocked By**: R4, R5

  **Acceptance Criteria**:
  - [ ] 所有包 typecheck 通过
  - [ ] `pnpm check` 通过
  - [ ] 无循环依赖警告

  **QA Scenarios**:
  ```
  Scenario: no circular dependencies
    Tool: Bash
    Steps:
      1. pnpm check
      2. Check output for "circular" or "cycle"
    Expected Result: No circular dependency warnings
    Evidence: .sisyphus/evidence/task-R6-no-cycles.txt
  ```

  **Commit**: YES (Wave 1 complete)
  - Message: `refactor(contracts): centralize public API types from llm and runtime`
  - Files: packages/contracts/src/*.ts, packages/llm/src/*.ts, packages/runtime/src/*.ts
  - Pre-commit: `pnpm check`

### Wave 2: Provider 验证 (4 tasks, parallel)

- [ ] **R7. Provider contract test infrastructure**

  **What to do**:
  - 创建 `packages/llm/src/__tests__/provider-contract.test.ts`
  - 定义通用的 provider contract test helper：
    - `createMockLanguageModel()` - 返回符合 `LanguageModelV1` 的 mock
    - `runProviderContractTests(provider, createGateway)` - 执行通用测试套件
  - 定义通用测试场景：
    - `getProviderInfo()` 返回正确的 provider 和 model
    - `isReady()` 在有 apiKey 时返回 true
    - `isReady()` 在无 apiKey 且无 env var 时返回 false
    - `stream()` 发出 delta 事件
    - `stream()` 发出 complete 事件
    - `stream()` 在 tool call 时正确映射
    - `stream()` 在 provider error 时包装为 `ProviderError`
    - `generate()` 返回正确的 `LlmResponse`
    - AbortSignal 传播到 SDK

  **Must NOT do**:
  - 不依赖 live API
  - 不引入新的外部依赖

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO（R8-R10 依赖此基础设施）
  - **Blocks**: R8, R9, R10
  - **Blocked By**: R6

  **Acceptance Criteria**:
  - [ ] `packages/llm/src/__tests__/provider-contract.test.ts` 存在
  - [ ] 定义了 `runProviderContractTests()` helper
  - [ ] 测试框架可以运行（即使无具体 provider）

  **QA Scenarios**:
  ```
  Scenario: provider contract test infrastructure exists
    Tool: Bash
    Steps:
      1. ls packages/llm/src/__tests__/provider-contract.test.ts
    Expected Result: File exists
    Evidence: .sisyphus/evidence/task-R7-infrastructure.txt
  ```

  **Commit**: NO (groups with Wave 2)

- [ ] **R8. OpenAI provider contract test**

  **What to do**:
  - 在 `packages/llm/src/__tests__/provider-contract.test.ts` 中添加 OpenAI 测试套件
  - 使用 mock `LanguageModelV1` 测试 `createOpenAIGateway()`
  - 覆盖所有通用测试场景（R7 中定义）
  - 覆盖 OpenAI 特定场景：
    - 配置 passthrough（apiKey, baseUrl, headers）
    - 使用 `createOpenAI()` vs 默认 `openai`

  **Must NOT do**:
  - 不使用真实 API key
  - 不依赖网络

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with R9, R10)
  - **Parallel Group**: Wave 2
  - **Blocked By**: R7

  **Acceptance Criteria**:
  - [ ] OpenAI contract test 存在
  - [ ] `pnpm --filter @tianji/llm test -- --grep "OpenAI"` 通过
  - [ ] 所有通用测试场景通过

  **QA Scenarios**:
  ```
  Scenario: openai provider contract tests pass
    Tool: Bash
    Steps:
      1. cd packages/llm && pnpm test -- --grep "OpenAI"
    Expected Result: All tests pass
    Evidence: .sisyphus/evidence/task-R8-openai.txt
  ```

  **Commit**: NO (groups with Wave 2)

- [ ] **R9. Anthropic provider contract test**

  **What to do**:
  - 在 `packages/llm/src/__tests__/provider-contract.test.ts` 中添加 Anthropic 测试套件
  - 使用 mock `LanguageModelV1` 测试 `createAnthropicGateway()`
  - 覆盖所有通用测试场景
  - 覆盖 Anthropic 特定场景：
    - 配置 passthrough（apiKey, baseUrl, headers）
    - 使用 `createAnthropic()` vs 默认 `anthropic`

  **Must NOT do**:
  - 不使用真实 API key
  - 不依赖网络

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with R8, R10)
  - **Parallel Group**: Wave 2
  - **Blocked By**: R7

  **Acceptance Criteria**:
  - [ ] Anthropic contract test 存在
  - [ ] `pnpm --filter @tianji/llm test -- --grep "Anthropic"` 通过
  - [ ] 所有通用测试场景通过

  **QA Scenarios**:
  ```
  Scenario: anthropic provider contract tests pass
    Tool: Bash
    Steps:
      1. cd packages/llm && pnpm test -- --grep "Anthropic"
    Expected Result: All tests pass
    Evidence: .sisyphus/evidence/task-R9-anthropic.txt
  ```

  **Commit**: NO (groups with Wave 2)

- [ ] **R10. Google provider contract test**

  **What to do**:
  - 在 `packages/llm/src/__tests__/provider-contract.test.ts` 中添加 Google 测试套件
  - 使用 mock `LanguageModelV1` 测试 `createGoogleGateway()`
  - 覆盖所有通用测试场景
  - 覆盖 Google 特定场景：
    - 配置 passthrough（apiKey, baseUrl, headers）
    - 使用 `createGoogleGenerativeAI()` vs 默认 `google`

  **Must NOT do**:
  - 不使用真实 API key
  - 不依赖网络

  **Recommended Agent Profile**:
  - **Category**: `unspecified-high`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with R8, R9)
  - **Parallel Group**: Wave 2
  - **Blocked By**: R7

  **Acceptance Criteria**:
  - [ ] Google contract test 存在
  - [ ] `pnpm --filter @tianji/llm test -- --grep "Google"` 通过
  - [ ] 所有通用测试场景通过

  **QA Scenarios**:
  ```
  Scenario: google provider contract tests pass
    Tool: Bash
    Steps:
      1. cd packages/llm && pnpm test -- --grep "Google"
    Expected Result: All tests pass
    Evidence: .sisyphus/evidence/task-R10-google.txt
  ```

  **Commit**: YES (Wave 2 complete)
  - Message: `test(llm): add provider contract tests for OpenAI, Anthropic, and Google`
  - Files: packages/llm/src/__tests__/provider-contract.test.ts
  - Pre-commit: `pnpm --filter @tianji/llm test`

### Wave 3: Runtime 验证 (4 tasks, parallel)

- [ ] **R11. Lifecycle test infrastructure**

  **What to do**:
  - 创建 `packages/runtime/src/__tests__/lifecycle.test.ts`
  - 创建 `packages/runtime/src/__tests__/cancellation.test.ts`
  - 定义通用的 test helper：
    - `createMockLlmGateway()` - 返回 mock `LlmGateway`
    - `createTestRuntime()` - 创建测试用 runtime 实例
    - `collectEvents(runtime, runId)` - 收集所有事件

  **Must NOT do**:
  - 不依赖真实 LLM provider
  - 不引入新的外部依赖

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: NO（R12-R14 依赖此基础设施）
  - **Blocks**: R12, R13, R14
  - **Blocked By**: R6

  **Acceptance Criteria**:
  - [ ] `packages/runtime/src/__tests__/lifecycle.test.ts` 存在
  - [ ] `packages/runtime/src/__tests__/cancellation.test.ts` 存在
  - [ ] 定义了 helper 函数

  **QA Scenarios**:
  ```
  Scenario: lifecycle test infrastructure exists
    Tool: Bash
    Steps:
      1. ls packages/runtime/src/__tests__/lifecycle.test.ts
      2. ls packages/runtime/src/__tests__/cancellation.test.ts
    Expected Result: Both files exist
    Evidence: .sisyphus/evidence/task-R11-infrastructure.txt
  ```

  **Commit**: NO (groups with Wave 3)

- [ ] **R12. resumeRun behavior test**

  **What to do**:
  - 在 `packages/runtime/src/__tests__/lifecycle.test.ts` 中添加 `resumeRun` 测试
  - 测试场景：
    - `resumeRun` 从 cancelled run 创建新 run
    - `metadata.resumedFromRunId` 设置正确
    - 保留 prior messages
    - 保留 prior systemPrompt（如未 override）
    - 保留 prior config（如未 override）
    - 允许 override systemPrompt
    - 允许 override config
    - 对非 cancelled run 调用 `resumeRun` 抛出 `RUN_NOT_CANCELLABLE` 错误
  - 同时验证：
    - 持久化状态（RunSnapshot）
    - 发出的事件（run.started, etc.）

  **Must NOT do**:
  - 不修改 runtime 实现代码（除非测试证明有 bug）
  - 不引入新的外部依赖

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with R13, R14)
  - **Parallel Group**: Wave 3
  - **Blocked By**: R11

  **Acceptance Criteria**:
  - [ ] `resumeRun` 测试存在
  - [ ] `pnpm --filter @tianji/runtime test -- --grep "resumeRun"` 通过
  - [ ] 覆盖所有测试场景

  **QA Scenarios**:
  ```
  Scenario: resumeRun tests pass
    Tool: Bash
    Steps:
      1. cd packages/runtime && pnpm test -- --grep "resumeRun"
    Expected Result: All tests pass
    Evidence: .sisyphus/evidence/task-R12-resume.txt
  ```

  **Commit**: NO (groups with Wave 3)

- [ ] **R13. closeSession behavior test**

  **What to do**:
  - 在 `packages/runtime/src/__tests__/lifecycle.test.ts` 中添加 `closeSession` 测试
  - 测试场景：
    - `closeSession` 设置 `metadata.closedAt`
    - `closeSession` abort 活跃的 run
    - `closeSession` 后调用 `runTurn` 抛出 session closed 错误
    - `closeSession` 后调用 `resumeRun` 抛出 session closed 错误
    - `closeSession` 后可以 `streamEvents` 读取历史事件
  - 同时验证：
    - 持久化状态（SessionSnapshot）
    - 发出的事件（run.cancelled, etc.）

  **Must NOT do**:
  - 不修改 runtime 实现代码（除非测试证明有 bug）
  - 不引入新的外部依赖

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with R12, R14)
  - **Parallel Group**: Wave 3
  - **Blocked By**: R11

  **Acceptance Criteria**:
  - [ ] `closeSession` 测试存在
  - [ ] `pnpm --filter @tianji/runtime test -- --grep "closeSession"` 通过
  - [ ] 覆盖所有测试场景

  **QA Scenarios**:
  ```
  Scenario: closeSession tests pass
    Tool: Bash
    Steps:
      1. cd packages/runtime && pnpm test -- --grep "closeSession"
    Expected Result: All tests pass
    Evidence: .sisyphus/evidence/task-R13-close.txt
  ```

  **Commit**: NO (groups with Wave 3)

- [ ] **R14. cancelRun & AbortSignal test**

  **What to do**:
  - 在 `packages/runtime/src/__tests__/cancellation.test.ts` 中添加取消测试
  - 测试场景：
    - `cancelRun(runId)` 对 active run 返回 true
    - `cancelRun(runId)` 对 missing/inactive run 返回 false
    - `cancelRun` 发出 `run.cancelled` 事件
    - `cancelRun` 持久化 `status: "cancelled"`
    - `cancelRun` 设置 `cancelPoint`（assistant_turn, tool_execution）
    - `cancelRun` 设置 `resumeHint`（replay, require-user-confirmation）
    - 外部 `AbortSignal` 取消产生相同的持久化/结果语义
    - 取消发生在 first delta 之前
    - 取消发生在 streaming delta 期间
    - 取消发生在 tool execution 期间
    - 取消发生在 final LLM response 之后但 snapshot 持久化之前
    - `cancelRun` 调用两次是幂等的
    - `streamEvents(runId)` 在取消后能重放 terminal events
  - 同时验证：
    - 持久化状态（RunSnapshot）
    - 发出的事件（run.cancelled）
    - pending operations 状态（running, completed, aborted-clean, aborted-with-side-effect）

  **Must NOT do**:
  - 不修改 runtime 实现代码（除非测试证明有 bug）
  - 不引入新的外部依赖

  **Recommended Agent Profile**:
  - **Category**: `deep`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with R12, R13)
  - **Parallel Group**: Wave 3
  - **Blocked By**: R11

  **Acceptance Criteria**:
  - [ ] 取消测试存在
  - [ ] `pnpm --filter @tianji/runtime test -- --grep "cancel"` 通过
  - [ ] 覆盖所有测试场景

  **QA Scenarios**:
  ```
  Scenario: cancellation tests pass
    Tool: Bash
    Steps:
      1. cd packages/runtime && pnpm test -- --grep "cancel"
    Expected Result: All tests pass
    Evidence: .sisyphus/evidence/task-R14-cancel.txt
  ```

  **Commit**: YES (Wave 3 complete)
  - Message: `test(runtime): add lifecycle and cancellation behavior tests`
  - Files: packages/runtime/src/__tests__/lifecycle.test.ts, packages/runtime/src/__tests__/cancellation.test.ts
  - Pre-commit: `pnpm --filter @tianji/runtime test`

### Wave 4: Final Verification + Evidence (5 tasks, parallel)

- [ ] **R15. Re-run all tests**

  **What to do**:
  - 运行 `pnpm check`
  - 运行 `pnpm --filter @tianji/contracts test`
  - 运行 `pnpm --filter @tianji/llm test`
  - 运行 `pnpm --filter @tianji/runtime test`
  - 运行 `pnpm --filter @tianji/shared test`
  - 确保所有测试通过

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with R16-R18)
  - **Parallel Group**: Wave 4
  - **Blocked By**: R8-R10, R12-R14

  **Acceptance Criteria**:
  - [ ] `pnpm check` 通过
  - [ ] 所有包测试通过

  **QA Scenarios**:
  ```
  Scenario: all tests pass
    Tool: Bash
    Steps:
      1. pnpm check
    Expected Result: No errors
    Evidence: .sisyphus/evidence/task-R15-all-tests.txt
  ```

  **Commit**: NO (groups with Wave 4)

- [ ] **R16. Generate evidence task-22~37**

  **What to do**:
  - 为 task-22 创建 `.sisyphus/evidence/task-22-openai-adapter.txt`
  - 为 task-23 创建 `.sisyphus/evidence/task-23-anthropic-adapter.txt`
  - 为 task-24 创建 `.sisyphus/evidence/task-24-google-adapter.txt`
  - 为 task-25 创建 `.sisyphus/evidence/task-25-tool-bridge.txt`
  - 为 task-26 创建 `.sisyphus/evidence/task-26-usage.txt`
  - 为 task-28 创建 `.sisyphus/evidence/task-28-lifecycle.txt`
  - 为 task-33 创建 `.sisyphus/evidence/task-33-cancel.txt`
  - 为 task-34~37 创建对应 evidence 文件
  - 每个 evidence 文件包含：
    - 验证命令
    - 命令输出
    - 结论（PASS/FAIL）

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with R15, R17, R18)
  - **Parallel Group**: Wave 4
  - **Blocked By**: R8-R10, R12-R14

  **Acceptance Criteria**:
  - [ ] `.sisyphus/evidence/task-22-*.txt` ~ `task-37-*.txt` 存在
  - [ ] 每个 evidence 文件包含可执行的验证命令和输出

  **QA Scenarios**:
  ```
  Scenario: evidence files exist
    Tool: Bash
    Steps:
      1. ls .sisyphus/evidence/task-2*.txt | wc -l
    Expected Result: Output >= 7
    Evidence: .sisyphus/evidence/task-R16-evidence.txt
  ```

  **Commit**: NO (groups with Wave 4)

- [ ] **R17. Final verification F1~F4**

  **What to do**:
  - 创建 `.sisyphus/evidence/F1-plan-audit.txt`：
    - 运行 `cat .sisyphus/plans/tianji-ai-foundation.md | grep -E "^\- \[x\]" | wc -l`
    - 确认 Must Have 项全部完成
    - 确认 Must NOT Have 项全部满足
  - 创建 `.sisyphus/evidence/F2-code-quality.txt`：
    - 运行 `pnpm check`
    - 确认无 `as any`, `@ts-ignore`, empty catch
  - 创建 `.sisyphus/evidence/F3-dependency-constraints.txt`：
    - 运行 `node -e "const pkg = require('./packages/contracts/package.json'); console.log(Object.keys(pkg.dependencies || {}).length)"`
    - 确认输出为 0
    - 运行 `node -e "const pkg = require('./packages/llm/package.json'); console.log(Object.keys(pkg.dependencies || {}).filter(d => d.startsWith('@langchain/')).length)"`
    - 确认输出为 0
- 创建 `.sisyphus/evidence/F4-e2e-integration.txt`：
  - 运行 provider contract tests for所有 3 providers
    ```bash
    # Wave 4: provider contract tests
    pnpm --filter @tianji/llm test -- --grep "OpenAI\|Anthropic\|Google"
    
    # Verify coverage results
    - Provider: OpenAI
      - Test file: packages/llm/src/__tests__/provider-contract.test.ts
      - Scenarios: getProviderInfo, isReady, config passthrough,        stream delta propagation, tool calling, error wrapping
      - Expected: All scenarios pass
    - Provider: Anthropic
      - Test file: packages/llm/src/__tests__/provider-contract.test.ts
      - Scenarios: getProviderInfo, isReady, config passthrough
        stream delta propagation, tool calling, error wrapping
      - Expected: All scenarios pass
    - Provider: Google
      - Test file: packages/llm/src/__tests__/provider-contract.test.ts
      - Scenarios: getProviderInfo, isReady, config passthrough
        stream delta propagation, tool calling, error wrapping
      - Expected: All scenarios pass
    
    # Wave 4: lifecycle tests
    pnpm --filter @tianji/runtime test -- --grep "lifecycle"
    
    # Verify results
    - resumeRun: metadata.resumedFromRunId set correctly
    - closeSession: metadata.closedAt set, active runs aborted
    - cancel propagation: cancelRun() returns true/false, and external AbortSignal produces same persisted outcome
    
    Expected Result: All lifecycle tests pass
    
    # Evidence files
    for task_id in [22, 23, 24, 25, 26, 28, 33, 34, 35, 36, 37]:
      create .sisyphus/evidence/task-${task_id}-*.txt
      Evidence: .sisyphus/evidence/task-R17-final.txt
    ```
  Scenario: final verification evidence exists
    Tool: Bash
    Steps:
      1. ls .sisyphus/evidence/F*.txt | wc -l
    Expected Result: Output >= 4
    Evidence: .sisyphus/evidence/task-R17-final.txt
  ```

  **Commit**: NO (groups with Wave 4)

- [ ] **R18. Update foundation plan checkboxes**

  **What to do**:
  - 更新 `.sisyphus/plans/tianji-ai-foundation.md`：
    - 将 Task 15 标记为 `[x]`
    - 将 Task 22, 23, 24 标记为 `[x]`
    - 将 Task 26 标记为 `[x]`
    - 将 Task 28 标记为 `[x]`
    - 将 Task 33 标记为 `[x]`
    - 将 F1, F2, F3, F4 标记为 `[x]`
  - 在 Final Verification Wave 部分添加整改说明

  **Recommended Agent Profile**:
  - **Category**: `quick`
  - **Skills**: []

  **Parallelization**:
  - **Can Run In Parallel**: YES (with R15, R16, R17)
  - **Parallel Group**: Wave 4
  - **Blocked By**: R8-R10, R12-R14

  **Acceptance Criteria**:
  - [ ] Foundation plan checkboxes 已更新
  - [ ] Task 15, 22-24, 26, 28, 33, F1-F4 标记为 `[x]`

  **QA Scenarios**:
  ```
  Scenario: foundation plan updated
    Tool: Bash
    Steps:
      1. grep -E "^\- \[x\] (15|22|23|24|26|28|33|F1|F2|F3|F4)" .sisyphus/plans/tianji-ai-foundation.md | wc -l
    Expected Result: Output >= 10
    Evidence: .sisyphus/evidence/task-R18-checkboxes.txt
  ```

  **Commit**: NO (groups with Wave 4)

- [ ] **R19. Oracle re-audit**

  **What to do**:
  - 运行 Oracle agent 对整改后的仓库进行重新审计
  - 生成最终审计报告
  - 确认 verdict 为 APPROVE

  **Recommended Agent Profile**:
  - **Category**: N/A
  - **Subagent**: `oracle`

  **Parallelization**:
  - **Can Run In Parallel**: NO（必须在 R15-R18 完成后）
  - **Blocked By**: R15, R16, R17, R18

  **Acceptance Criteria**:
  - [ ] Oracle re-audit verdict: APPROVE
  - [ ] 生成最终审计报告

  **QA Scenarios**:
  ```
  Scenario: oracle re-audit passes
    Tool: Agent
    Steps:
      1. Run oracle agent
      2. Check verdict
    Expected Result: APPROVE
    Evidence: .sisyphus/evidence/task-R19-oracle.txt
  ```

  **Commit**: YES (Wave 4 complete)
  - Message: `docs(plan): complete foundation audit remediation and evidence`
  - Files: .sisyphus/plans/tianji-ai-foundation.md, .sisyphus/evidence/*
  - Pre-commit: `pnpm check`

---

## Final Verification Wave (MANDATORY — after ALL remediation tasks)

- [ ] **Final Audit Checklist**
  
  **Must Have Verification**:
  - [ ] 公共类型仅从 `@tianji/contracts` 导出
  - [ ] `contracts` 零依赖
  - [ ] `ToolCatalog` 是工具定义的唯一真相来源
  - [ ] 所有公共类型在 `contracts` 中定义
  
  **Must NOT Have Verification**:
  - [ ] 未复制 pi-mono 代码
  - [ ] 未实现 fallback provider 策略
  - [ ] 未实现熔断器
  - [ ] 未实现 user/workspace 层配置
  - [ ] 未在 runtime 之外定义 agent loop
  - [ ] 未允许 apps/* 直接依赖 @langchain/* 或 ai 包
  
  **Definition of Done**:
  - [ ] `pnpm check` 通过
  - [ ] `pnpm --filter @tianji/contracts test` 通过
  - [ ] `pnpm --filter @tianji/llm test` 通过
  - [ ] `pnpm --filter @tianji/runtime test` 通过
  - [ ] contracts 零依赖验证
  - [ ] 端到端测试通过（3 providers）
  - [ ] Evidence 完整（task-22~37, F1~F4）

---

## Commit Strategy

采用 atomic commits，每个完成的 wave 作为一组提交：

- **Wave 1**: `refactor(contracts): centralize public API types from llm and runtime`
- **Wave 2**: `test(llm): add provider contract tests for OpenAI, Anthropic, and Google`
- **Wave 3**: `test(runtime): add lifecycle and cancellation behavior tests`
- **Wave 4**: `docs(plan): complete foundation audit remediation and evidence`

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

# 5. Evidence completeness
ls .sisyphus/evidence/task-2*.txt | wc -l
# Expected: >= 7

ls .sisyphus/evidence/F*.txt | wc -l
# Expected: >= 4
```

### Final Checklist
- [ ] All "Must Have" present
- [ ] All "Must NOT Have" absent
- [ ] All tests pass
- [ ] contracts 零依赖
- [ ] 公共类型集中在 contracts
- [ ] Provider contract tests 覆盖 3 providers
- [ ] Runtime lifecycle tests 覆盖 resume/cancel
- [ ] Evidence 完整（task-22~37, F1~F4）
- [ ] Oracle re-audit verdict: APPROVE
