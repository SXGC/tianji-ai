# tianji-ai

`tianji-ai` 是一个基于 `pnpm` 和 `turbo` 的 TypeScript monorepo，用于构建 AI 会话运行时、observer 能力、共享协议与配置模型，以及 node / controlplane 应用。

当前仓库包含 `shared`、`runtime`、`observer`、`agent` 四个核心 package，以及 `apps/node` 和 `apps/controlplane` 两个应用。

## Quick Start

```bash
pnpm install

# 构建 node
pnpm --filter @tianji/node build

# 本地直接使用 node CLI
pnpm tianji run "hello"

# 构建并启动 controlplane
pnpm --filter @tianji/controlplane build
pnpm --filter @tianji/controlplane start

# 让 node 注册到 controlplane
TIANJI_CP_BASE_URL=http://127.0.0.1:3000 \
TIANJI_CP_ENROLLMENT_TOKEN=<enrollment-token> \
TIANJI_NODE_ID=node-001 \
pnpm tianji
```

启动 controlplane 后，默认访问 `http://127.0.0.1:3000/`。

如果没有设置 `TIANJI_CP_BASE_URL`、`TIANJI_CP_ENROLLMENT_TOKEN` 和 `TIANJI_NODE_ID` 启动 node，controlplane 页面不会出现可用节点。

注意：`pnpm tianji run "hello"` 只会执行本地 CLI 请求，不会把 node 注册到 controlplane。controlplane 模式需要直接运行 `pnpm tianji`，并且不带子命令。

详细使用说明：

- node CLI：[`docs/usage/node.md`](./docs/usage/node.md)
- controlplane：[`docs/usage/controlplane.md`](./docs/usage/controlplane.md)

## 当前范围

- 使用 `pnpm workspace` 管理多包仓库。
- 使用 `turbo` 编排 `build`、`test`、`typecheck` 等任务，并结合 Biome 承担根目录 `lint` / `format` / `check`。
- 以 TypeScript 为主语言，代码质量工具链为 Biome + Vitest。
- `docs/` 下提供架构与配置设计文档，但其中部分内容仍是 v1 draft，不应视为全部已实现能力。

## 仓库结构

```text
tianji-ai/
├─ apps/
│  ├─ controlplane/
│  └─ node/
├─ docs/
│  ├─ development/
│  │  ├─ ARCHITECTURE.md
│  │  ├─ AGENT_DESIGN.md
│  │  ├─ CLI_GUIDE.md
│  │  ├─ CONFIG_DESIGN.md
│  │  ├─ DEVELOPMENT.md
│  │  ├─ OBSERVER_DESIGN.md
│  │  └─ RUNTIME_DESIGN.md
│  ├─ superpowers/
│  └─ usage/
│     ├─ controlplane.md
│     └─ node.md
├─ packages/
│  ├─ agent/
│  ├─ observer/
│  ├─ runtime/
│  └─ shared/
├─ biome.json
├─ package.json
├─ pnpm-workspace.yaml
├─ turbo.json
└─ tsconfig.json
```

## 核心包说明

### `@tianji/shared`

共享工具与配置模型包，当前主要包含：

- `SessionId` / `ThreadId` / `RunId`、`AppMessage`、`RuntimeEvent`、`ToolSpec` 等基础协议
- `TianjiConfig` 及相关 Zod schema
- `${env:VAR_NAME}` 形式的环境变量占位符解析
- 默认 runtime / observer / llm 配置
- 通用工具函数，例如重试和深拷贝

该包不依赖其他内部 `@tianji/*` 包，用于承载跨包复用的基础能力。基础协议与配置 schema 统一由 `@tianji/shared` 提供。

### `@tianji/runtime`

会话运行时包，负责管理 session 与执行过程。v2 公共 API 已收敛到 deepagents-native 配置面，运行时执行引擎为 deepagents-only，历史 legacy snapshot 仅通过 metadata helper 提供只读兼容。LLM provider 适配已内聚到 runtime 内部 `src/llm/`。当前公开能力包括：

- 运行时入口与类型：`createSessionRuntime`、`SessionRuntime`、`SessionRuntimeOptions`、`SessionRuntimeEngine`、`SessionRuntimeDeepagentsConfig`、`CreateSessionOptions`、`RunTurnOptions`、`ResumeRunOptions`
- Metadata 读取：`readSessionRuntimeMetadata`、`readRunRuntimeMetadata`、`readDeepagentsRunWorkflowState`
- 事件流：`ReplayableEventStream`
- 快照持久化：`SnapshotStore`、`InMemorySnapshotStore`、`FileSnapshotStore`
- 工具注册与策略校验：`ToolRegistry`、`ensureToolAllowed`、`ToolCatalog` 及相关运行时类型

该包是编排层与运行时状态的核心承载位置。`SessionRuntimeOptions` 默认围绕 `deepagents` 配置块组织，支持 model、middleware、subagents、skills、interruptOn 等字段；`snapshotStore` 与 `toolCatalog` 继续作为稳定公共 API 暴露。

### `@tianji/observer`

observer 包，负责统一提供结构化日志和 tracing 初始化原语。当前公开能力包括：

- logger 类型与入口：`ObserverLogger`、`ObserverLogEntry`、`ObserverLogSink`、`createObserverLogger`
- 日志 sink：`createJsonlFileSink`、`createMemorySink`、`createStdoutSink`
- 数据脱敏：`sanitizeObserverLogData`、`getDefaultObserverSensitiveKeys`
- tracing：`initTracing`、`shutdownTracing`、`getTracer`、`startSessionSpan`、`startRunSpan`、`startToolSpan`、`startLlmCallSpan`

该包负责 observer 侧公共边界；CLI 与 runtime 只消费这些能力，不再各自定义独立日志协议。

### `@tianji/agent`

agent 装配层，负责把配置解析结果、默认 agent、`SOUL.md`、provider 凭据注入和 runtime/session 启动原语组合成应用入口可直接消费的 API。当前公开能力包括：

- 上下文装配：`loadAgentContext`、`ensureDefaultUserConfig`
- 路径与配置桥接：`getAgentAppPaths`、`injectProviderEnv`
- 启动原语：`createAgentRuntime`、`createAgentSession`
- Daemon 协议：`DaemonServer`、`DaemonClient`、SSE 编解码类型

该包位于 CLI 与 runtime 之间，承接应用层初始化逻辑，避免 CLI 直接依赖 runtime 创建细节。

### `@tianji/node`

节点命令行应用，提供 `tianji run "<prompt>"`、`tianji log -f`、`tianji daemon`、`tianji chat`、`tianji status`、`tianji stop` 和 `tianji help` 七个命令。首次运行时会自动在 `~/.config/tianji-ai/` 下创建用户层配置文件 `tianji.json`、默认 agent 的 `SOUL.md` 和日志目录。当前 `run` 命令仍通过 `@tianji/agent` 加载默认 agent、创建会话并执行请求；后续会逐步迁移为 ACP 管理的 node 架构。日志写入协议由 `@tianji/observer` 统一提供，`log -f` 命令负责 follow 文件并渲染为可读文本。使用说明见 [`docs/usage/node.md`](./docs/usage/node.md)。

## 开发命令

在仓库根目录执行：

```bash
pnpm install
pnpm lint
pnpm format
pnpm format:check
pnpm typecheck
pnpm check
pnpm build
pnpm test
```

根目录脚本会在 Biome、`pnpm -r` 和 `turbo` 之间分工：Biome 负责 lint / format，包级递归 `typecheck` 会覆盖 `packages/*` 与 `apps/*`，`turbo` 负责 build / test；如果只关注某个 package，可进一步结合 `pnpm --filter <package>` 在对应包范围内执行。

## CLI 用法

```bash
# 发送 prompt 给默认 agent
pnpm tianji run "hello"

# 实时查看日志
pnpm tianji log -f

# 启动后台守护进程
pnpm tianji daemon

# 以前台模式启动守护进程（调试用）
pnpm tianji daemon --fg

# 连接守护进程进行多轮对话
pnpm tianji chat

# 查看守护进程状态
pnpm tianji status

# 停止守护进程
pnpm tianji stop
```

用户配置文件位于 `~/.config/tianji-ai/tianji.json`，首次运行时会自动生成。默认 agent 的 `SOUL.md` 位于 `~/.config/tianji-ai/agents/default/SOUL.md`。更多细节见 [`docs/usage/node.md`](./docs/usage/node.md) 和 [`apps/node/README.md`](./apps/node/README.md)。

## 环境变量

- 根目录提供了 `.env.example`，集中列出当前代码实际使用到的环境变量。
- 当前没有“无条件必需”的环境变量；`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GOOGLE_GENERATIVE_AI_API_KEY` 是代码里内置识别的 provider API key 名称，仅在“使用对应 provider 且走默认 env 读取 API key”时必需。
- 如果直接在 JSON 配置中提供 provider `apiKey`、`baseUrl` 或 `headers`，则不必依赖上述 env 名称。
- 配置系统支持任意 `${env:VAR_NAME}` 占位符，因此 `.env.example` 只覆盖当前代码内置识别的环境变量，不是完整白名单。

## CLI 日志

- `@tianji/observer` 统一提供结构化日志 API 和 JSONL sink；CLI 当前默认把日志写到 `~/.config/tianji-ai/logs/tianji.log`。
- JSONL 记录字段为 `timestamp`、`level`、`scope`、`message`、`data`，其中 `scope` 是字符串数组。
- `tianji log -f` 由 CLI 负责读取已有日志、持续 follow 新增内容，并渲染为人类可读文本。
- 日志不会记录 prompt 原文、`SOUL.md` 正文或 provider `apiKey`。

## Controlplane Web UI

`apps/controlplane` 现在会在 `/` 提供浏览器聊天界面。启动 controlplane 与 node 后，可直接访问 `http://127.0.0.1:3000/`，选择在线节点并发送 task。使用说明见 [`docs/usage/controlplane.md`](./docs/usage/controlplane.md)。

## Git Hooks

- 仓库使用 Husky 安装 `pre-commit` hook，`pnpm install` 后会通过 `prepare` 自动安装。
- `pre-commit` 仅对已暂存文件执行 `biome check --staged`，然后递归执行各 package 的 `typecheck`。
- 这套流程的目标是让提交前检查尽量轻量：lint / format 语义只覆盖 staged 文件，类型检查不再通过 `turbo` 触发依赖包构建。

## 文档

### 使用文档

- `docs/usage/node.md`：node 命令行使用说明，覆盖构建、运行、配置与日志。
- `docs/usage/controlplane.md`：controlplane 浏览器界面使用说明，覆盖启动、访问地址、环境变量与节点联调。

### 开发文档

- `docs/development/ARCHITECTURE.md`：架构设计文档，描述 4 包分层、各包职责、依赖约束与迁移路径。
- `docs/development/CONFIG_DESIGN.md`：配置系统设计文档，描述多层 JSON 配置、优先级与 `${env:VAR_NAME}` 解析规则。
- `docs/development/RUNTIME_DESIGN.md`：运行时设计文档，描述会话生命周期、执行引擎、快照持久化、工具系统与 LLM 网关。
- `docs/development/OBSERVER_DESIGN.md`：Observer 设计文档，描述结构化日志协议、sink 机制、数据脱敏与 tracing。
- `docs/development/AGENT_DESIGN.md`：Agent 设计文档，描述上下文装配、provider 凭据注入、daemon 协议与 SOUL.md 加载。
- `docs/development/CLI_GUIDE.md`：CLI 用户指南，描述所有命令用法、配置路径与 daemon 生命周期。
- `docs/development/DEVELOPMENT.md`：开发者指南，描述环境搭建、构建测试流程、代码规范与 git hooks。

补充说明：runtime 已实现中心化配置加载，会按 `default < user < workspace` 顺序解析内置默认配置 `tianji.config.json`、`~/.config/tianji-ai/tianji.json` 与工作区配置文件。

## 当前状态说明

- 仓库包含四个核心 package（`shared`、`runtime`、`observer`、`agent`）和两个应用（`apps/node`、`apps/controlplane`）。
- CLI 已支持 `tianji run "<prompt>"`、`tianji log -f`、`tianji daemon`、`tianji chat`、`tianji status`、`tianji stop` 完整流程。
- 配置系统支持 `providers`、`agents`、`runtime`、`observer` 四个顶层配置块。
- 日志系统当前通过 `@tianji/observer` 的 JSONL sink 落盘到 `~/.config/tianji-ai/logs/tianji.log`。
- `docs/` 中部分内容会提到后续规划的 `tools-node` 等模块，这些仍未在仓库中完整落地。
- 因此，阅读本仓库时应优先以 `packages/`、`apps/node` 与 `apps/controlplane` 下现有源码和导出 API 为准。

## License

本仓库使用 Apache License 2.0，详见根目录 `LICENSE`。
