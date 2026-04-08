# LocalShellBackend 默认化与配置 JSON Schema 设计文档

**日期：** 2026-04-07  
**状态：** 待实现

---

## 背景与动机

### 问题 1：默认 backend 无法操作真实文件系统

当前 deepagents 引擎的 backend 未显式配置，默认使用 `StateBackend`。这意味着 agent 创建的文件仅存在于 LangGraph 内存状态中，运行结束即丢失，无法读写宿主机磁盘，也无法执行 shell 命令。

对于编码助手场景，agent 需要：
- 读写项目目录中的文件
- 执行 shell 命令（编译、测试、git 操作等）
- 在指定的工作目录中操作

因此需要将默认 backend 切换为 `LocalShellBackend`，并允许用户通过配置指定工作目录。

### 问题 2：缺少配置 JSON Schema

当前 `tianji.json` 没有配套的 JSON Schema 文件。用户编辑配置时无法获得：
- 字段自动补全
- 类型校验
- 字段说明悬浮提示

需要创建一个标准的 JSON Schema 文件，覆盖 `TianjiConfigSchema` 的所有字段，并通过 `description` 字段提供中文注释。

---

## 需求一：LocalShellBackend 默认化

### 设计决策

| 决策项 | 选择 | 理由 |
|--------|------|------|
| backend 类型 | `LocalShellBackend` | 需要文件读写 + shell 执行能力 |
| workspace 配置层级 | per-agent（`agents.items.<name>.workspace`） | 不同 agent 可能操作不同目录 |
| 默认工作目录 | `process.cwd()` | 符合 CLI 工具直觉 |
| virtualMode | `false` | 当前场景不需要路径沙盒化 |
| initialize 时机 | `createAgentRuntime` 内异步初始化 | `LocalShellBackend.create()` 确保 rootDir 存在 |

### 配置示例

```json
{
  "agents": {
    "items": {
      "default": {
        "model": "openai/glm-latest",
        "workspace": "/home/cby/projects/my-app"
      }
    }
  }
}
```

不配置 `workspace` 时默认为 `process.cwd()`。

### 改动文件清单

#### 1. `packages/shared/src/config.ts`

**改动**：`TianjiAgentConfigSchema` 增加 `workspace` 可选字段。

```typescript
export const TianjiAgentConfigSchema = z
  .object({
    model: AgentModelRefSchema.optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    workspace: z.string().optional(),  // 新增
  })
  .refine((data) => data.model !== undefined || data.command !== undefined, {
    message: 'Agent must have at least one of "model" or "command"',
  })
```

#### 2. `packages/agent/src/context.ts`

**改动**：`AgentContext` 增加 `workspace` 字段，`loadAgentContext` 负责读取。

```typescript
export interface AgentContext {
  readonly agentName: string
  readonly modelRef: string
  readonly provider: string
  readonly modelName: string
  readonly providerConfig: TianjiProviderConfig | undefined
  readonly soulPath: string
  readonly soul: string
  readonly workspace: string | undefined  // 新增
}
```

在 `loadAgentContext` 函数中，从 `TianjiAgentConfig` 读取 `workspace` 字段并透传到 `AgentContext`。

#### 3. `packages/agent/src/session.ts`

**改动**：`createAgentRuntime` 从同步改为异步，创建 `LocalShellBackend` 实例并传入 deepagents 配置。

```typescript
import { LocalShellBackend } from 'deepagents'

export async function createAgentRuntime(context: LoadedAgentContext): Promise<SessionRuntime> {
  injectProviderEnv(context)

  const backend = await LocalShellBackend.create({
    rootDir: context.agent.workspace ?? process.cwd(),
    inheritEnv: true,
  })

  return createSessionRuntime({
    deepagents: {
      model: `${context.agent.provider}:${context.agent.modelName}`,
      providerConfig: { ... },
      backend,
    },
    snapshotStore: context.snapshotStore,
  })
}
```

关键参数说明：
- `rootDir`：从 `AgentContext.workspace` 读取，默认 `process.cwd()`
- `inheritEnv: true`：继承当前进程环境变量，确保 agent 执行 shell 命令时能访问 PATH、HOME 等

#### 4. 调用方适配

`createAgentRuntime` 变为异步后，所有调用方需要 `await`：

- `packages/agent/src/session.ts` — `createAgentSession` 内部调用处
- `apps/node/src/__tests__/helpers/cli-test-utils.ts` — 测试辅助函数
- 其他引用 `createAgentRuntime` 的位置

#### 5. `packages/runtime/src/engines/deepagents-engine.ts`

**无需改动**。`resolveDeepagentsBackend` 已能正确透传非 null、非占位的真实 backend 对象。

### 安全考量

`LocalShellBackend` 赋予 agent 完整的宿主机访问权限。当前安全边界依赖：

1. **ToolCatalog 白名单**：runtime 只注册了允许的工具
2. **ExecutionPolicy**：`allowDestructive` 控制破坏性操作
3. **PathPolicy**：`forbidDirectories` 和 `filenameDenyPatterns` 限制文件访问范围

这些策略在 `executeDeepagentsToolCall` 中由 runtime 统一执行，不受 backend 切换影响。但需要注意，deepagents 内置的 `execute` 工具（shell 命令执行）不受 PathPolicy 约束，agent 可以通过 shell 命令绕过文件路径限制。

---

## 需求二：配置 JSON Schema

### 设计决策

| 决策项 | 选择 | 理由 |
|--------|------|------|
| Schema 标准 | JSON Schema draft-07 | 广泛支持，VS Code 原生兼容 |
| 文件位置 | `packages/shared/schemas/tianji-config.schema.json` | 跟随 schema 源定义所在的包 |
| 注释方式 | `description` 字段（中文） | 标准 JSON Schema 机制，IDE 悬浮提示 |
| 维护方式 | 自动生成 + 中文注释覆盖 | 结构由 Zod schema 驱动，注释集中维护 |

### 自动生成方案

利用已有的 `zod-to-json-schema@3.25.1`（项目间接依赖）从 `TianjiConfigSchema` 自动生成 JSON Schema 结构，再叠加一份中文 description map 覆盖字段说明。

#### 文件结构

```
packages/shared/
├── schemas/
│   └── tianji-config.schema.json       # 生成产物，git 提交
├── scripts/
│   └── generate-config-schema.ts       # 生成脚本
└── src/
    └── config.ts                       # Zod schema（唯一真相源）
```

#### 生成脚本设计 — `packages/shared/scripts/generate-config-schema.ts`

```typescript
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { TianjiConfigSchema } from '../src/config.js'

// 1. 从 Zod schema 生成 JSON Schema 结构
const base = zodToJsonSchema(TianjiConfigSchema, {
  name: 'TianjiConfig',
  $refStrategy: 'none',     // 内联所有引用，不生成 $ref
  target: 'jsonSchema7',
})

// 2. 中文注释 map，key 为 JSON pointer 路径
const descriptions: Record<string, string> = {
  '': '天机 AI 配置文件。支持三层配置合并：默认 < 用户 < 工作区',
  '/properties/locale':
    '界面语言。可选值：en, zh-CN',
  '/properties/providers':
    'LLM 提供商连接配置。key 为提供商名称（如 openai），value 包含 apiKey 等连接参数。支持 ${env:VAR_NAME} 占位符引用环境变量',
  '/properties/agents':
    'Agent 定义集合',
  '/properties/agents/properties/defaultAgent':
    '默认 agent 名称，必须在 items 中有对应定义。默认值：default',
  '/properties/agents/properties/items':
    'Agent 配置项。key 为 agent 名称（小写字母、数字、连字符、下划线），value 为该 agent 的配置',
  // ... agent 子字段
  '/properties/agents/properties/items/additionalProperties/properties/model':
    '模型引用，格式为 provider/modelName（如 openai/gpt-4.1）。原生 agent 必填',
  '/properties/agents/properties/items/additionalProperties/properties/command':
    '执行命令。原生 agent 默认为 tianji-agent，外部 agent 填写对应命令（如 claude、codex）',
  '/properties/agents/properties/items/additionalProperties/properties/args':
    '命令行参数数组',
  '/properties/agents/properties/items/additionalProperties/properties/env':
    '环境变量键值对，会注入到 agent 运行环境中',
  '/properties/agents/properties/items/additionalProperties/properties/workspace':
    'Agent 的工作目录。deepagents 在此目录下执行文件操作和 shell 命令。默认为 process.cwd()',
  // ... runtime 子字段
  '/properties/runtime':
    '运行时配置',
  '/properties/runtime/properties/retry':
    '重试策略配置',
  '/properties/runtime/properties/retry/properties/maxAttempts':
    '最大重试次数。默认值：2',
  '/properties/runtime/properties/retry/properties/baseDelayMs':
    '基础重试延迟（毫秒）。默认值：300',
  '/properties/runtime/properties/retry/properties/maxDelayMs':
    '最大重试延迟（毫秒）。默认值：3000',
  '/properties/runtime/properties/tool':
    '工具执行策略配置',
  '/properties/runtime/properties/tool/properties/timeoutMs':
    '单次工具执行超时时间（毫秒）。默认值：120000',
  '/properties/runtime/properties/tool/properties/maxConcurrency':
    '工具最大并发数。默认值：4',
  '/properties/runtime/properties/tool/properties/allowDestructive':
    '是否允许执行破坏性操作。默认值：false',
  '/properties/runtime/properties/tool/properties/pathPolicy':
    '路径安全策略',
  '/properties/runtime/properties/tool/properties/pathPolicy/properties/forbidDirectories':
    '禁止访问的目录列表。默认值：[".git/", "node_modules/"]',
  '/properties/runtime/properties/tool/properties/pathPolicy/properties/filenameDenyPatterns':
    '禁止访问的文件名正则列表。默认拒绝 .env 文件和 SSH 密钥',
  // ... observer / controlPlane
  '/properties/observer':
    '可观测性配置',
  '/properties/observer/properties/enabled':
    '是否启用观测日志。默认值：true',
  '/properties/observer/properties/redactSecrets':
    '日志中是否脱敏敏感信息。默认值：true',
  '/properties/controlPlane':
    '控制面连接配置。配置后节点会注册到控制面并接受任务下发',
  '/properties/controlPlane/properties/baseUrl':
    '控制面服务地址',
  '/properties/controlPlane/properties/enrollmentToken':
    '节点注册令牌',
  '/properties/controlPlane/properties/nodeId':
    '节点唯一标识',
  '/properties/controlPlane/properties/hostname':
    '节点主机名。可选，默认自动检测',
  '/properties/controlPlane/properties/platform':
    '节点操作系统平台。可选，默认自动检测',
  '/properties/controlPlane/properties/version':
    '节点版本号。可选',
}

// 3. 递归注入 description
function applyDescriptions(schema: Record<string, unknown>, pointer: string): void {
  if (descriptions[pointer] !== undefined) {
    schema.description = descriptions[pointer]
  }
  if (typeof schema.properties === 'object' && schema.properties !== null) {
    for (const [key, value] of Object.entries(schema.properties)) {
      if (typeof value === 'object' && value !== null) {
        applyDescriptions(value as Record<string, unknown>, `${pointer}/properties/${key}`)
      }
    }
  }
  // additionalProperties（用于 record 类型如 providers、agents.items）
  if (typeof schema.additionalProperties === 'object' && schema.additionalProperties !== null) {
    applyDescriptions(
      schema.additionalProperties as Record<string, unknown>,
      `${pointer}/additionalProperties`
    )
  }
}

applyDescriptions(base as Record<string, unknown>, '')

// 4. 写入文件
const outputPath = resolve(import.meta.dirname, '../schemas/tianji-config.schema.json')
writeFileSync(outputPath, JSON.stringify(base, null, 2) + '\n', 'utf8')
```

#### npm script

在 `packages/shared/package.json` 中添加：

```json
{
  "scripts": {
    "generate:schema": "tsx scripts/generate-config-schema.ts"
  }
}
```

#### 新鲜度校验（可选）

在 CI 或 `pnpm check` 中添加校验步骤，确保生成产物与 Zod schema 同步：

```bash
pnpm --filter @tianji/shared generate:schema
git diff --exit-code packages/shared/schemas/tianji-config.schema.json
```

如果有 diff 说明 Zod schema 改了但忘了重新生成，CI 报错提醒。

### 用户使用方式

在 `tianji.json` 顶部添加：

```json
{
  "$schema": "./path/to/tianji-config.schema.json",
  ...
}
```

或者通过 VS Code settings 将 `tianji.json` 关联到 schema：

```json
{
  "json.schemas": [
    {
      "fileMatch": ["**/tianji.json", "**/*.tianji.json"],
      "url": "./packages/shared/schemas/tianji-config.schema.json"
    }
  ]
}
```

---

## 实现顺序

```
步骤 1: packages/shared/src/config.ts
        TianjiAgentConfigSchema 添加 workspace 字段
            ↓
步骤 2: packages/agent/src/context.ts
        AgentContext 添加 workspace 字段
        loadAgentContext 读取并透传
            ↓
步骤 3: packages/agent/src/session.ts
        createAgentRuntime 改为异步
        创建 LocalShellBackend 实例
        传入 deepagents 配置
            ↓
步骤 4: 调用方适配
        所有 createAgentRuntime 调用处改为 await
            ↓
步骤 5: packages/shared/scripts/generate-config-schema.ts
        创建自动生成脚本（zod-to-json-schema + 中文 description map）
        生成 packages/shared/schemas/tianji-config.schema.json
        添加 generate:schema npm script
            ↓
步骤 6: 测试与验证
        pnpm check 通过
        现有测试回归通过
        生成产物新鲜度校验通过
```

---

## 不做的事情

- **不添加 virtualMode 支持**：当前场景不需要路径沙盒化，避免过度设计。
- **不添加 runtime 级 workspace 配置**：只在 agent 级配置，保持简单。
- **不修改 `resolveDeepagentsBackend`**：已能正确处理真实 backend 对象。
