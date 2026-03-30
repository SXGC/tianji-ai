# @tianji/shared

`tianji-ai` 的共享工具与配置模型包。

## 包职责

`@tianji/shared` 提供不属于契约层或运行时层的跨包基础能力。当前主要聚焦配置 schema 校验、`${env:VAR_NAME}` 环境变量占位符解析、默认配置值、agent 配置辅助方法，以及少量通用工具函数。

该包不依赖其他内部 `@tianji/*` 包，因此既可以被基础设施代码复用，也可以被更靠近应用层的模块安全依赖。

## 当前公开内容

- 占位符相关工具：`ENV_PLACEHOLDER_PATTERN`、`isEnvPlaceholder`、`extractEnvVarName`、`resolveEnvPlaceholder`、`resolveConfigPlaceholders`
- 占位符错误与解析器类型：`ConfigPlaceholderError`、`EnvResolver`、`ResolvedConfigResult`
- 配置相关的 Zod schema 与类型：`TianjiProviderConfigSchema`、`TianjiAgentConfigSchema`、`TianjiAgentsConfigSchema`、`RuntimeConfigSchema`、`ObserverConfigSchema`、`TianjiConfigSchema`
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
