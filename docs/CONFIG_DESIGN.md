# Tianji AI 配置设计 v1

> 状态：Draft v1  
> 范围：`tianji-ai` 的详细配置机制  
> 相关文档：[`./ARCHITECTURE_V1.md`](./ARCHITECTURE_V1.md)

---

## 1. 目的

本文档定义了 `tianji-ai` 中配置是如何被**存储、加载、合并、校验与解析**的。

主架构文档仍然是以下内容的唯一事实来源：

- 归属边界
- 运行时不变量
- cancellation / snapshot truth
- delta / event 语义
- 工具路径安全规则

本文聚焦于配置的操作机制。

---

## 2. 设计原则

1. **配置以 JSON 为核心**  
   面向用户的配置存放在 JSON 文件中，而不是分散在各处的环境变量里。

2. **密钥由环境变量承载**  
   敏感值通过占位符从环境变量中注入。

3. **运行时只解析一次配置**  
   `packages/runtime` 是唯一负责合并配置层并解析占位符的组件。

4. **Schema 位于 `packages/shared`**  
   类型定义、Zod 校验 schema、迁移辅助工具以及占位符语法规则都定义在 `packages/shared` 中。

5. **CLI 负责 agent 文件资源**
   `SOUL.md` 等 agent 文件资源不属于 runtime 配置中心职责；runtime 只负责 JSON 配置，CLI 或应用层负责补充 agent 文件读取。

6. **后置层覆盖前置层**  
   覆盖行为是确定性的，并且基于字段路径进行处理。

---

## 3. 配置层

`tianji-ai` 使用三层 JSON 配置。

### 3.1 默认层

路径：

```text
开发态: <repo-root>/tianji.config.json
生产态: <runtime-package-root>/tianji.config.json
```

作用：

- Tianji 内置默认值
- 团队共享行为
- 默认 provider 配置
- 默认 agent 定义与模型路由
- 默认工具策略
- 默认 observer 设置

这是 Tianji 自带的**工厂默认**配置。

### 3.2 用户层

路径：

```text
~/.config/tianji-ai/tianji.json
```

作用：

- 用户级覆盖
- 跨仓库的个人默认值
- 偏好的 provider、UI 相关默认值、个人非敏感设置

这一层会覆盖默认层。

### 3.3 工作区层

路径：

```text
~/.config/tianji-ai/workspaces/<workspace-id>.json
```

作用：

- 工作区特定覆盖
- 仓库本地的用户行为
- 针对工具、模型或运行时设置的本地例外

这一层会同时覆盖默认层和用户层。

---

## 4. 优先级规则

从低到高的优先级顺序：

1. 默认层
2. 用户层
3. 工作区层

简写为：

> **default < user < workspace**

规则：

- 后置层会覆盖前置层中相同路径的字段
- 缺失字段会回退到更低优先级的层
- 更高优先级层中的非法配置必须直接校验失败，而不是静默回退
- 运行时必须将最终解析结果以 `ResolvedConfig` 形式暴露出来

---

## 5. 环境变量占位符

环境变量**不是第四层配置**。

它们只用于：

- API key
- token / secret
- 敏感 endpoint / 凭据
- 可选的启动参数值（例如自定义配置路径）

### 5.1 占位符语法

JSON 可以通过占位符引用环境变量值：

```json
{
  "providers": {
    "openai": {
      "apiKey": "${env:OPENAI_API_KEY}"
    }
  }
}
```

v1 语法：

- `${env:VAR_NAME}`

占位符必须**完整匹配**整个字符串值。前缀、后缀或嵌入文本中的占位符不会被解析。

正则定义（见 `packages/shared/src/config.ts`）：

```text
/^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/
```

v1 **不需要**完整的模板语言。一个明确的环境变量占位符语法就足够了。

### 5.2 解析规则

运行时会在 **JSON 合并之后、最终配置生效之前** 解析占位符。

规则：

- 未解析的占位符 => 配置错误
- 空字符串环境变量值视为显式解析值，而不是"缺失"
- 只在字符串值中解析占位符
- 解析后的敏感值不得回写到 JSON 文件
- 日志和诊断信息必须对解析后的敏感值进行脱敏

---

## 6. 运行时加载流水线

运行时加载器应执行以下流水线：

1. 读取项目配置 JSON
2. 读取用户配置 JSON
3. 读取工作区配置 JSON
4. 按优先级顺序合并（runtime 内部合并逻辑，语义与 `mergeTianjiConfigLayers` 一致）
5. 使用 Zod schema 校验合并后的原始结构（当前实现使用 `safeValidateTianjiConfig`）
6. 解析 `${env:VAR_NAME}` 占位符（`resolveConfigPlaceholders`）
7. 构建 `ResolvedConfig`
8. 将 `ResolvedConfig` 分发给 `llm`、`tools-node`、`observer` 和应用
9. CLI 或应用层基于最终配置解析默认 agent 定义与 `SOUL.md`

重要说明：

- 合并和环境变量解析必须在一个中心化加载器中完成
- 内部包不得各自独立读取配置文件或环境变量
- 运行时当前暴露的是层级快照元数据（`layers`）、解析后的路径集合（`paths`）、工作区信息（`workspace`）以及最终配置快照；字段级来源映射尚未实现

---

## 7. 工作区 ID 映射

`<workspace-id>` 应基于工作区根路径通过稳定映射生成。

要求：

- 相同工作区路径始终映射到相同 ID
- 不同工作区路径在实践中不得发生冲突
- ID 必须可安全用于文件系统

推荐模式：

- 归一化后的工作区绝对路径
- 哈希为一个稳定且简短的标识符

当前实现使用：

- 归一化后的工作区绝对路径
- `sha256(path).slice(0, 16)` 作为 `<workspace-id>`

为了便于调试，人类可读的源路径会通过 `workspace.root` 和 `workspace.normalizedRoot` 保留在元数据中。

---

## 8. 顶层配置结构

v1 配置由四个顶层字段组成：`providers`、`agents`、`runtime`、`observer`。

所有字段均为可选，以支持跨层部分配置。

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
  "runtime": {
    "retry": {
      "maxAttempts": 2,
      "baseDelayMs": 300,
      "maxDelayMs": 3000
    },
    "tool": {
      "timeoutMs": 120000,
      "maxConcurrency": 4,
      "allowDestructive": false,
      "pathPolicy": {
        "forbidDirectories": [
          ".git/",
          "node_modules/"
        ],
        "filenameDenyPatterns": [
          "^\\.env($|\\.)",
          "(^|/)id_rsa$"
        ]
      }
    }
  },
  "observer": {
    "enabled": true,
    "redactSecrets": true
  }
}
```

### 8.1 providers

顶层 `providers` 字段是一个 provider 名称到配置的映射。

每个 provider 配置至少支持 `apiKey` 字段（可使用占位符），并允许通过 `passthrough` 传入 provider 特定的额外字段（如 `baseUrl`、`headers` 等）。

Schema 定义（`packages/shared/src/config.ts`）：

```typescript
TianjiProvidersConfigSchema = z.record(z.string(), TianjiProviderConfigSchema)

TianjiProviderConfigSchema = z.object({
  apiKey: z.string().optional(),
}).passthrough()
```

### 8.2 agents

`agents` 字段定义了 agent 的集合和默认选择。

- `defaultAgent`：默认 agent 的名称，必须是 `items` 中已定义的 key
- `items`：agent 名称到 agent 配置的映射

每个 agent 配置包含：

- `model`：使用 `provider/modelName` 格式的模型引用（如 `openai/gpt-4.1`）

Agent 名称必须匹配正则 `/^[a-z0-9][a-z0-9-_]*$/`（小写字母、数字开头，可含连字符和下划线）。

模型引用规则：

- 必须包含 `/` 分隔符
- `/` 前为 provider 名称（非空）
- `/` 后为模型名称（非空），可包含嵌套路径（仅在第一个 `/` 处分割）

Schema 定义：

```typescript
TianjiAgentsConfigSchema = z.object({
  defaultAgent: z.string().refine(...).optional(),
  items: z.record(z.string(), TianjiAgentConfigSchema).optional(),
})

TianjiAgentConfigSchema = z.object({
  model: AgentModelRefSchema,
})
```

### 8.3 runtime

运行时配置包含重试策略和工具策略两个子节。

**retry**：

| 字段 | 类型 | 默认值 |
|------|------|--------|
| `maxAttempts` | `number` | `2` |
| `baseDelayMs` | `number` | `300` |
| `maxDelayMs` | `number` | `3000` |

**tool**：

| 字段 | 类型 | 默认值 |
|------|------|--------|
| `timeoutMs` | `number` | `120000` |
| `maxConcurrency` | `number` | `4` |
| `allowDestructive` | `boolean` | `false` |
| `pathPolicy.forbidDirectories` | `string[]` | `[".git/", "node_modules/"]` |
| `pathPolicy.filenameDenyPatterns` | `string[]` | `["^\\.env($|\\.)", "(^|/)id_rsa$"]` |

### 8.4 observer

| 字段 | 类型 | 默认值 |
|------|------|--------|
| `enabled` | `boolean` | `true` |
| `redactSecrets` | `boolean` | `true` |

---

## 9. Agent Soul 文件

每个 agent 可以拥有一个 `SOUL.md` 文件，定义 agent 的系统提示词或行为描述。

这一能力当前由 CLI 层实现，不属于 runtime 配置中心本身。

路径约定：

```text
<config-dir>/agents/<agent-name>/SOUL.md
```

加载规则：

- 文件必须存在且可读
- 文件内容不得为空或仅含空白字符
- 加载通过 `loadAgentSoul()` 完成，失败时抛出明确的错误

---

## 10. 合并语义

v1 合并语义当前在两处保持一致：

- `packages/shared/src/config.ts` 的 `mergeTianjiConfigLayers`
- `packages/runtime/src/config.ts` 的内部合并逻辑

两者语义一致：

- **对象字段**：深度合并
- **标量字段**：替换
- **数组**：默认整体替换
- **`undefined` 值**：不覆盖已有值

数组采用替换而不是合并的原因：

- 更容易理解
- 可避免 deny/allow 列表的意外重复
- 更容易调试最终生效配置

合并操作不会修改输入层对象（内部通过克隆实现不可变性）。

如果未来用例需要更智能的合并策略，应按字段逐项引入，而不是全局启用。

---

## 11. 校验与错误处理

### 11.1 校验机制

配置校验使用 Zod schema（定义在 `packages/shared/src/config.ts`）：

- `validateTianjiConfig(config)` — 校验并返回类型化配置，失败时抛出 `ZodError`
- `safeValidateTianjiConfig(config)` — 返回 `{ success, data?, error? }` 安全结果

### 11.2 runtime 错误模型

runtime 配置中心对外抛出 `RuntimeConfigError`，错误码包括：

- `config.parse_error`
- `config.schema_error`
- `config.placeholder_error`
- `config.env_missing`
- `config.workspace_resolution_error`

`details` 当前可能包含：

- `layer`
- `filePath`
- `fieldPath`
- `phase`
- `cause`

### 11.3 占位符错误

`ConfigPlaceholderError` 在环境变量无法解析时抛出，包含：

- `varName`：未定义的环境变量名
- `message`：人类可读的错误描述

在 runtime 中，这类错误会被包装为 `RuntimeConfigError`，通常对应 `config.env_missing`。

### 11.4 快速失败条件

以下情况必须快速失败：

- JSON 格式非法
- Zod schema 校验失败（类型错误、格式错误、agent 名称非法等）
- 占位符语法非法
- 环境变量占位符未解析
- 更高优先级配置引入了非法数据

### 11.5 诊断信息

当前实现可报告：

- 哪个文件提供了非法字段
- 字段路径
- 错误发生在 workspace 解析、JSON 解析、schema 校验或 placeholder 解析阶段
- 三层配置文件路径、是否存在以及该层原始配置快照

当前尚未实现字段级 source map，因此还不能精确追踪“最终某个字段来自哪一层覆盖”。

---

## 12. 默认配置

`packages/shared` 导出完整的默认配置常量：

```typescript
const DEFAULT_TIANJI_CONFIG: TianjiConfig = {
  providers: {
    openai: {
      apiKey: '${env:OPENAI_API_KEY}',
    },
  },
  agents: {
    defaultAgent: 'default',
    items: {
      default: {
        model: 'openai/gpt-4.1',
      },
    },
  },
  runtime: {
    retry: { maxAttempts: 2, baseDelayMs: 300, maxDelayMs: 3000 },
    tool: {
      timeoutMs: 120000,
      maxConcurrency: 4,
      allowDestructive: false,
      pathPolicy: {
        forbidDirectories: ['.git/', 'node_modules/'],
        filenameDenyPatterns: ['^\\.env($|\\.)', '(^|/)id_rsa$'],
      },
    },
  },
  observer: {
    enabled: true,
    redactSecrets: true,
  },
}
```

`createDefaultUserTianjiConfig()` 提供深拷贝的默认配置，用于首次运行初始化。

当前这个初始化动作由 CLI 在 `apps/cli/src/config.ts` 中执行，用于首次创建 `~/.config/tianji-ai/tianji.json`。

---

## 13. v1 非目标

v1 **不**打算提供：

- 动态远程配置服务
- 覆盖所有运行时的热重载
- JSON 内任意表达式语言
- 基于角色的多租户配置继承
- 分散在各包中的插件自定义配置文件

---

## 14. 总结

`tianji-ai` v1 使用：

- **三层 JSON 配置**来承载默认值与覆盖项
- **环境变量占位符**来承载敏感值
- **由 runtime 持有的解析流程**来生成最终生效配置
- **Zod schema** 来确保配置结构合法性
- **Agent 系统**通过 `provider/modelName` 引用模型

一句话概括：

> 项目默认值位于 `tianji.config.json`，用户和工作区 JSON 文件在其之上进行覆盖，最终由 runtime 统一完成合并、校验和环境变量占位符解析，并向应用暴露带层级元数据的 `ResolvedConfig`。
