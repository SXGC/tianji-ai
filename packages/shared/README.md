# @tianji/shared

`tianji-ai` 的共享工具与配置模型包。

## 包职责

`@tianji/shared` 提供不属于契约层或运行时层的跨包基础能力。当前主要聚焦配置 schema 校验、`${env:VAR_NAME}` 环境变量占位符解析、默认配置值、provider 与 agent 配置辅助方法，以及少量通用工具函数。

该包不依赖其他内部 `@tianji/*` 包，因此既可以被基础设施代码复用，也可以被更靠近应用层的模块安全依赖。

## 当前公开内容

- 占位符相关工具：`ENV_PLACEHOLDER_PATTERN`、`isEnvPlaceholder`、`extractEnvVarName`、`resolveEnvPlaceholder`、`resolveConfigPlaceholders`
- 占位符错误与解析器类型：`ConfigPlaceholderError`、`EnvResolver`、`ResolvedConfigResult`
- 配置相关的 Zod schema 与类型：`TianjiProviderConfigSchema`、`TianjiProvidersConfigSchema`、`AgentModelRefSchema`、`TianjiAgentConfigSchema`、`TianjiAgentsConfigSchema`、`RuntimeConfigSchema`、`ObserverConfigSchema`、`TianjiConfigSchema`
- 配置校验辅助：`validateTianjiConfig`、`safeValidateTianjiConfig`
- 默认配置值：`DEFAULT_PROVIDERS_CONFIG`、`DEFAULT_AGENT_CONFIG`、`DEFAULT_AGENTS_CONFIG`、`DEFAULT_RETRY_CONFIG`、`DEFAULT_TOOL_CONFIG`、`DEFAULT_RUNTIME_CONFIG`、`DEFAULT_OBSERVER_CONFIG`、`DEFAULT_TIANJI_CONFIG`
- agent 相关 helper：`createDefaultUserTianjiConfig`、`parseAgentModelRef`、`getDefaultAgentDefinition`、`getAgentSoulPath`、`loadAgentSoul`
- 通用工具函数：`deepClone`、`sleep`、`retry`、`DEFAULT_RETRY_OPTIONS`

## 使用示例

```ts
import {
  createDefaultUserTianjiConfig,
  getDefaultAgentDefinition,
  getAgentSoulPath,
  resolveConfigPlaceholders,
  validateTianjiConfig,
} from '@tianji/shared'

const parsed = validateTianjiConfig(
  createDefaultUserTianjiConfig()
)

const resolved = resolveConfigPlaceholders({
  ...parsed,
  providers: {
    ...parsed.providers,
    openai: {
      ...parsed.providers?.openai,
      apiKey: '${env:OPENAI_API_KEY}',
    },
  },
})

const { agentName, agent } = getDefaultAgentDefinition(resolved.config)
const soulPath = getAgentSoulPath('/path/to/.tianji', agentName)

void agent
void soulPath
```

`SOUL.md` 不存放在 JSON 配置内。应用层应自行维护配置目录下的 `agents/<agentName>/SOUL.md`，并通过 `getAgentSoulPath()` 与 `loadAgentSoul()` 统一处理路径与读取逻辑。

## 配置结构

`TianjiConfig` 的核心字段：

- `providers`：provider 连接信息映射。key 为 provider 名称，例如 `openai`；value 为 `apiKey`、`baseUrl` 或其他 provider 自定义字段。字符串值支持 `${env:VAR_NAME}` 占位符。
- `agents`：agent 集合配置，包含 `defaultAgent` 和 `items`。
- `agents.defaultAgent`：默认 agent 名称。
- `agents.items.<name>.model`：`provider/modelName` 格式，只按第一个 `/` 切分，因此模型名本身可以包含 `/`。
- `runtime`：运行时配置，例如 `retry`、`tool`。
- `observer`：观察者配置，例如 `enabled`、`redactSecrets`。

其中 `providers` 负责声明连接信息，`agents` 负责声明“用哪个 provider/model 运行哪个 agent”，二者解耦，便于多个 agent 复用同一 provider 配置。

## 事件系统

tianji-ai 使用 Core / Integration / Protocol 三层事件架构：
- Core：聚合根发射纯 DomainEvent（PascalCase，如 `RunStarted`）。
- Integration：统一 `DomainEventEnvelope` 信封，`correlationId + causationId + sequence` 三件套。
- Protocol：AG-UI / ACP / Daemon SSE / OTel / Observer 都是 EventBus 订阅者。

旧 `RuntimeEvent` / `TaskEvent` 已移除。详见 `docs/superpowers/specs/2026-04-14-event-bus-design.md`。

## 开发命令

在仓库根目录执行：

```bash
pnpm --filter @tianji/shared build
pnpm --filter @tianji/shared typecheck
pnpm --filter @tianji/shared test
pnpm --filter @tianji/shared clean
```

## 开源协议

MIT
