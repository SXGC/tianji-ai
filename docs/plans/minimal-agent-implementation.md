# Minimal Agent 实施计划

## 目标

基于当前 `tianji-ai` 仓库实现一个最小可运行 agent，满足以下验收目标：

1. `tianji run "hi"` 会创建一个 agent runtime，发起一次 LLM 请求，并返回结果。
2. 默认 agent 配置从配置文件读取；如果配置文件不存在，则自动创建默认配置文件。
3. 如果配置文件已存在，但没有默认 agent，则报错。
4. 构建层级清晰的日志体系，并支持通过 `tianji log -f` 实时查看日志流。

## 当前仓库现状

### 已有能力

- `packages/runtime` 已提供：
  - `createSessionRuntime`
  - `FileSnapshotStore`
  - `ReplayableEventStream`
  - deepagents-only 执行引擎
- `packages/shared` 已提供：
  - `TianjiConfigSchema`
  - `${env:VAR_NAME}` 占位符解析
  - 默认 `llm/runtime/observer` 配置（本计划会收敛为 `providers/agents/runtime/observer`）
- 根目录当前还没有：
  - `apps/` 目录
  - CLI 入口
  - `agent` 配置模型
  - 日志查看命令

### 关键约束

- 当前 `runtime` 不直接消费 `@tianji/shared` 的顶层配置，需要在 CLI 层完成配置到 runtime 参数的映射。
- 当前配置 schema 没有 `agent` 概念，需要扩展。
- 根目录 `typecheck` 只覆盖 `packages/*`，新增 `apps/cli` 后需要纳入 `apps/*`。

## 总体方案

### 1. 新增 CLI 应用层

新增 `apps/cli`，作为最小应用入口，只依赖：

- `@tianji/contracts`
- `@tianji/runtime`
- `@tianji/shared`

提供两个命令：

- `tianji run "<prompt>"`
- `tianji log -f`

### 2. 扩展配置模型与 agent 目录

在 `packages/shared` 中将 provider 配置提升为顶层 `providers`，并引入 `agents` 配置块；agent 的 markdown 配置不写入 JSON，而是放到配置目录中独立管理。结构如下：

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

对应的用户配置目录结构：

```text
~/.config/tianji-ai/tianji.json
~/.config/tianji-ai/agents/default/SOUL.md
```

其中：

- `providers.<name>`：声明 provider 连接信息，例如 `apiKey`、自定义 endpoint 等。
- `agents.items.<name>.model`：使用 `provider/modelName` 引用模型。
- `agents/<name>/SOUL.md`：定义该 agent 的价值观、边界、与人类协作关系；初始化时自动加载，并映射到 runtime 的 `systemPrompt`。

补充能力：

- `TianjiProviderConfigSchema`
- `TianjiProvidersConfigSchema`
- `TianjiAgentConfigSchema`
- `TianjiAgentsConfigSchema`
- `AgentModelRefSchema`
- `DEFAULT_PROVIDERS_CONFIG`
- `DEFAULT_AGENT_CONFIG`
- `DEFAULT_AGENTS_CONFIG`
- `createDefaultUserTianjiConfig()`
- `parseAgentModelRef()`
- `getDefaultAgentDefinition()`
- `getAgentSoulPath()`
- `loadAgentSoul()`

额外约束：

- agent 名称必须限制为安全文件名，建议使用 `^[a-z0-9][a-z0-9-_]*$`。
- `model` 解析时只按第一个 `/` 切分，避免模型名自身包含 `/` 时被错误拆分。
- schema 只负责校验 JSON 结构；`SOUL.md` 的存在性、可读性、非空性由 CLI loader 校验。

### 3. 三层配置加载与用户层 agent 目录

CLI 复用 `packages/runtime` 已有的三层 JSON 配置加载能力，按以下优先级合并：

- 项目层：`<workspace-root>/tianji.config.json`
- 用户层：`~/.config/tianji-ai/tianji.json`
- 工作区层：`~/.config/tianji-ai/workspaces/<workspace-id>.json`

其中 agent 文件资源仍固定放在用户配置目录：

- `~/.config/tianji-ai/agents/<agent-name>/SOUL.md`

CLI 行为：

- 用户层配置目录不存在：自动创建目录、空的用户层 `tianji.json`、默认 agent 的 `SOUL.md`
- 三层合并后的配置存在但没有默认 agent：直接报错
- 配置合法：解析三层合并结果中的默认 agent，加载用户层 `SOUL.md`，并启动 runtime

### 4. 最小运行链路

`tianji run "hi"` 的执行流程：

1. 通过 `loadResolvedConfig()` 加载三层配置：default < user < workspace
2. 如果用户层配置目录或用户层配置文件不存在，则创建 `~/.config/tianji-ai/tianji.json` 与 `~/.config/tianji-ai/agents/default/SOUL.md`
3. 对三层合并后的 JSON 配置做 schema 校验
4. 解析 `${env:...}` 占位符
5. 读取默认 agent：
   - `model = "provider/modelName"`
6. 解析 model 引用：
   - provider = `provider`
   - modelName = `modelName`
7. 从 `~/.config/tianji-ai/agents/<agent-name>/SOUL.md` 加载 agent 身份配置
8. 将 provider 对应的 `apiKey` 注入 `process.env`
9. 构造 runtime：
   - `deepagents.model = "<provider>:<modelName>"`
   - `snapshotStore = new FileSnapshotStore(...)`
   - `systemPrompt = <SOUL.md content>`
10. 创建 session
11. 调用 `runTurn`
12. 消费 `streamEvents(runId)`：
     - `message.delta` 实时拼接文本
     - `run.failed` 输出错误
     - `run.completed` 结束
13. 返回最终 assistant 文本

## 日志方案

### 日志落盘位置

采用单文件 JSON Lines：

- `~/.config/tianji-ai/logs/tianji.log`

### 日志格式

每行一条 JSON：

```json
{
  "timestamp": "2026-03-25T10:00:00.000Z",
  "level": "info",
  "scope": ["cli", "run", "config"],
  "message": "Loaded user config",
  "data": {
    "defaultAgent": "default",
    "model": "openai/gpt-4.1",
    "soulPath": "~/.config/tianji-ai/agents/default/SOUL.md"
  }
}
```

注意：

- 日志只记录 `agentName`、`model`、`soulPath` 等元数据，不记录 `SOUL.md` 正文。

### 建议 scope 分层

- `cli.run`
- `cli.run.config`
- `cli.run.runtime`
- `cli.run.event`
- `cli.log.follow`

### `tianji log -f` 行为

- 打开 `~/.config/tianji-ai/logs/tianji.log`
- 若文件不存在，则等待创建
- 先输出已有日志
- 然后持续 follow 新增内容
- 对 JSONL 做人类可读格式化输出

示例输出：

```text
2026-03-25T10:00:00.000Z INFO  cli > run > config   Loaded user config
2026-03-25T10:00:01.200Z INFO  cli > run > runtime  Session runtime created
2026-03-25T10:00:02.100Z INFO  cli > run > event    message.delta
```

## 拟修改文件

### shared 配置扩展

- `packages/shared/src/config.ts`
- `packages/shared/src/index.ts`
- `packages/shared/src/__tests__/config.test.ts`
- `packages/shared/README.md`

### CLI 新增

- `apps/cli/package.json`
- `apps/cli/tsconfig.json`
- `apps/cli/README.md`
- `apps/cli/bin/tianji.mjs`
- `apps/cli/src/bin.ts`
- `apps/cli/src/main.ts`
- `apps/cli/src/config.ts`
- `apps/cli/src/logger.ts`
- `apps/cli/src/log-follow.ts`

### 根目录调整

- `package.json`
- `README.md`

## 详细实施步骤

### 阶段 1：配置模型扩展

在 `packages/shared` 中增加 `providers`、`agents` 配置块及默认值，并为 agent 目录加载提供 helper。

详细 TODO 文档：`docs/plans/minimal-agent-stage-1-config-plan.md`

目标：

- 让配置层能表达“默认 agent + provider/model 绑定关系”
- 让 CLI 能以统一 helper 读取默认 agent 与 `SOUL.md`
- 保持 `runtime/observer` 配置延续，同时把 provider 配置收敛为顶层 `providers`

验收点：

- 默认配置对象通过 schema 校验
- `getDefaultAgentDefinition()` 能正确取到默认 agent
- `parseAgentModelRef()` 能正确把 `provider/modelName` 解析为结构化结果
- 缺失默认 agent 时返回明确失败

### 阶段 2：CLI 骨架搭建

新增 `apps/cli`。

详细 TODO 文档：`docs/plans/minimal-agent-stage-2-cli-plan.md`

最小职责：

- 参数解析
- 配置加载
- runtime 启动
- 日志写入
- 日志 follow

不引入复杂命令框架，优先使用最小自实现参数分发。

验收点：

- 能通过 `tianji run "hi"` 进入 CLI 主流程
- 能通过 `tianji log -f` 进入日志 follow 主流程

### 阶段 3：运行链路打通

在 CLI 中打通：

- 创建 session
- 调用 `runTurn`
- 消费事件
- 输出最终文本
- 自动加载 `SOUL.md`
- 记录运行日志

验收点：

- 配置和 env 正确时可得到模型响应
- `SOUL.md` 会被加载并传入 runtime `systemPrompt`
- 运行失败时能给出结构化错误
- 日志中能看到配置加载、runtime 创建、事件流转

### 阶段 4：日志系统补齐

实现：

- JSONL logger
- 文件追加写入
- follow 读取器
- CLI 侧友好格式化输出

验收点：

- `tianji run` 期间会持续写入日志
- `tianji log -f` 能实时看到新增日志

### 阶段 5：文档更新

更新：

- 根目录 `README.md`
- `packages/shared/README.md`
- 新增 `apps/cli/README.md`

说明：

- CLI 用法
- 配置文件位置
- 默认 agent 结构与 `SOUL.md` 目录规则
- 日志文件位置与查看方法

### 阶段 6：校验

执行：

- `pnpm check`

要求：

- 不留任何 `check` 错误、警告、信息
- 如有类型或格式问题，逐一修复直到通过

## 错误处理策略

### 用户层配置文件不存在

行为：

- 自动创建空的用户层配置文件
- 自动创建默认 agent 的 `SOUL.md`
- 记录日志
- 提示用户已创建配置文件

### 配置文件损坏或 schema 不合法

行为：

- 直接报错退出
- 输出具体校验错误路径

### 缺失默认 agent

行为：

- 直接报错
- 错误信息明确指出：
  - `agents.defaultAgent` 缺失，或
  - `agents.items[defaultAgent]` 不存在

### agent model 格式非法

行为：

- 直接报错
- 明确指出 `agents.items[<name>].model` 必须符合 `provider/modelName` 格式

### provider 不存在

行为：

- 直接报错
- 明确指出 `agents.items[<name>].model` 引用的 provider 未在顶层 `providers` 中声明

### 缺失或空的 `SOUL.md`

行为：

- 直接报错
- 错误信息明确指出缺失路径或空文件路径
- 不允许静默回退到内联默认 prompt

### 缺失 env

行为：

- 在 placeholder 解析阶段失败
- 明确提示缺少哪个 env 变量

### LLM 请求失败

行为：

- 透传为 CLI 运行错误
- 写入日志
- 非零退出

## 风险点

### 1. deepagents provider 初始化依赖环境变量

处理方式：

- CLI 在启动 runtime 前把配置中的 provider apiKey 映射到标准 env 名称：
  - `OPENAI_API_KEY`
  - `ANTHROPIC_API_KEY`
  - `GOOGLE_GENERATIVE_AI_API_KEY`

### 2. 当前 runtime 不直接接 shared 配置

处理方式：

- 在 CLI 层基于 `loadResolvedConfig()` 的结果做一次显式映射：
  - agent config + `SOUL.md` -> runtime deepagents config

### 3. agent 目录与 JSON 配置可能失配

处理方式：

- 初始化默认配置时同时生成默认 agent 目录
- loader 启动时校验 `agents.items` 与 `agents/<name>/SOUL.md` 的对应关系
- 错误优先在 CLI 配置加载阶段暴露，而不是延迟到 runtime 请求阶段

### 4. CLI bin 启动方式

处理方式：

- 优先保证 workspace 内可运行
- 同时在根 `package.json` 暴露 `bin.tianji`

## 验收标准

满足以下条件即视为完成：

1. `tianji run "hi"` 可在缺少用户层配置文件时自动生成 `~/.config/tianji-ai/tianji.json`
2. 同时自动生成 `~/.config/tianji-ai/agents/default/SOUL.md`
3. 默认 agent 配置从 `tianji.json` 读取，agent 身份配置从对应 `SOUL.md` 读取
4. 缺失默认 agent、非法 `model`、缺失 provider 或缺失 `SOUL.md` 时命令报错
5. 命令运行时会将日志写入 `~/.config/tianji-ai/logs/tianji.log`
6. `tianji log -f` 能持续查看日志新增内容
7. 所有代码改动完成后 `pnpm check` 通过
