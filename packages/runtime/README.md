# @tianji/runtime

`tianji-ai` 的会话运行时包，内部基于 LangGraph 做编排。

## 包职责

`@tianji/runtime` 是会话状态与执行过程的编排层，对外通过统一的运行时 API 组合共享契约、LLM 网关、快照持久化、事件流与运行时工具注册能力。

该包的公开表面刻意保持收敛：应用侧应通过 `createSessionRuntime` 以及导出的持久化、事件流、工具注册原语接入，而不是依赖内部工作流细节。

## 当前公开内容

- 运行时入口与类型：`createSessionRuntime`、`SessionRuntime`、`SessionRuntimeOptions`、`CreateSessionOptions`、`RunTurnOptions`、`ResumeRunOptions`
- 事件流：`ReplayableEventStream`
- 快照持久化：`SnapshotStore`、`InMemorySnapshotStore`、`FileSnapshotStore`
- 工具注册与策略校验：`ToolRegistry`、`ensureToolAllowed`、`RuntimeToolDefinition`、`RuntimeToolExecutionContext`、`RuntimeToolSideEffect`、`ToolCatalog`

## 使用示例

```ts
import { createSessionRuntime, InMemorySnapshotStore, ToolRegistry } from '@tianji/runtime'
import { createLlmGateway } from '@tianji/llm'

const runtime = createSessionRuntime({
  llmGateway: createLlmGateway({
    provider: 'openai',
    model: 'gpt-4.1',
    apiKey: process.env.OPENAI_API_KEY,
  }),
  snapshotStore: new InMemorySnapshotStore(),
  toolCatalog: new ToolRegistry(),
})

void runtime
```

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
