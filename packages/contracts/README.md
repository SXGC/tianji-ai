# @tianji/contracts

`tianji-ai` 的公共领域协议包，提供零依赖的类型定义。

## 包职责

`@tianji/contracts` 是多包仓库中的统一契约层，负责定义 `@tianji/llm`、`@tianji/runtime` 等包共享的标识符、消息模型、运行时事件、工具协议、执行策略、错误类型，以及增量、产物和快照相关类型。

该包保持框架无关且不引入依赖，用于保证上层包复用同一套领域语言，而不会泄漏模型供应商 SDK 或编排层内部实现。

## 当前公开内容

- 标识符工厂与 branded 类型：`createSessionId`、`createThreadId`、`createRunId`、`SessionId`、`ThreadId`、`RunId`
- 错误类型：`TianjiError`、`ProviderError`、`ToolError`、`PolicyError`、`TimeoutError`、`CancelledError`
- 执行策略类型与默认值：`ExecutionPolicy`、`DEFAULT_EXECUTION_POLICY`
- 工具协议：`ToolSpec`、`ToolInvocation`、`ToolResult`、`JSONSchema`
- 消息模型：`AppMessage`、`MessagePart`、`MessageRole`、`ToolCall`
- 运行时事件协议：`RuntimeEvent` 及各类生命周期事件类型
- Delta 类型与聚合辅助：`Delta`、`MessageDelta`、`ToolProgressDelta`、`applyMessageDelta`、`isComplete`
- Artifact 与 snapshot 类型：`Artifact`、`SessionSnapshot`、`RunSnapshot`

## 使用示例

```ts
import {
  createSessionId,
  createRunId,
  type AppMessage,
  type RuntimeEvent,
  DEFAULT_EXECUTION_POLICY,
} from '@tianji/contracts'

const sessionId = createSessionId('session_123')
const runId = createRunId('run_123')

const message: AppMessage = {
  id: 'msg_123',
  role: 'user',
  content: [{ type: 'text', text: 'Hello' }],
  createdAt: Date.now(),
}

const event: RuntimeEvent = {
  type: 'run.started',
  runId,
  sessionId,
  timestamp: Date.now(),
}

void DEFAULT_EXECUTION_POLICY
void message
void event
```

## 开发命令

在仓库根目录执行：

```bash
pnpm --filter @tianji/contracts build
pnpm --filter @tianji/contracts typecheck
pnpm --filter @tianji/contracts test
pnpm --filter @tianji/contracts clean
```

## 开源协议

MIT
