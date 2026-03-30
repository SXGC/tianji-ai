# @tianji/runtime

`tianji-ai` 的会话运行时包，v2 公共 API 现已收敛到 deepagents-native 配置面。

## 包职责

`@tianji/runtime` 是会话状态与执行过程的编排层，对外通过统一的运行时 API 组合共享契约、快照持久化、事件流、配置中心与运行时工具注册能力。

该包的公开表面刻意保持收敛：应用侧应通过 `createSessionRuntime` 以及导出的持久化、事件流、工具注册原语接入，而不是依赖内部工作流细节。

从 v2 开始，`SessionRuntimeOptions` 默认围绕 `deepagents` 配置块组织；`snapshotStore` 与 `toolCatalog` 继续保留在公共 API 中。当前 package 的运行时执行面已经收敛为 deepagents-only；历史 legacy session/run snapshot 仍可通过 metadata helper 读取，用于迁移校验与兼容验证。

## 当前公开内容

- 运行时入口：`createSessionRuntime`
- 配置中心：`loadResolvedConfig`、`resolveConfigPaths`、`resolveWorkspaceConfig`、`createWorkspaceId`
- 运行时接口与配置类型：`SessionRuntime`、`SessionRuntimeOptions`、`SessionRuntimeEngine`、`SessionRuntimeDeepagentsConfig`、`CreateSessionOptions`、`RunTurnOptions`、`ResumeRunOptions`
- 配置错误与元数据类型：`RuntimeConfigError`、`ResolvedConfig`、`ResolvedConfigPaths`、`WorkspaceConfigResolution`、`ConfigLayerSnapshot`
- Metadata 读取：`readSessionRuntimeMetadata`、`readRunRuntimeMetadata`、`readDeepagentsRunWorkflowState`
- Metadata 类型：`SessionRuntimeMetadata`、`RunRuntimeMetadata`、`DeepagentsRunWorkflowState`、`DeepagentsInterruptRecord`
- 事件流：`ReplayableEventStream`
- 快照持久化：`SnapshotStore`、`InMemorySnapshotStore`、`FileSnapshotStore`
- 工具注册与策略校验：`ToolRegistry`、`ensureToolAllowed`、`RuntimeToolDefinition`、`RuntimeToolExecutionContext`、`RuntimeToolSideEffect`、`ToolCatalog`

## 使用示例

```ts
import { createSessionRuntime, InMemorySnapshotStore, ToolRegistry } from '@tianji/runtime'

const runtime = createSessionRuntime({
  deepagents: {
    model: 'openai:gpt-5.1',
    middleware: [],
    backend: { kind: 'state-backend' },
    checkpointer: { kind: 'memory-saver' },
    store: { kind: 'memory-store' },
    subagents: [],
    skills: ['/skills/'],
  },
  snapshotStore: new InMemorySnapshotStore(),
  toolCatalog: new ToolRegistry(),
})

void runtime
```

## 配置中心

运行时现在负责中心化加载配置。默认会按以下优先级读取并合并 JSON 配置：

- 默认层：开发态读取仓库根 `tianji.config.json`，生产态读取 runtime 包内携带的 `tianji.config.json`
- 用户层：`~/.config/tianji-ai/tianji.json`
- 工作区层：`~/.config/tianji-ai/workspaces/<workspace-id>.json`

加载顺序为 `default < user < workspace`，对象字段深合并、标量替换、数组整体替换。所有层合并后，runtime 会统一执行 schema 校验与 `${env:VAR_NAME}` 占位符解析。

```ts
import { loadResolvedConfig } from '@tianji/runtime'

const resolved = await loadResolvedConfig()

console.log(resolved.paths.defaultConfigPath)
console.log(resolved.workspace.id)
console.log(resolved.config.agents?.defaultAgent)
```

## `SessionRuntimeOptions` v2 说明

- `engine?: 'deepagents'`：未显式指定时默认使用 `deepagents`；历史 legacy 标记仅通过 metadata helper 暴露，不再作为可执行 runtime 选项。
- `deepagents`：v2 主配置块，当前公开字段为 `model`、`middleware`、`backend`、`checkpointer`、`store`、`subagents`、`skills`、`interruptOn`。
- `snapshotStore` / `toolCatalog`：继续作为稳定公共 API 暴露。

注意事项：

- 当前版本已经接入 deepagents bootstrap，可执行基础文本轮次并写回 runtime metadata。
- `middleware`、`subagents` 会按当前配置原样透传给上游 deepagents；其具体行为与兼容性约束遵循 upstream 实现。
- `interruptOn` 现在支持真实 checkpoint 恢复，但必须与 `checkpointer` 一起使用；被中断的 run 会把 checkpoint 信息写入 runtime metadata，并把 interrupt payload 写入 `RunSnapshot.workflowState`。
- 当 run 因 HITL 中断而暂停时，调用方应先读取 `readRunRuntimeMetadata(run.metadata)` 和 `readDeepagentsRunWorkflowState(run.workflowState)`，再通过 `resumeRun({ runId, resumeValue })` 提交与上游 LangGraph `Command({ resume })` 兼容的 JSON 值。
- `readSessionRuntimeMetadata` 与 `readRunRuntimeMetadata` 仍会识别 legacy metadata，便于校验历史快照、迁移脚本和只读兼容测试。

## 主要依赖

- `deepagents` — 运行时执行引擎
- `@langchain/langgraph` / `@langchain/core` / `langchain` — LangGraph 状态机与 checkpoint 基础设施
- 基础协议与配置 schema 统一由 `@tianji/shared` 提供。
- `src/llm/` — runtime 内部 LLM 适配层（generation config 类型）
- `@tianji/shared` — 共享配置模型与工具函数

## 开发命令

在仓库根目录执行：

```bash
pnpm --filter @tianji/runtime build
pnpm --filter @tianji/runtime typecheck
pnpm --filter @tianji/runtime test
pnpm --filter @tianji/runtime clean
```

## 开源协议

MIT
