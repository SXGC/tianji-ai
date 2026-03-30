# Minimal Agent 阶段 3 详细计划

完整计划在 minimal-agent-implementation.md 中

## 阶段目标

在 `apps/cli` 中打通完整的 LLM 运行链路：从配置上下文到 runtime 创建、session 建立、`runTurn` 调用、事件流消费，直到最终文本输出。同时完成 `SOUL.md` 到 `systemPrompt` 的注入、provider apiKey 到环境变量的映射、以及运行全链路的日志记录。

本阶段完成后，`tianji run "hi"` 能在配置与 env 正确的前提下得到模型的真实响应。

## 完成定义

当以下条件同时满足时，阶段 3 视为完成：

- `tianji run "hi"` 能完成一次完整的 LLM 请求并输出 assistant 文本到 stdout。
- `SOUL.md` 内容被加载并传入 runtime 的 `systemPrompt`。
- provider 的 `apiKey` 通过 `resolveConfigPlaceholders` 解析后被注入 `process.env`。
- 运行失败时能给出结构化错误消息与非零退出码。
- 日志中能看到配置加载、runtime 创建、事件流转、运行结束的完整记录。
- `pnpm check` 通过。

## 目标文件

- `apps/cli/src/main.ts`
- `apps/cli/src/config.ts`
- `apps/cli/src/logger.ts`
- `apps/cli/package.json`
- `apps/cli/README.md`

不新增文件，只在阶段 2 已有骨架上填充实现。

## 关键依赖分析

### runtime API 入口

`@tianji/runtime` 导出的关键接口：

- `createSessionRuntime(options: SessionRuntimeOptions): SessionRuntime`
  - `options.deepagents.model` 接受 `string`（格式为 `provider:modelName`，如 `openai:gpt-4.1`）或 `BaseLanguageModel` 实例。
  - `options.snapshotStore` 可传入 `FileSnapshotStore` 或缺省（内部使用 `InMemorySnapshotStore`）。
- `SessionRuntime.createSession(options?)` 返回 `SessionSnapshot`。
- `SessionRuntime.runTurn(options)` 返回 `RunId`。
  - `options.sessionId` 来自 createSession 返回值。
  - `options.message` 为 `AppMessage`，至少需要 `{ id, role: 'user', content: [{ type: 'text', text }], createdAt }`。
  - `options.systemPrompt` 用于注入 `SOUL.md` 内容。
- `SessionRuntime.streamEvents(runId)` 返回 `AsyncIterable<RuntimeEvent>`。

### 事件类型消费

`RuntimeEvent` 是一个联合类型，CLI 需要消费的关键事件：

| 事件类型 | 用途 |
|---------|------|
| `message.delta` | 实时拼接文本增量，用于流式输出到 stdout |
| `message.completed` | 标记消息完成，可提取最终完整消息 |
| `run.completed` | 标记运行成功结束 |
| `run.failed` | 运行失败，提取 `event.error` 输出错误信息 |

### provider 环境变量映射

`deepagents` 底层依赖 `@langchain` 系列包，它们通过环境变量读取 API key：

| provider 名称 | 环境变量 |
|--------------|---------|
| `openai` | `OPENAI_API_KEY` |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `google` | `GOOGLE_GENERATIVE_AI_API_KEY` |

CLI 需要在创建 runtime 前完成此映射。映射规则为：从 `resolveConfigPlaceholders` 返回的已解析配置中读取 `providers[providerName].apiKey`，写入对应的 `process.env` 键。

### 阶段 2 骨架现状

当前 `handleRunCommand` 在 `apps/cli/src/main.ts:93-121` 中：

1. 已获取 `paths` 与 `logger`。
2. 已调用 `loadUserConfigContext()` 获取完整的配置上下文（含 agent、provider、modelName、soul）。
3. 已调用 `createCliRuntime(context)` 但只返回了一个 `PreparedCliRuntimeInput` 占位对象。
4. 写了一条 `logWarn` 声明 "Runtime execution is not implemented in stage 2"。
5. 输出 stderr 提示后返回退出码 1。

阶段 3 需要将步骤 3-5 替换为真实的 runtime 创建、session/run/event 链路。

## 详细 TODO

### 1. 添加 `@tianji/runtime` 和 `@tianji/shared` 依赖

在 `apps/cli/package.json` 的 `dependencies` 中新增：

```json
"@tianji/shared": "workspace:*",
"@tianji/runtime": "workspace:*"
```

这两个包提供 `createSessionRuntime`、`FileSnapshotStore`、`AppMessage`、`RuntimeEvent` 等类型和运行时能力。

### 2. 实现 provider apiKey 到 process.env 的注入

在 `apps/cli/src/config.ts` 中新增：

```ts
const PROVIDER_ENV_KEY_MAP: Readonly<Record<string, string>> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
}
```

新增函数：

```ts
/**
 * 将已解析的 provider apiKey 注入到 process.env，使底层 SDK 能自动发现凭据。
 *
 * @param context - 已加载的用户配置上下文
 */
export function injectProviderEnv(context: LoadedUserConfigContext): void
```

实现逻辑：

- 读取 `context.agent.provider`（provider 名称）。
- 在 `PROVIDER_ENV_KEY_MAP` 中查找对应的环境变量键名。
- 若找到映射且 `context.agent.providerConfig?.apiKey` 为非空字符串，则写入 `process.env[envKey] = apiKey`。
- 若 provider 不在映射表中，不做任何操作（预留扩展能力，不报错）。
- 若 providerConfig 不存在或 apiKey 为空，也不做任何操作（允许用户直接在环境中预设 key）。

此函数在 `loadUserConfigContext` 之后、runtime 创建之前调用。

### 3. 扩展 LoadedUserConfigContext（如需要）

检查当前 `LoadedUserConfigContext` 是否已包含足够信息。当前结构：

```ts
interface LoadedUserConfigContext {
  readonly paths: UserConfigPaths
  readonly config: TianjiConfig
  readonly agent: LoadedAgentConfig
  readonly resolvedEnvVars: readonly string[]
}
```

`LoadedAgentConfig` 已包含 `provider`、`modelName`、`soul`、`providerConfig` 等字段。这些信息足够支撑 runtime 创建，无需扩展。

### 4. 实现 runtime 创建函数

在 `apps/cli/src/main.ts` 中将当前的 `createCliRuntime` 函数从占位替换为真实实现。

新的函数签名：

```ts
/**
 * 根据已加载的用户配置上下文创建 session runtime。
 *
 * @param context - 已加载的用户配置上下文
 * @returns 可用的 SessionRuntime 实例
 */
function createCliRuntime(context: LoadedUserConfigContext): SessionRuntime
```

实现逻辑：

- 从 `context.agent` 读取 `provider` 与 `modelName`，拼接为 `deepagents.model = "${provider}:${modelName}"`。
- 构造 `SnapshotStore`：使用 `InMemorySnapshotStore`。不使用 `FileSnapshotStore`，因为最小 CLI 不需要持久化快照。如果后续需要 session 持久化，可在后续阶段切换。
- 调用 `createSessionRuntime({ deepagents: { model } })`。
- 返回 runtime 实例。

注意：

- 不传入 `toolCatalog`，最小 CLI 暂不注册工具。
- 不传入 `snapshotStore`，让 runtime 使用默认的 `InMemorySnapshotStore`。

### 5. 实现 session 创建与 user message 构造

在 `handleRunCommand` 中，runtime 创建之后需要：

1. 调用 `runtime.createSession()` 获取 `sessionSnapshot`。
2. 构造 user message：

```ts
const userMessage: AppMessage = {
  id: `msg_user_${Date.now()}`,
  role: 'user',
  content: [{ type: 'text', text: command.prompt }],
  createdAt: Date.now(),
}
```

3. 将 `context.agent.soul` 作为 `systemPrompt` 传入。

### 6. 实现 runTurn 调用

调用 `runtime.runTurn`：

```ts
const runId = await runtime.runTurn({
  sessionId: sessionSnapshot.sessionId,
  message: userMessage,
  systemPrompt: context.agent.soul,
})
```

### 7. 实现事件流消费

调用 `runtime.streamEvents(runId)` 获取 `AsyncIterable<RuntimeEvent>`，按事件类型处理：

```ts
let assistantText = ''

for await (const event of runtime.streamEvents(runId)) {
  switch (event.type) {
    case 'message.delta':
      if (event.channel === 'text') {
        process.stdout.write(event.payload.content)
        assistantText += event.payload.content
      }
      break
    case 'run.failed':
      throw new Error(`Run failed: ${event.error.message}`)
    case 'run.completed':
      break
  }
}
```

关键设计点：

- `message.delta` 的文本增量直接 `process.stdout.write`，实现流式输出效果。
- `run.failed` 直接抛出错误，由外层 `runCli` 的 catch 统一处理。
- `run.completed` 时结束循环，后续输出换行。
- 不需要 `message.completed` 做特殊处理，因为 `run.completed` 已经表示运行结束。
- 日志在关键节点写入：runtime 创建后、runTurn 调用前、事件流转中的状态变化。

### 8. 补充运行链路日志

在 `handleRunCommand` 中，替换阶段 2 的 warn 日志，改为以下日志节点：

| 时机 | scope | level | message |
|------|-------|-------|---------|
| provider env 注入后 | `cli.run.config` | info | Provider env vars injected |
| runtime 创建后 | `cli.run.runtime` | info | Session runtime created |
| session 创建后 | `cli.run.runtime` | info | Session created |
| runTurn 调用后 | `cli.run.runtime` | info | Run started |
| run.completed 时 | `cli.run.event` | info | Run completed |
| run.failed 时 | `cli.run.event` | error | Run failed |

日志 data 字段只记录元信息（agentName、model、soulPath、sessionId、runId 等），不记录 prompt 正文、SOUL.md 正文或 assistant 响应正文。

### 9. 处理最终输出

事件循环结束后：

- 输出一个换行 `process.stdout.write('\n')`，确保终端提示符在新行。
- 返回退出码 `0`。

### 10. 整理 handleRunCommand 完整流程

最终的 `handleRunCommand` 函数流程：

```
1. 获取 paths 与 logger
2. logInfo: "Received run command"
3. loadUserConfigContext()
4. logInfo: "Loaded user config context"
5. injectProviderEnv(context)
6. logInfo: "Provider env vars injected"
7. createCliRuntime(context)  -- 真实创建 runtime
8. logInfo: "Session runtime created"
9. runtime.createSession()
10. logInfo: "Session created"
11. 构造 user message
12. runtime.runTurn({ sessionId, message, systemPrompt: soul })
13. logInfo: "Run started"
14. for await (event of streamEvents(runId))
      - message.delta -> stdout.write
      - run.failed -> throw
      - run.completed -> break
15. stdout.write('\n')
16. logInfo: "Run completed"
17. return 0
```

### 11. 错误处理策略

以下错误场景需要在阶段 3 中覆盖：

#### runtime 创建失败

- 场景：`deepagents.model` 格式不被 runtime 接受，或底层 SDK 初始化失败。
- 处理：由 `runCli` 的顶层 catch 捕获，输出 `error.message` 到 stderr，退出码 1。

#### runTurn 失败

- 场景：session 不存在（理论上不会发生，因为刚创建）、模型配置错误。
- 处理：与 runtime 创建失败相同。

#### run.failed 事件

- 场景：LLM 请求失败（网络错误、认证失败、rate limit 等）。
- 处理：在事件循环中 throw，写入 error 日志，由顶层 catch 输出错误。

#### 环境变量缺失

- 场景：用户配置了 `${env:OPENAI_API_KEY}` 但未设置该环境变量。
- 处理：`resolveConfigPlaceholders` 已在阶段 1 处理此情况。若该阶段未报错但 apiKey 仍为空字符串，`injectProviderEnv` 不注入（允许底层 SDK 自行报错，给出更准确的错误信息）。

### 12. 清理阶段 2 占位代码

需要从 `main.ts` 中移除：

- `PreparedCliRuntimeInput` 接口定义。
- `createCliRuntime` 的旧占位实现。
- `handleRunCommand` 中的 `logWarn` "Runtime execution is not implemented in stage 2"。
- `handleRunCommand` 中的 stderr 提示与 `return 1`。

### 13. 更新 apps/cli/README.md

更新 CLI README 以反映阶段 3 完成后的能力：

- `tianji run "<prompt>"` 现在会真实调用 LLM 并流式输出响应。
- 说明运行前提：用户需要配置正确的 provider apiKey（通过环境变量或配置文件）。
- 说明 `SOUL.md` 的作用：定义 agent 行为，会被注入为 system prompt。
- 标注仍处于最小实现阶段：不支持工具调用、不支持多轮对话。

### 14. 运行 `pnpm check`

阶段 3 代码变更完成后，执行 `pnpm check` 确保：

- 无类型错误。
- 无 lint 错误。
- 无格式问题。

## 重要方法建议签名

### config.ts 新增

```ts
/**
 * 将已解析的 provider apiKey 映射到 process.env，使底层 LLM SDK 能自动读取。
 *
 * 仅处理 PROVIDER_ENV_KEY_MAP 中已知的 provider，不存在的 provider 静默跳过。
 *
 * @param context - 已加载并完成 placeholder 解析的用户配置上下文
 */
export function injectProviderEnv(context: LoadedUserConfigContext): void
```

### main.ts 变更

```ts
import {
  createSessionRuntime,
  type SessionRuntime,
} from '@tianji/runtime'
import type { AppMessage, RuntimeEvent } from '@tianji/shared'

/**
 * 根据用户配置上下文创建 deepagents session runtime。
 *
 * @param context - 已加载的用户配置上下文
 * @returns 已初始化的 SessionRuntime 实例
 */
function createCliRuntime(context: LoadedUserConfigContext): SessionRuntime

/**
 * 运行一次完整的 LLM 对话轮次，流式输出 assistant 响应文本。
 *
 * @param runtime - 已创建的 session runtime
 * @param sessionId - 目标 session ID
 * @param prompt - 用户输入的 prompt 文本
 * @param systemPrompt - 从 SOUL.md 加载的 system prompt
 * @param logger - CLI 日志记录器
 * @returns 最终退出码
 */
async function executeRunTurn(
  runtime: SessionRuntime,
  sessionId: SessionId,
  prompt: string,
  systemPrompt: string,
  logger: CliLogger
): Promise<number>
```

## 测试与校验计划

### 手工验证

由于本阶段涉及真实 LLM 调用，以下验证需要有效的 API key：

1. 设置 `OPENAI_API_KEY` 环境变量。
2. 运行 `tianji run "hi"`，预期：
   - stdout 流式输出 assistant 文本。
   - 最终输出换行，退出码 0。
   - 日志文件 `~/.config/tianji-ai/logs/cli.jsonl` 中包含完整的运行日志。
3. 不设置 API key 或设置无效 key，运行 `tianji run "hi"`，预期：
   - stderr 输出错误信息。
   - 退出码 1。
   - 日志文件中有 error 级别记录。

### 结构级校验

- `@tianji/runtime` 和 `@tianji/shared` 已正确声明为 `apps/cli` 的依赖。
- `pnpm check` 通过。
- 没有 `any` 类型。
- 所有 import 使用顶层路径。

### 代码审查要点

- runtime 创建是否正确拼接 `provider:modelName` 为 `deepagents.model`。
- `SOUL.md` 内容是否正确传入 `systemPrompt`。
- provider apiKey 注入逻辑是否安全（不覆盖已有 env，只在确实有值时写入）。
- 事件消费循环是否正确处理 `run.failed`，避免静默挂起。
- 日志中是否只记录元信息，不泄露 prompt 或 response 内容。
- 错误是否统一由 `runCli` 顶层 catch 处理，不在 handler 内直接 `process.exit`。

## 进入阶段 4 前的审查出口

- `tianji run "hi"` 是否能在配置正确时完成一次完整的 LLM 请求并输出文本。
- 运行失败时是否能给出清晰错误且退出码非零。
- 日志是否记录了完整的运行链路。
- `pnpm check` 是否通过。
- 是否没有引入任何 `any` 类型。
- 是否没有在 handler 中直接调用 `process.exit`。
