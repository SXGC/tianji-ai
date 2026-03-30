# Tianji AI Architecture V2 Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `ARCHITECTURE_V2.md` 定义的 5 层 V1 架构稳定迁移到 4 层 V2 架构，完成 `contracts -> shared`、`llm -> runtime`、新增 `agent`、CLI 瘦身，以及配套测试和文档同步。

**Architecture:** 迁移按依赖方向自底向上推进，先收敛基础协议层，再内聚 runtime 内部 LLM 模块，随后抽取 agent 编排层，最后统一清理引用和文档。每个阶段都要求同步更新边界测试、README 和依赖声明，避免出现“代码已迁移但契约文档与导出面仍停留在旧结构”的中间态。

**Tech Stack:** TypeScript strict mode, pnpm workspace, Turborepo, Biome, Vitest, Zod, deepagents

---

## File Map

### New Files

- `packages/shared/src/identifiers.ts`: 原 `contracts` 标识符类型定义
- `packages/shared/src/errors.ts`: 原 `contracts` 错误协议
- `packages/shared/src/events.ts`: 原 `contracts` 事件协议
- `packages/shared/src/message.ts`: 原 `contracts` 消息协议
- `packages/shared/src/tool.ts`: 原 `contracts` 工具协议
- `packages/shared/src/policy.ts`: 原 `contracts` 策略协议
- `packages/shared/src/delta.ts`: 原 `contracts` delta 协议
- `packages/shared/src/delta-aggregator.ts`: 原 `contracts` delta 聚合器
- `packages/shared/src/artifact.ts`: 原 `contracts` artifact 协议
- `packages/shared/src/snapshot.ts`: 原 `contracts` snapshot 协议
- `packages/runtime/src/llm/index.ts`: runtime 内部 LLM barrel
- `packages/runtime/src/llm/factory.ts`: provider 工厂
- `packages/runtime/src/llm/sdk-gateway.ts`: SDK gateway 封装
- `packages/runtime/src/llm/openai-gateway.ts`: OpenAI 适配
- `packages/runtime/src/llm/anthropic-gateway.ts`: Anthropic 适配
- `packages/runtime/src/llm/google-gateway.ts`: Google 适配
- `packages/runtime/src/llm/message-conversion.ts`: 消息转换
- `packages/runtime/src/llm/tool-schema-bridge.ts`: tool schema 桥接
- `packages/runtime/src/llm/usage.ts`: usage 收集
- `packages/agent/package.json`: 新 agent 包定义
- `packages/agent/tsconfig.json`: agent 包 ts 配置
- `packages/agent/src/index.ts`: agent 公共导出
- `packages/agent/src/context.ts`: 配置装配与首次初始化
- `packages/agent/src/session.ts`: runtime 启动原语与 chat API
- `packages/agent/src/__tests__/context.test.ts`: agent context 测试
- `packages/agent/src/__tests__/session.test.ts`: agent session 测试

### Modified Files

- `packages/shared/src/index.ts`: 合并 shared 与 contracts 的公共导出
- `packages/shared/src/config.ts`: 修正重导出与类型来源
- `packages/runtime/src/index.ts`: 收紧公共 API，不再导出 LLM 内部类型
- `packages/runtime/src/config.ts`: 调整 shared 类型引用
- `packages/runtime/src/runtime.ts`: 调整内部 LLM import 与生成配置归属
- `packages/runtime/src/engines/deepagents-engine.ts`: 更新 shared/runtime 类型 import
- `packages/runtime/src/event-stream.ts`: 更新 shared import
- `packages/runtime/src/snapshot-store.ts`: 更新 shared import
- `packages/runtime/src/tool-catalog.ts`: 更新 shared import
- `packages/runtime/src/__tests__/index.test.ts`: 修正边界断言
- `packages/runtime/package.json`: 内联 llm 外部依赖，移除 `@tianji/llm`
- `packages/runtime/README.md`: 更新包职责与 API 边界
- `apps/cli/src/config.ts`: 删除或瘦身原配置装配逻辑
- `apps/cli/src/main.ts`: 改为调用 `@tianji/agent`
- `apps/cli/src/__tests__/config.test.ts`: 迁移或改写为 agent 断言
- `apps/cli/src/__tests__/inject-provider-env.test.ts`: 迁移或改写为 agent 断言
- `apps/cli/src/__tests__/run-e2e.test.ts`: 迁移运行入口断言
- `apps/cli/package.json`: 添加 `@tianji/agent`，移除 `@tianji/runtime` 直接依赖
- `apps/cli/README.md`: 更新启动链路与依赖说明
- `README.md`: 更新总体包结构
- `turbo.json`: 如有包过滤或管线引用需同步更新
- `biome.json`: 如有路径/规则引用需同步更新
- 各包 `package.json`: 调整 `exports`、依赖与 workspace 引用

### Deleted Files Or Directories

- `packages/contracts/package.json`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/*.ts`
- `packages/contracts/src/__tests__/*`
- `packages/contracts/`
- `packages/llm/package.json`
- `packages/llm/src/index.ts`
- `packages/llm/src/*.ts`
- `packages/llm/`

---

## Implementation Notes

- 迁移顺序必须遵守依赖方向：`shared` -> `runtime` -> `agent` -> `cli`。
- 任何涉及代码改动的任务结束前都必须执行 `pnpm check`，并修复全部 errors、warnings、infos。
- 不运行 `pnpm dev`、`pnpm build`、`pnpm test`，除非用户后续明确要求测试。
- 现有文档要求 README 同步更新，因此每个 phase 都包含文档步骤，不能拖到最后统一处理。
- 本计划默认最小化行为变化，不新增多 agent 实现，不改变配置系统语义。
- `contracts -> shared` 合并后，必须刷新 `packages/shared/dist`（例如运行 `pnpm --filter @tianji/shared build`），否则下游包会继续通过旧的 `dist/index.d.ts` 解析 `@tianji/shared`，导致类型面与源码导出不一致。

---

### Task 1: Baseline Inventory And Boundary Confirmation

**Files:**
- Modify: `docs/plans/architecture-v2-migration-plan.md`
- Inspect: `packages/contracts/**`
- Inspect: `packages/shared/**`
- Inspect: `packages/llm/**`
- Inspect: `packages/runtime/**`
- Inspect: `apps/cli/**`

- [x] **Step 1: 盘点当前 V1 包与测试入口**

Run: `pnpm --filter @tianji/shared exec pwd && pnpm --filter @tianji/runtime exec pwd && pnpm --filter @tianji/cli exec pwd`
Expected: 输出三个现有包路径，确认 workspace 结构正常。

- [x] **Step 2: 记录旧引用分布，避免迁移遗漏**

Run: `rg "@tianji/contracts|@tianji/llm|createCliRuntime|injectProviderEnv" /workspaces/dev_docker/tianji-ai`
Expected: 列出全部旧引用位置，作为后续 phase 的核对基线。

- [x] **Step 3: 确认现有 README 和边界测试位置**

Run: `rg "README.md|index.test.ts|run-e2e.test.ts|config.test.ts|inject-provider-env.test.ts" /workspaces/dev_docker/tianji-ai/packages /workspaces/dev_docker/tianji-ai/apps/cli`
Expected: 能看到 runtime、cli、可能的 contracts 测试和 README 位置。

- [x] **Step 4: 执行当前基线检查**

Run: `pnpm check`
Expected: 记录当前输出，后续迁移不得引入新增问题；若已存在问题，需要在迁移中一并消除。

- [ ] **Step 5: Commit**

```bash
git add docs/plans/architecture-v2-migration-plan.md
git commit -m "docs: add architecture v2 migration plan"
```

### Task 2: Merge Contracts Into Shared Source Tree

**Files:**
- Create: `packages/shared/src/identifiers.ts`
- Create: `packages/shared/src/errors.ts`
- Create: `packages/shared/src/events.ts`
- Create: `packages/shared/src/message.ts`
- Create: `packages/shared/src/tool.ts`
- Create: `packages/shared/src/policy.ts`
- Create: `packages/shared/src/delta.ts`
- Create: `packages/shared/src/delta-aggregator.ts`
- Create: `packages/shared/src/artifact.ts`
- Create: `packages/shared/src/snapshot.ts`
- Modify: `packages/shared/src/index.ts`
- Modify: `packages/shared/src/config.ts`

- [ ] **Step 1: 复制 contracts 源文件到 shared，保持文件名不变**

Code to preserve in `packages/shared/src/index.ts` after merge:

```ts
export * from "./artifact.js";
export * from "./delta-aggregator.js";
export * from "./delta.js";
export * from "./errors.js";
export * from "./events.js";
export * from "./identifiers.js";
export * from "./message.js";
export * from "./policy.js";
export * from "./snapshot.js";
export * from "./tool.js";
```

- [ ] **Step 2: 保持 shared 原有导出不回退**

Code to preserve in `packages/shared/src/index.ts` alongside moved contracts exports:

```ts
export * from "./config.js";
export * from "./utils.js";
```

- [ ] **Step 3: 若 `config.ts` 依赖旧 contracts import，改为同包相对路径或本包导出**

Target pattern:

```ts
import type { AppMessage, RuntimeEvent } from "./message.js";
```

Expected: `packages/shared` 内部不再出现 `@tianji/contracts` import。

- [x] **Step 4: 迁移 contracts 测试到 shared 测试目录**

Test target examples:

```ts
import { applyMessageDelta, isComplete } from "../delta-aggregator.js";
import { type RuntimeEvent } from "../events.js";
```

Expected: 原 contracts 行为由 shared 测试直接覆盖。

- [x] **Step 4.5: 刷新 shared 包声明输出，避免下游解析旧类型面**

Run: `pnpm --filter @tianji/shared build`
Expected: `packages/shared/dist/index.d.ts` 包含新增 contracts 导出，`@tianji/shared` 下游消费者不再解析到旧声明面。

- [x] **Step 5: 执行静态检查验证 shared 合并结果**

Run: `pnpm check`
Expected: 不再出现 `@tianji/contracts` 缺失或 shared 导出重复错误。

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "refactor: merge contracts sources into shared"
```

### Task 3: Replace Contracts Imports Across Workspace

**Files:**
- Modify: `packages/runtime/src/**/*.ts`
- Modify: `apps/cli/src/**/*.ts`
- Modify: `packages/*/package.json`
- Modify: `README.md`
- Modify: package READMEs affected by contracts references

- [x] **Step 1: 全局替换 import 路径**

Target replacement:

```ts
import { RuntimeEvent, SessionId } from "@tianji/shared";
```

Expected: 不再存在 `from "@tianji/contracts"` 或 `from '@tianji/contracts'`。

- [x] **Step 2: 清理依赖声明**

Package JSON target shape:

```json
{
  "dependencies": {
    "@tianji/shared": "workspace:*"
  }
}
```

Expected: runtime、cli、其他消费者不再声明 `@tianji/contracts`。

- [x] **Step 3: 更新 README 中的架构与 import 示例**

Required wording pattern:

```md
- 基础协议与配置 schema 统一由 `@tianji/shared` 提供。
```

- [x] **Step 4: 删除 contracts 包目录**

Run: `rg "@tianji/contracts" /workspaces/dev_docker/tianji-ai`
Expected: 无结果后再删除 `packages/contracts/`。

- [x] **Step 5: 执行静态检查确认 contracts 已完全出清**

Run: `pnpm check`
Expected: 无残留 import、导出或 package 解析错误。

- [ ] **Step 6: Commit**

```bash
git add README.md packages apps
git commit -m "refactor: replace contracts package with shared imports"
```

### Task 4: Move LLM Package Under Runtime Internal Modules

**Files:**
- Create: `packages/runtime/src/llm/index.ts`
- Create: `packages/runtime/src/llm/factory.ts`
- Create: `packages/runtime/src/llm/sdk-gateway.ts`
- Create: `packages/runtime/src/llm/openai-gateway.ts`
- Create: `packages/runtime/src/llm/anthropic-gateway.ts`
- Create: `packages/runtime/src/llm/google-gateway.ts`
- Create: `packages/runtime/src/llm/message-conversion.ts`
- Create: `packages/runtime/src/llm/tool-schema-bridge.ts`
- Create: `packages/runtime/src/llm/usage.ts`
- Modify: `packages/runtime/src/runtime.ts`
- Modify: `packages/runtime/src/index.ts`

- [x] **Step 1: 迁移 llm 源文件到 runtime/src/llm 目录**

Internal barrel shape:

```ts
export * from "./factory.js";
export * from "./message-conversion.js";
export * from "./sdk-gateway.js";
export * from "./tool-schema-bridge.js";
export * from "./usage.js";
```

Note: 该 barrel 只供 runtime 内部使用，不从 `packages/runtime/src/index.ts` 再导出。

- [x] **Step 2: 调整迁移文件中的 shared import**

Target pattern:

```ts
import type { AppMessage, ToolSpec } from "@tianji/shared";
```

Expected: runtime 内部 llm 模块不再引用旧 contracts 包。

- [x] **Step 3: 将 runtime 内部 `@tianji/llm` 引用改成相对路径**

Target pattern in runtime internals:

```ts
import { createLlmGateway } from "./llm/index.js";
```

- [x] **Step 4: 从 runtime 公共入口移除 LLM 内部导出**

Public `packages/runtime/src/index.ts` should keep only stable APIs like:

```ts
export { loadResolvedConfig, resolveConfigPaths } from "./config.js";
export { ReplayableEventStream } from "./event-stream.js";
export {
  createSessionRuntime,
  type SessionRuntime,
} from "./runtime.js";
export {
  FileSnapshotStore,
  InMemorySnapshotStore,
  type SnapshotStore,
} from "./snapshot-store.js";
```

- [x] **Step 5: 执行静态检查验证 runtime 内聚生效**

Run: `pnpm check`
Expected: runtime 内部模块解析正常，外部 API 无 `@tianji/llm` 泄漏。

- [ ] **Step 6: Commit**

```bash
git add packages/runtime
git commit -m "refactor: inline llm package into runtime"
```

### Task 5: Absorb LLM Dependencies And Type Ownership Into Runtime

**Files:**
- Modify: `packages/runtime/package.json`
- Modify: `packages/runtime/src/runtime.ts`
- Modify: `packages/runtime/src/config.ts`
- Modify: `packages/runtime/src/__tests__/index.test.ts`
- Modify: `packages/runtime/README.md`

- [x] **Step 1: 将 `@tianji/llm` 的外部依赖并入 runtime package.json**

Target dependency shape:

```json
{
  "dependencies": {
    "@ai-sdk/anthropic": "...",
    "@ai-sdk/google": "...",
    "@ai-sdk/openai": "...",
    "ai": "...",
    "@tianji/shared": "workspace:*"
  }
}
```

- [x] **Step 2: 移除 runtime 对 `@tianji/llm` 的依赖声明**

Expected: `packages/runtime/package.json` 不再出现 `@tianji/llm`。

- [x] **Step 3: 明确 `LlmGenerationConfig` 归属**

If runtime public type is required, prefer a local public type like:

```ts
export interface RunTurnGenerationConfig {
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxOutputTokens?: number;
}
```

Expected: runtime 公共类型不再依赖已删除包名。

- [x] **Step 4: 更新 runtime API 边界测试与 README**

Assertion examples:

```ts
expect(runtimeExports).not.toContain("createLlmGateway");
expect(runtimeExports).toContain("createSessionRuntime");
```

README wording example:

```md
`@tianji/runtime` 负责配置加载、会话执行与内部 LLM 适配，不对外公开 provider gateway 接口。
```

- [x] **Step 5: 删除 llm 包目录并验证无残留引用**

Run: `rg "@tianji/llm" /workspaces/dev_docker/tianji-ai`
Expected: 无结果后删除 `packages/llm/`。

- [x] **Step 6: 执行静态检查**

Run: `pnpm check`
Expected: runtime 类型归属一致，README 相关断言与 package 依赖检查通过。

- [ ] **Step 7: Commit**

```bash
git add packages/runtime
git commit -m "refactor: internalize llm dependencies in runtime"
```

### Task 6: Create Agent Package Skeleton And Public API

**Files:**
- Create: `packages/agent/package.json`
- Create: `packages/agent/tsconfig.json`
- Create: `packages/agent/src/index.ts`
- Create: `packages/agent/src/context.ts`
- Create: `packages/agent/src/session.ts`

- [x] **Step 1: 创建 agent 包基础清单与 workspace 元数据**

`packages/agent/package.json` target shape:

```json
{
  "name": "@tianji/agent",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "dependencies": {
    "@tianji/runtime": "workspace:*",
    "@tianji/shared": "workspace:*"
  }
}
```

- [x] **Step 2: 定义 agent 公共接口并集中导出**

`packages/agent/src/index.ts` target shape:

```ts
export {
  ensureDefaultUserConfig,
  injectProviderEnv,
  loadAgentContext,
  type AgentAppPaths,
  type AgentContext,
  type LoadedAgentContext,
} from "./context.js";
export {
  createAgentRuntime,
  createAgentSession,
  type AgentSession,
} from "./session.js";
```

- [x] **Step 3: 在 `context.ts` 中落地文档建议的核心类型**

Required shape:

```ts
export interface AgentContext {
  readonly agentName: string;
  readonly modelRef: string;
  readonly provider: string;
  readonly modelName: string;
  readonly providerConfig: TianjiProviderConfig | undefined;
  readonly soulPath: string;
  readonly soul: string;
}
```

- [x] **Step 4: 在 `session.ts` 中定义启动原语和 chat 包装**

Required shape:

```ts
export interface AgentSession {
  readonly sessionId: SessionId;
  readonly chat: (
    prompt: string,
    options?: ChatOptions,
  ) => AsyncIterable<RuntimeEvent>;
}
```

- [x] **Step 5: 执行静态检查验证新包接入 workspace**

Run: `pnpm check`
Expected: workspace 能解析 `@tianji/agent`，无 tsconfig/exports 错误。

- [ ] **Step 6: Commit**

```bash
git add packages/agent
git commit -m "feat: add agent orchestration package skeleton"
```

### Task 7: Extract CLI Configuration Assembly Into Agent Context

**Files:**
- Modify: `apps/cli/src/config.ts`
- Modify: `packages/agent/src/context.ts`
- Create: `packages/agent/src/__tests__/context.test.ts`
- Modify: `apps/cli/src/__tests__/config.test.ts`
- Modify: `apps/cli/src/__tests__/inject-provider-env.test.ts`

- [x] **Step 1: 从 CLI 提取配置路径与首次初始化逻辑到 agent**

Expected exports in `packages/agent/src/context.ts`:

```ts
export function ensureDefaultUserConfig(
  paths: AgentAppPaths,
): Promise<void>;

export function loadAgentContext(
  options?: LoadAgentContextOptions,
): Promise<LoadedAgentContext>;
```

- [x] **Step 2: 将 provider env 注入逻辑迁移到 agent**

Target constant shape:

```ts
const PROVIDER_ENV_KEY_MAP: Readonly<Record<string, readonly string[]>> = {
  openai: ["OPENAI_API_KEY"],
  anthropic: ["ANTHROPIC_API_KEY"],
  google: ["GOOGLE_GENERATIVE_AI_API_KEY"],
};
```

Expected: CLI 不再拥有 provider env 细节，只消费 agent 暴露的方法。

- [x] **Step 3: 为 context 装配写测试，覆盖默认 agent、SOUL 加载、env 解析**

Test examples:

```ts
it("loads default agent context from resolved config", async () => {
  const context = await loadAgentContext({ cwd: workspaceDir });
  expect(context.agent.agentName).toBe("default");
  expect(context.agent.soul).toContain("system");
});

it("injects provider env vars from explicit provider config", () => {
  const resolved = injectProviderEnv({
    provider: "openai",
    providerConfig: { apiKey: "test-key" },
  });
  expect(resolved).toContain("OPENAI_API_KEY");
});
```

- [x] **Step 4: 将 CLI 原测试重定向到 agent API 或删除重复覆盖**

Expected: `apps/cli/src/__tests__/config.test.ts` 与 `inject-provider-env.test.ts` 不再断言 CLI 私有实现细节，而是验证 CLI 正确调用 agent。

- [x] **Step 5: 执行静态检查**

Run: `pnpm check`
Expected: context API 与 CLI 调用方类型一致，无循环依赖。

- [ ] **Step 6: Commit**

```bash
git add packages/agent apps/cli/src/config.ts apps/cli/src/__tests__
git commit -m "refactor: move cli config assembly into agent context"
```

### Task 8: Extract Runtime Startup Flow Into Agent Session API

**Files:**
- Modify: `apps/cli/src/main.ts`
- Modify: `packages/agent/src/session.ts`
- Create: `packages/agent/src/__tests__/session.test.ts`
- Modify: `apps/cli/src/__tests__/run-e2e.test.ts`

- [x] **Step 1: 将 `createCliRuntime` 泛化为 `createAgentRuntime`**

Target shape:

```ts
export function createAgentRuntime(
  context: LoadedAgentContext,
): SessionRuntime {
  return createSessionRuntime({
    config: context.config,
    snapshotStore: context.snapshotStore,
  });
}
```

- [x] **Step 2: 抽象会话级 chat API，封装 session 创建与 runTurn 输入**

Target shape:

```ts
export function createAgentSession(
  context: LoadedAgentContext,
): AgentSession {
  const runtime = createAgentRuntime(context);
  const sessionId = runtime.createSessionId();

  return {
    sessionId,
    chat(prompt, options) {
      return runtime.runTurn({
        sessionId,
        prompt,
        ...options,
      });
    },
  };
}
```

- [x] **Step 3: 简化 CLI `handleRunCommand`，只做参数解析与事件输出**

CLI target pattern:

```ts
const context = await loadAgentContext({ cwd: process.cwd() });
const session = createAgentSession(context);

for await (const event of session.chat(prompt)) {
  handleRuntimeEvent(event, logger);
}
```

- [x] **Step 4: 改写 session 与 e2e 相关测试**

Test examples:

```ts
it("creates runtime from loaded agent context", () => {
  const runtime = createAgentRuntime(context);
  expect(runtime).toBeDefined();
});

it("cli run command consumes agent session events", async () => {
  const events = await collectRunEvents("hello");
  expect(events.length).toBeGreaterThan(0);
});
```

- [x] **Step 5: 执行静态检查**

Run: `pnpm check`
Expected: CLI 不再直接依赖 runtime 创建细节，agent session API 类型完整。

- [ ] **Step 6: Commit**

```bash
git add packages/agent apps/cli/src/main.ts apps/cli/src/__tests__/run-e2e.test.ts
git commit -m "refactor: route cli runtime startup through agent session api"
```

### Task 9: Enforce Dependency Boundaries In Package Metadata And Tests

**Files:**
- Modify: `apps/cli/package.json`
- Modify: `packages/runtime/package.json`
- Modify: `packages/shared/package.json`
- Modify: `packages/runtime/src/__tests__/index.test.ts`
- Modify: package boundary tests across workspace

- [x] **Step 1: 更新 CLI 依赖声明，移除 runtime 直连**

CLI dependency target shape:

```json
{
  "dependencies": {
    "@tianji/agent": "workspace:*",
    "@tianji/shared": "workspace:*"
  }
}
```

- [x] **Step 2: 保证 shared 保持零内部包依赖**

Validation command:

Run: `rg '"@tianji/' /workspaces/dev_docker/tianji-ai/packages/shared/package.json /workspaces/dev_docker/tianji-ai/packages/shared/src`
Expected: shared 仅有自包相对引用，不依赖其他内部包。

- [x] **Step 3: 更新边界测试断言**

Assertion examples:

```ts
expect(cliDependencies).not.toContain("@tianji/runtime");
expect(runtimeDependencies).not.toContain("@tianji/agent");
expect(sharedDependencies).not.toContain("@tianji/runtime");
```

- [x] **Step 4: 如有 `exports` 约束，补齐新包与收紧 deep import**

Example shape:

```json
{
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  }
}
```

- [x] **Step 5: 执行静态检查**

Run: `pnpm check`
Expected: 依赖矩阵与边界断言全部通过。

- [ ] **Step 6: Commit**

```bash
git add packages apps
git commit -m "chore: enforce architecture v2 dependency boundaries"
```

### Task 10: Update Documentation Per Phase Instead Of Final Patch-Up

**Files:**
- Modify: `README.md`
- Modify: `packages/runtime/README.md`
- Modify: `apps/cli/README.md`
- Modify: `docs/CONFIG_DESIGN.md`

- [x] **Step 1: 更新根 README 的包结构说明**

Required wording block:

```md
packages/
- shared: 类型、配置 schema 与纯函数
- runtime: 配置加载、执行引擎、内部 LLM 模块
- agent: 上下文装配、启动封装、编排扩展点
apps/
- cli: 终端 UI 适配层
```

- [x] **Step 2: 更新 runtime README，明确 LLM 为内部实现**

Required wording block:

```md
`@tianji/runtime` 不再暴露独立 LLM gateway API；provider 适配位于内部 `src/llm/` 模块。
```

- [x] **Step 3: 更新 CLI README，说明启动链路改由 agent 封装**

Required wording block:

```md
CLI 通过 `@tianji/agent` 加载上下文并创建会话，不直接组装 runtime。
```

- [x] **Step 4: 更新 `CONFIG_DESIGN.md` 中运行时加载流水线的职责描述**

Required wording block:

```md
默认 agent 解析与 `SOUL.md` 加载由 `@tianji/agent` 负责；schema 校验、placeholder 解析与 merge 纯函数继续由 `@tianji/shared` 提供，文件系统级加载与错误包装仍由 `@tianji/runtime` 负责。
```

- [x] **Step 5: 执行静态检查**

Run: `pnpm check`
Expected: 文档引用的包名、路径与边界测试保持一致。

- [ ] **Step 6: Commit**

```bash
git add README.md packages/runtime/README.md apps/cli/README.md docs/CONFIG_DESIGN.md
git commit -m "docs: align docs with architecture v2 package boundaries"
```

### Task 11: Final Cleanup, Residual Reference Scan, And Verification

**Files:**
- Modify: `turbo.json`
- Modify: `biome.json`
- Modify: any residual files found by scan

- [x] **Step 1: 扫描全部旧名称和旧入口残留**

Run: `rg "@tianji/contracts|@tianji/llm|createCliRuntime|injectProviderEnv" /workspaces/dev_docker/tianji-ai`
Expected: 仅允许保留在迁移说明文档中；源码、测试、README 中不应再出现旧入口。

- [x] **Step 2: 检查 turbo 与 biome 是否引用已删除包**

Run: `rg "contracts|llm" /workspaces/dev_docker/tianji-ai/turbo.json /workspaces/dev_docker/tianji-ai/biome.json`
Expected: 若存在旧包名则同步修正，否则保持不变。

- [x] **Step 3: 执行最终静态检查**

Run: `pnpm check`
Expected: 全量通过，且输出中没有新增 errors、warnings、infos。

- [x] **Step 4: 记录人工验收点，不在未授权情况下执行测试**

Manual verification checklist:

```md
- `@tianji/shared` 是唯一基础协议来源
- `@tianji/runtime` 不再公开 LLM gateway
- `@tianji/agent` 提供 context/runtime/session 原语
- `apps/cli` 不再直接依赖 runtime 启动逻辑
```

- [ ] **Step 5: Commit**

```bash
git add turbo.json biome.json packages apps README.md docs
git commit -m "chore: finalize architecture v2 migration cleanup"
```

---

## Self-Review

### Spec Coverage

- 第 1-3 节的目标与包职责已映射到 Task 2-10。
- 第 4-5 节依赖图与依赖矩阵已映射到 Task 9。
- 第 6 节文件级映射已拆分到 Task 2-8。
- 第 7 节设计权衡体现在最小行为变更、内部化 LLM、引入 agent 但不做多 agent 的任务边界中。
- 第 8 节不变设计通过“仅改边界不改语义”的说明和测试迁移约束覆盖。
- 第 9 节 phase 顺序已直接转换为任务顺序。
- 第 10 节 `CONFIG_DESIGN.md` 影响映射到 Task 10。
- 第 11 节未来演进未纳入实现，仅通过 agent 包 API 预留扩展面。

### Placeholder Scan

- 已避免使用 `TODO`、`TBD`、`implement later`。
- 每个任务都给出了明确文件、命令或代码形状。
- 未使用“类似 Task N”这类跨任务省略表述。

### Type Consistency

- 统一使用 `AgentContext`、`LoadedAgentContext`、`AgentAppPaths`、`AgentSession` 命名。
- 统一使用 `createAgentRuntime` 与 `createAgentSession` 替代 `createCliRuntime`。
- 统一要求 shared 为协议唯一来源，runtime 为执行层，agent 为装配层，cli 为 UI 层。
