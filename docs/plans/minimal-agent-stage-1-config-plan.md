# Minimal Agent 阶段 1 详细计划

完整计划在 minimal-agent-implementation.md 中

## 阶段目标

在 `packages/shared` 内完成最小 agent 配置模型扩展，把当前以 `llm` 为中心的 provider 配置收敛为顶层 `providers`，并补齐 `agents`、`SOUL.md` 路径与默认 agent 解析相关 helper，为后续 CLI 落地提供稳定输入。

本阶段只解决“配置表达与配置读取辅助能力”，不负责 CLI 命令实现、不负责 runtime 执行、不负责日志落盘。

## 完成定义

当以下条件同时满足时，阶段 1 视为完成：

- `TianjiConfigSchema` 能表达顶层 `providers` 与 `agents`。
- 默认配置工厂能返回可直接写入用户目录的最小配置对象。
- `getDefaultAgentDefinition()`、`parseAgentModelRef()`、`getAgentSoulPath()`、`loadAgentSoul()` 具备明确行为与错误语义。
- `packages/shared/src/index.ts` 对外导出新增 schema、类型、常量与 helper。
- `packages/shared/src/__tests__/config.test.ts` 覆盖默认配置、模型引用解析、默认 agent 获取与 `SOUL.md` 加载相关分支。
- `packages/shared/README.md` 与新的配置模型保持一致。

## 目标文件

- `packages/shared/src/config.ts`
- `packages/shared/src/index.ts`
- `packages/shared/src/__tests__/config.test.ts`
- `packages/shared/README.md`

## 关键定义

### 配置结构定义

目标配置结构收敛为：

```json
{
  "providers": {
    "openai": {
      "apiKey": "${env:OPENAI_API_KEY}"
    }
  },
  "agents": {
    "defaultAgent": "default",
    "items": {
      "default": {
        "model": "openai/gpt-4.1"
      }
    }
  },
  "runtime": {},
  "observer": {}
}
```

### 需要新增或调整的类型

- `TianjiProviderConfigSchema`：单个 provider 的连接配置，保留 `.passthrough()` 以兼容 provider 私有字段。
- `TianjiProvidersConfigSchema`：`Record<string, TianjiProviderConfig>`。
- `AgentModelRefSchema`：校验 `provider/modelName` 的字符串表达，但仅做最小结构校验，不负责 provider 是否存在。
- `TianjiAgentConfigSchema`：单个 agent 配置，至少包含 `model`。
- `TianjiAgentsConfigSchema`：包含 `defaultAgent` 与 `items`。
- `TianjiConfigSchema`：从 `llm` 切换为顶层 `providers` + `agents`，保留 `runtime`、`observer`。

### 需要新增的常量

- `DEFAULT_PROVIDERS_CONFIG`
- `DEFAULT_AGENT_CONFIG`
- `DEFAULT_AGENTS_CONFIG`
- `DEFAULT_TIANJI_CONFIG`：更新为新结构

### 需要新增的重要方法

- `createDefaultUserTianjiConfig(): TianjiConfig`
  - 生成面向用户目录写盘的最小默认配置。
  - 必须内置默认 agent 与默认 provider 引用。
- `parseAgentModelRef(modelRef: string): { provider: string; modelName: string }`
  - 只按第一个 `/` 切分。
  - provider 为空、modelName 为空、缺失 `/` 时直接抛出明确错误。
- `getDefaultAgentDefinition(config: TianjiConfig): { agentName: string; agent: TianjiAgentConfig }`
  - 统一处理 `agents.defaultAgent` 缺失、`agents.items` 缺失、默认项不存在等错误。
- `getAgentSoulPath(configDir: string, agentName: string): string`
  - 只负责路径拼装，不读取文件。
- `loadAgentSoul(filePath: string): Promise<string>`
  - 校验文件存在、可读、非空。
  - 不允许空字符串或仅空白内容。

## 业务逻辑约束

- agent 名称必须匹配安全文件名规则：`^[a-z0-9][a-z0-9-_]*$`。
- schema 只校验 JSON 结构；`SOUL.md` 的存在性与内容合法性由 helper 负责。
- `model` 的 provider 引用解析只拆第一段，保证未来模型名可包含 `/`。
- `providers` 与 `agents.items` 的“引用存在性”校验不放到 Zod schema 内做隐式联动，统一留给读取 helper 或 CLI loader 做显式错误。
- `${env:VAR}` 占位符解析逻辑继续沿用现有 `resolveConfigPlaceholders()`，不在本阶段改动行为。

## 详细 TODO

### 1. 盘点并重构现有配置命名

- 阅读 `packages/shared/src/config.ts` 现有 `LlmProviderConfigSchema`、`LlmProvidersConfigSchema`、`LlmConfigSchema` 的职责边界。
- 决定保留还是移除 `llm` 顶层结构；按当前主计划，目标是直接切换到顶层 `providers`，避免 CLI 同时兼容两套来源。
- 明确 `runtime`、`observer` 默认值保持不变，避免阶段 1 引入无关行为漂移。
- 梳理需要替换的导出名，防止 `index.ts` 仍暴露旧命名导致调用方混用。

### 2. 在 `packages/shared/src/config.ts` 扩展 schema 与类型

- 新增 `AGENT_NAME_PATTERN` 常量，供 agent 名称校验复用。
- 新增 `AgentModelRefSchema`，约束 `provider/modelName` 最小格式。
- 新增 `TianjiProviderConfigSchema` 与 `TianjiProvidersConfigSchema`。
- 新增 `TianjiAgentConfigSchema` 与 `TianjiAgentsConfigSchema`。
- 更新 `TianjiConfigSchema`：删除或下沉原 `llm` 结构，改为顶层 `providers`、`agents`、`runtime`、`observer`。
- 更新 `TianjiConfig`、相关 `z.infer` 类型，以及 `validateTianjiConfig()` / `safeValidateTianjiConfig()` 返回值。

### 3. 在 `packages/shared/src/config.ts` 增加默认配置工厂与 helper

- 定义 `DEFAULT_PROVIDERS_CONFIG`，至少提供 `openai.apiKey = ${env:OPENAI_API_KEY}`。
- 定义 `DEFAULT_AGENT_CONFIG`，至少提供 `model = openai/gpt-4.1`。
- 定义 `DEFAULT_AGENTS_CONFIG`，固定 `defaultAgent = default`，并在 `items.default` 使用 `DEFAULT_AGENT_CONFIG`。
- 更新 `DEFAULT_TIANJI_CONFIG`，组合 `providers`、`agents`、`runtime`、`observer`。
- 新增 `createDefaultUserTianjiConfig()`，返回适合首次初始化写盘的对象；避免调用方直接复用共享常量后发生引用污染。
- 新增 `parseAgentModelRef()`，集中处理模型引用解析错误。
- 新增 `getDefaultAgentDefinition()`，统一返回默认 agent 名称与定义对象。
- 新增 `getAgentSoulPath()`，固定产出 `agents/<name>/SOUL.md`。
- 新增 `loadAgentSoul()`，使用 Node 文件 API 读取并校验文件文本。

### 4. 明确错误模型与报错文案

- 统一 helper 抛出 `Error` 还是新增 `ConfigError` 类；若不新增类型，至少保证 message 可直接被 CLI 透传。
- `parseAgentModelRef()` 报错要包含配置字段语义，例如指出 `agents.items.<name>.model` 必须符合 `provider/modelName`。
- `getDefaultAgentDefinition()` 报错要区分两类问题：
  - `agents.defaultAgent` 缺失。
  - `agents.items[defaultAgent]` 不存在。
- `loadAgentSoul()` 报错要区分三类问题：
  - 文件不存在。
  - 文件不可读。
  - 文件为空。

### 5. 更新 `packages/shared/src/index.ts` 导出面

- 删除旧 `Llm*` 导出，或在确认没有内部调用方依赖时完成命名替换。
- 导出新增 schema、类型、默认值与 helper。
- 检查导出顺序与分组，保持 `config.ts` 的可发现性。
- 确保后续 `apps/cli` 只通过顶层入口 import，不依赖深层路径。

### 6. 补齐单元测试

- 更新已有 `config.test.ts`，将示例配置从 `llm.providers` 迁移为顶层 `providers`。
- 新增默认配置测试：`DEFAULT_TIANJI_CONFIG` 与 `createDefaultUserTianjiConfig()` 都能通过 schema。
- 新增 `parseAgentModelRef()` 测试：
  - 正常解析 `openai/gpt-4.1`
  - 仅按第一个 `/` 切分 `openai/responses/gpt-4.1`
  - provider 为空
  - modelName 为空
  - 缺失 `/`
- 新增 `getDefaultAgentDefinition()` 测试：
  - 正常返回默认 agent
  - 缺失 `agents.defaultAgent`
  - `items` 缺失默认项
- 新增 `getAgentSoulPath()` 测试，验证路径拼装结果。
- 新增 `loadAgentSoul()` 测试：
  - 正常读取文本
  - 空文件失败
  - 文件不存在失败

### 7. 更新文档

- 更新 `packages/shared/README.md` 的配置示例，从 `llm` 迁移到顶层 `providers` + `agents`。
- 说明 `SOUL.md` 不存放在 JSON 内，而是由应用层目录约定管理。
- 列出新增 helper 的用途，方便 CLI 阶段直接复用。

## 实施顺序建议

1. 先改 schema 与类型，再改默认配置常量。
2. 再补 helper，避免 helper 先依赖不稳定类型。
3. 然后改 `index.ts` 导出面。
4. 最后统一修测试与 README，确保对外表述与代码一致。

## 测试清单

### 单元测试

- `packages/shared/src/__tests__/config.test.ts` 全量通过。
- 新增 helper 的正常路径与异常路径全部覆盖。
- 占位符解析旧行为不回归，至少保留现有 `${env:VAR}` 测试集。

### 回归检查

- `DEFAULT_RUNTIME_CONFIG`、`DEFAULT_OBSERVER_CONFIG` 默认值不变。
- `resolveConfigPlaceholders()` 仍能处理顶层 `providers` 中的 `apiKey` 占位符。
- `index.ts` 的导出路径可以支持 `@tianji/shared` 顶层 import。

### 手工审查

- 审查 schema 命名是否统一使用 `Tianji*` 前缀。
- 审查是否残留旧 `llm` 结构说明、测试或 README 片段。
- 审查 helper 的错误文案是否足够让 CLI 直接透传给用户。
- 审查 `loadAgentSoul()` 是否只返回文本，不混入 CLI 语义。

## 审查出口

在进入阶段 2 之前，必须确认以下审查问题都已回答：

- CLI 是否已经可以仅依赖 `@tianji/shared` 顶层导出拿到默认 agent 与模型解析能力。
- 配置结构是否足够表达“默认 agent -> provider/model -> provider 凭据”这一条链路。
- 所有错误是否都在配置层被尽量前置，而不是把问题延迟到 runtime 创建阶段。
- README 是否已经描述新结构，避免阶段 2 按旧结构继续开发。
