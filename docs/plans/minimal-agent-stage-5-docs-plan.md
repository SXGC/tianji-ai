# Minimal Agent 阶段 5 详细计划：文档更新

## 阶段目标

更新三个 README 文件，使其准确反映阶段 1-4 完成后的实际能力。去掉所有"阶段性骨架"、"尚未接入"、"未完成"等措辞，补充 CLI 用法、配置文件位置、agent 目录结构、日志查看方法等用户指南内容。

## 完成定义

- 三个 README 中不再包含"阶段"、"骨架"、"尚未实现"、"未完成"等未就绪措辞。
- CLI 命令用法、配置文件位置、agent 目录规则、日志位置均有明确说明。
- 错误场景在 `apps/cli/README.md` 中有列举。
- 文档内容与实际代码一致（配置结构、导出 API、命令参数、文件路径等）。

## 目标文件

- `apps/cli/README.md`（重写，变动最大）
- `packages/shared/README.md`（小范围补充）
- `README.md`（根目录，中等变动）

## 5.1 重写 `apps/cli/README.md`

当前问题：内容定位在"阶段 2 骨架"，包含多处"尚未接入"、"阶段 2 能力边界"等未完成描述。需要从骨架文档重写为完整用户文档。

### 目标结构

#### 1. 包简介

一句话说明 `@tianji/cli` 是 tianji-ai 的命令行入口，提供 `run` 和 `log` 两个命令。

#### 2. 安装与运行

- 说明在 monorepo 内通过 `pnpm --filter @tianji/cli build` 构建
- 说明通过 `pnpm exec tianji` 或 `npx tianji`（链接后）运行
- 根 `package.json` 中 `bin.tianji` 指向关系

#### 3. 命令用法

**`tianji run "<prompt>"`**

- 发送 prompt 给默认 agent，输出模型响应文本
- 首次运行时自动创建默认配置文件和 `SOUL.md`
- 运行失败时非零退出码：usage 错误为 2，运行时错误为 1

**`tianji log -f`（或 `--follow`）**

- 实时查看 JSONL 日志流
- 先输出已有日志，再持续 follow 新增内容
- 对 JSONL 做人类可读格式化输出

示例输出：

```text
[2026-03-25T10:00:00.000Z] INFO cli.run: Loaded user config {"agentName":"default","model":"openai/gpt-4.1"}
[2026-03-25T10:00:01.200Z] INFO cli.runtime: Session runtime created
[2026-03-25T10:00:02.100Z] INFO cli.event: message.delta
```

#### 4. 配置文件位置

| 路径 | 说明 |
|---|---|
| `~/.config/tianji-ai/tianji.json` | 主配置文件 |
| `~/.config/tianji-ai/agents/<agent-name>/SOUL.md` | agent 身份定义 |
| `~/.config/tianji-ai/logs/cli.jsonl` | 日志落盘文件 |

#### 5. 配置文件结构

说明 `tianji.json` 的核心字段：

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
  }
}
```

字段说明：

- `providers.<name>`：声明 provider 连接信息，例如 `apiKey`、自定义 endpoint 等。支持 `${env:VAR_NAME}` 占位符。
- `agents.defaultAgent`：默认 agent 名称，对应 `agents.items` 中的一个 key。
- `agents.items.<name>.model`：使用 `provider/modelName` 格式引用模型。只按第一个 `/` 切分，模型名自身可包含 `/`。
- 占位符解析：所有字符串值中的 `${env:VAR_NAME}` 会在运行时替换为对应环境变量值，未设置的变量会导致报错。

#### 6. Agent 目录规则

- agent 名称必须匹配 `^[a-z0-9][a-z0-9-_]*$`。
- 每个 agent 的 `SOUL.md` 位于 `~/.config/tianji-ai/agents/<agent-name>/SOUL.md`。
- `SOUL.md` 定义 agent 的价值观、边界与协作关系，运行时映射为 `systemPrompt`。
- `SOUL.md` 必须存在且非空，缺失或空文件会导致报错，不允许静默回退到内联默认 prompt。
- 首次运行时自动创建默认 agent 的 `SOUL.md`。

#### 7. 日志系统

**日志格式**：JSONL，每行一条 JSON，字段：

```json
{
  "timestamp": "2026-03-25T10:00:00.000Z",
  "level": "info",
  "scope": "cli.run",
  "message": "Loaded user config",
  "data": { "agentName": "default" }
}
```

**scope 分层**：

| scope | 说明 |
|---|---|
| `cli.run` | run 命令主流程 |
| `cli.config` | 配置加载与解析 |
| `cli.runtime` | runtime 创建与启动 |
| `cli.event` | runtime 事件消费 |
| `cli.log` | log follow 主流程 |

**约束**：日志只记录 `agentName`、`model`、`soulPath` 等元数据，不记录 `SOUL.md` 正文。

#### 8. 错误处理

| 场景 | 行为 |
|---|---|
| 配置文件不存在 | 自动创建默认配置与 `SOUL.md`，提示用户 |
| 配置文件 JSON 解析失败 | 报错退出，输出解析错误 |
| 配置 schema 不合法 | 报错退出，输出校验错误路径 |
| 缺失 `agents.defaultAgent` | 报错：`Missing agents.defaultAgent in Tianji config` |
| `agents.items` 中无默认 agent 对应项 | 报错：`Default agent "<name>" is not defined in agents.items` |
| `model` 格式非法 | 报错：必须符合 `provider/modelName` 格式 |
| provider 未在 `providers` 中声明 | 报错：引用的 provider 未声明 |
| `SOUL.md` 缺失 | 报错：`Agent soul file does not exist: <path>` |
| `SOUL.md` 为空 | 报错：`Agent soul file is empty: <path>` |
| 环境变量未设置 | 占位符解析阶段报错：`Environment variable "<name>" is not defined` |
| LLM 请求失败 | 透传为 CLI 运行错误，写入日志，非零退出 |

#### 9. 目录结构

```text
apps/cli/
├─ bin/
│  └─ tianji.mjs
├─ src/
│  ├─ bin.ts
│  ├─ config.ts
│  ├─ log-follow.ts
│  ├─ logger.ts
│  └─ main.ts
├─ package.json
├─ README.md
└─ tsconfig.json
```

#### 10. 开发命令

```bash
pnpm --filter @tianji/cli build
pnpm --filter @tianji/cli typecheck
pnpm --filter @tianji/cli clean
```

#### 11. 依赖关系

- `@tianji/shared`：配置 schema、agent helper、占位符解析、通用工具
- `@tianji/runtime`：session runtime 创建、runTurn、事件流
- `@tianji/contracts`：运行时协议类型

#### 12. 许可证

MIT

---

## 5.2 更新 `packages/shared/README.md`

当前问题：内容已较新，但缺少 `providers` 配置用途说明和完整配置结构描述。

### 修改内容

#### 1. 更新"当前公开内容"

当前已列出 `TianjiProvidersConfigSchema` 等所有 schema 和 helper，列表无需变动。在段落描述中补充 providers 的用途说明。

将"配置相关的 Zod schema 与类型"相关段落修改为更完整的描述，包含：

- `providers`：顶层 provider 连接声明
- `agents`：agent 集合与默认 agent
- `model` 引用格式 `provider/modelName`
- 占位符解析支持

#### 2. 新增"配置结构"段落

在"使用示例"之后新增一节：

```markdown
## 配置结构

`TianjiConfig` 的核心字段：

- `providers`：provider 连接信息映射。key 为 provider 名称（如 `openai`），value 为 `apiKey` 等连接配置。值支持 `${env:VAR_NAME}` 占位符。
- `agents`：agent 集合，包含：
  - `defaultAgent`：默认 agent 名称
  - `items`：agent 配置映射，每个 agent 至少包含 `model` 字段
- `agents.items.<name>.model`：`provider/modelName` 格式，只按第一个 `/` 切分
- `runtime`：运行时重试、工具等配置
- `observer`：观察者配置
```

#### 3. 更新使用示例

当前示例已包含 `createDefaultUserTianjiConfig`、`getDefaultAgentDefinition` 等。确认示例代码与实际 API 一致即可，无需大幅修改。

---

## 5.3 更新根目录 `README.md`

当前问题：
- "核心包说明"缺少 CLI 应用说明。
- "当前状态说明"包含"阶段性的 `apps/cli` 目录作为最小 CLI 应用骨架"、"真实 runtime 执行链路仍会在后续阶段继续补全"等措辞。
- 缺少 CLI 用法段落。

### 修改内容

#### 1. 新增 CLI 应用段落

在"核心包说明"的 `@tianji/runtime` 之后新增：

```markdown
### `@tianji/cli`

命令行应用，提供 `tianji run "<prompt>"` 和 `tianji log -f` 两个命令。首次运行时自动在 `~/.config/tianji-ai/` 下创建默认配置文件 `tianji.json` 和默认 agent 的 `SOUL.md`。`run` 命令会加载配置、解析默认 agent、启动 runtime、执行 LLM 请求并输出响应文本；`log -f` 命令会实时查看 JSONL 日志流。
```

#### 2. 新增"CLI 用法"段落

在"开发命令"之后新增：

```markdown
## CLI 用法

```bash
# 发送 prompt 给默认 agent
pnpm exec tianji run "hello"

# 实时查看日志
pnpm exec tianji log -f
```

配置文件位于 `~/.config/tianji-ai/tianji.json`，首次运行时自动生成。详见 `apps/cli/README.md`。
```

#### 3. 更新"当前状态说明"

将当前内容替换为：

```markdown
## 当前状态说明

- 仓库包含四个核心 package（`contracts`、`shared`、`llm`、`runtime`）和一个 CLI 应用（`apps/cli`）。
- CLI 已支持 `tianji run "<prompt>"` 和 `tianji log -f` 完整流程。
- 配置系统支持 `providers`、`agents`、`runtime`、`observer` 四个顶层配置块。
- 日志系统通过 JSONL 落盘到 `~/.config/tianji-ai/logs/cli.jsonl`。
- `docs/` 中部分内容会提到后续规划的 `tools-node`、`observer` 等模块，这些仍未在仓库中完整落地。
- 阅读本仓库时应优先以 `packages/` 与 `apps/cli` 下现有源码和导出 API 为准。
```

---

## 5.4 执行顺序

1. **`apps/cli/README.md`**：变动最大，从骨架文档重写为完整用户文档。
2. **`packages/shared/README.md`**：小范围补充 providers 配置说明和配置结构段落。
3. **`README.md`**：去掉阶段性措辞，新增 CLI 应用说明和用法段落。

## 5.5 验收标准

- 三个 README 中不再包含"阶段"、"骨架"、"尚未实现"、"未完成"等未就绪措辞。
- CLI 命令用法、配置文件位置、agent 目录规则、日志位置均有明确说明。
- 错误场景在 `apps/cli/README.md` 中有完整列举。
- 文档中的配置结构、导出 API、命令参数、文件路径与实际代码一致。
- `pnpm check` 通过。
