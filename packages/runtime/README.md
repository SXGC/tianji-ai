# @tianji/runtime

`tianji-ai` 的会话运行时包，v2 公共 API 现已收敛到 deepagents-native 配置面。

## 包职责

`@tianji/runtime` 是会话状态与执行过程的编排层，对外通过统一的运行时 API 组合共享契约、快照持久化、事件流、配置中心与运行时工具注册能力。

该包的公开表面刻意保持收敛：应用侧应通过 `createSessionRuntime` 以及导出的持久化、事件流、工具注册原语接入，而不是依赖内部工作流细节。

从 v2 开始，`SessionRuntimeOptions` 默认围绕 `deepagents` 配置块组织；`snapshotStore` 与 `toolCatalog` 继续保留在公共 API 中。当前 package 的运行时执行面已经收敛为 deepagents-only；历史 legacy session/run snapshot 仍可通过 metadata helper 读取，用于迁移校验与兼容验证。

## 当前公开内容

- 运行时入口：`createSessionRuntime`、`createGraphRuntime`
- 配置中心：`loadResolvedConfig`、`resolveConfigPaths`、`resolveWorkspaceConfig`、`createWorkspaceId`
- 运行时接口与配置类型：`SessionRuntime`、`SessionRuntimeOptions`、`SessionRuntimeEngine`、`SessionRuntimeDeepagentsConfig`、`CreateSessionOptions`、`RunTurnOptions`、`ResumeRunOptions`、`GraphRuntime`、`GraphRunRequest`、`GraphRunHandle`
- tracing 配置类型：`SessionRuntimeTracingConfig`、`RuntimeLangsmithTracingConfig`
- observer 边界：`ObserverLogger`
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
  tracing: {
    langsmith: {
      enabled: true,
      project: 'tianji-dev',
      apiKey: '${env:LANGSMITH_API_KEY}',
      tags: ['tianji', 'runtime'],
      metadata: {
        service: 'tianji-node',
      },
    },
  },
  snapshotStore: new InMemorySnapshotStore(),
  toolCatalog: new ToolRegistry(),
})

void runtime
```

## Unified Entry 与 Graph Runtime

从这次重构开始，应用侧的合法主链入口应该是：

1. 先在 `@tianji/agent` 层进入 unified entry
2. 由 unified entry 解析默认图并装配 executor registry
3. 再把请求交给 `@tianji/runtime` 的 graph runtime

也就是说，`@tianji/runtime` 现在不仅负责单 session 的 run 生命周期，还对外暴露“整张图”的运行入口。

```ts
import { createGraphRuntime } from '@tianji/runtime'

const graphRuntime = createGraphRuntime({
  sessionRuntime,
  graphRunner,
})

const handle = await graphRuntime.runGraph({
  graph,
  executors,
  initialState: { input: 'hello' },
})

for await (const event of handle.events) {
  void event
}
```

旧的 session facade、ACP runner 一类对象不再应该被应用直接当作主链入口使用。

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
console.log(resolved.config.runtime?.tracing?.langsmith?.project)
```

`runtime.tracing.langsmith` 也走同一条三层配置链：

```json
{
  "runtime": {
    "tracing": {
      "langsmith": {
        "enabled": true,
        "project": "tianji-dev",
        "apiKey": "${env:LANGSMITH_API_KEY}",
        "apiUrl": "https://api.smith.langchain.com",
        "tags": ["tianji", "runtime"],
        "metadata": {
          "service": "tianji-node"
        }
      }
    }
  }
}
```

注意：`enabled: true` 时，`project` 和 `apiKey` 在三层配置合并完成后必须存在；runtime 不依赖 `LANGCHAIN_TRACING_V2` 之类的环境变量自动开关。

## `SessionRuntimeOptions` v2 说明

### Session 生命周期语义

- `createSession` 只用于新建 session，并写入新的初始快照。
- `openSession` 只用于打开已有 session；目标 session 不存在时会直接抛出 `SESSION_NOT_FOUND`。
- 如果调用方需要“有则打开、无则创建”，必须在应用层显式判断，不能再把这两种语义混进一个 runtime API。

- `engine?: 'deepagents'`：未显式指定时默认使用 `deepagents`；历史 legacy 标记仅通过 metadata helper 暴露，不再作为可执行 runtime 选项。
- `deepagents`：v2 主配置块，当前公开字段为 `model`、`middleware`、`backend`、`checkpointer`、`store`、`subagents`、`skills`、`interruptOn`。
- `tracing`：可选 tracing 配置块；当前支持 `langsmith`，由 runtime 在执行时显式注入 `LangChainTracer`。
- `logger?: ObserverLogger`：可选注入 observer logger，作为 runtime 向外部日志系统写入记录的公共边界；runtime 本身不定义 sink、文件路径或渲染策略。
- `snapshotStore` / `toolCatalog`：继续作为稳定公共 API 暴露。

### Graph trace propagation

- `runtime.tracing.langsmith` 仍然是唯一的 LangSmith tracing 配置入口。
- 编排图不会共享一个 `SessionRuntime` 实例；每个节点仍使用独立 runtime。
- graph 层只透传 tracing context（tags / metadata），由 runtime 在每次 run 执行时与自身 tracing metadata 合并。
- LangSmith 中可通过 `graphRunId`、`graphId`、`nodeId` 聚合查看整轮 graph run 的节点运行。

### Run 快照与事件观测

- `RunSnapshot` 现在会额外持有 `triggerType`，并在恢复链路中通过可选 `parentRunId` 标记来源 run。
- `run.started`、`run.completed`、`run.failed`、`run.cancelled` 事件都会携带 `sessionId`、`runId`、`triggerType`；如果当前 run 由恢复链路派生，还会额外携带 `parentRunId`。
- 如果注入了 `logger?: ObserverLogger`，runtime 会在 run 生命周期日志的 `data` 中写入同一组观测字段，保证外部 sink 可以直接按 `sessionId + runId` 检索整条 run 生命周期。

如果应用侧需要把 runtime 日志接到文件、stdout 或内存中，应在外部先通过 `@tianji/observer` 创建 `ObserverLogger`，再注入给 `createSessionRuntime`。

```ts
import { createObserverLogger, createStdoutSink } from '@tianji/observer'
import { createSessionRuntime, InMemorySnapshotStore, ToolRegistry } from '@tianji/runtime'

const logger = createObserverLogger({
  sinks: [createStdoutSink({ pretty: true })],
  scope: ['runtime'],
})

const runtime = createSessionRuntime({
  deepagents: {
    model: 'openai:gpt-5.1',
  },
  logger,
  snapshotStore: new InMemorySnapshotStore(),
  toolCatalog: new ToolRegistry(),
})

void runtime
```

注意事项：

- 当前版本已经接入 deepagents bootstrap，可执行基础文本轮次并写回 runtime metadata。
- `runtime.tracing.langsmith` 只在 runtime 执行层创建 LangSmith client / tracer；`@tianji/observer` 继续只负责通用日志与 OTel span。
- `middleware`、`subagents` 会按当前配置原样透传给上游 deepagents；其具体行为与兼容性约束遵循 upstream 实现。
- `interruptOn` 现在支持真实 checkpoint 恢复，但必须与 `checkpointer` 一起使用；被中断的 run 会把 checkpoint 信息写入 runtime metadata，并把 interrupt payload 写入 `RunSnapshot.workflowState`。
- 当 run 因 HITL 中断而暂停时，调用方应先读取 `readRunRuntimeMetadata(run.metadata)` 和 `readDeepagentsRunWorkflowState(run.workflowState)`，再通过 `resumeRun({ runId, resumeValue })` 提交与上游 LangGraph `Command({ resume })` 兼容的 JSON 值。
- `readSessionRuntimeMetadata` 与 `readRunRuntimeMetadata` 仍会识别 legacy metadata，便于校验历史快照、迁移脚本和只读兼容测试。

## 事件系统

tianji-ai 使用 Core / Integration / Protocol 三层事件架构：
- Core：聚合根发射纯 DomainEvent（PascalCase，如 `RunStarted`）。
- Integration：统一 `DomainEventEnvelope` 信封，`correlationId + causationId + sequence` 三件套。
- Protocol：AG-UI / ACP / Daemon SSE / OTel / Observer 都是 EventBus 订阅者。

旧 `RuntimeEvent` / `TaskEvent` 已移除。详见 `docs/superpowers/specs/2026-04-14-event-bus-design.md`。

注意：runtime 内部通过 `AsyncLocalStorage` 传播 `correlationId`，无需在每个方法参数中手动传递。

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
