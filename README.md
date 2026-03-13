# tianji-ai

`tianji-ai` 是一个基于 `pnpm` 和 `turbo` 的 TypeScript monorepo，用于构建 AI 会话运行时、公共协议、配置模型和 LLM 接入层。

当前仓库聚焦基础包建设：已经包含 `contracts`、`shared`、`llm`、`runtime` 四个核心 package；面向最终用户的 `apps/` 入口当前尚未落地。

## 当前范围

- 使用 `pnpm workspace` 管理多包仓库。
- 使用 `turbo` 编排 `build`、`test`、`typecheck` 等任务，并结合 Biome 承担根目录 `lint` / `format` / `check`。
- 以 TypeScript 为主语言，代码质量工具链为 Biome + Vitest。
- `docs/` 下提供架构与配置设计文档，但其中部分内容仍是 v1 draft，不应视为全部已实现能力。

## 仓库结构

```text
tianji-ai/
├─ docs/
│  ├─ ARCHITECTURE_V1.md
│  └─ CONFIG_DESIGN.md
├─ packages/
│  ├─ contracts/
│  ├─ llm/
│  ├─ runtime/
│  └─ shared/
├─ biome.json
├─ package.json
├─ pnpm-workspace.yaml
├─ turbo.json
└─ tsconfig.json
```

## 核心包说明

### `@tianji/contracts`

公共领域协议包，负责定义系统对外共享的核心类型，包含：

- `SessionId` / `ThreadId` / `RunId` 等标识符
- `AppMessage`、`MessagePart` 等消息模型
- `RuntimeEvent`、`ToolSpec`、`ToolResult` 等运行时协议
- `ExecutionPolicy`、错误类型、artifact、snapshot、delta 与 delta 聚合能力

该包的目标是作为系统统一契约层，避免上层直接依赖具体框架内部类型。

### `@tianji/shared`

共享工具与配置模型包，当前主要包含：

- `TianjiConfig` 及相关 Zod schema
- `${env:VAR_NAME}` 形式的环境变量占位符解析
- 默认 runtime / observer / llm 配置
- 通用工具函数，例如重试和深拷贝

该包不依赖其他内部 `@tianji/*` 包，用于承载跨包复用的基础能力。

### `@tianji/llm`

LLM 接入层，提供统一的 provider-agnostic gateway 抽象，当前公开能力包括：

- `LlmGateway` / `LlmStream` 等模型调用接口
- OpenAI、Anthropic、Google 的 gateway 工厂
- 消息转换、工具 schema 桥接、usage/cost 收集

该包用于隔离上层 runtime 与具体 provider SDK，实现统一的模型访问边界。

### `@tianji/runtime`

会话运行时包，负责管理 session 与执行过程，当前公开能力包括：

- `createSessionRuntime`
- `ReplayableEventStream`
- `FileSnapshotStore` / `InMemorySnapshotStore`
- `ToolRegistry`、工具权限校验与相关运行时类型

该包是编排层与运行时状态的核心承载位置。

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

根目录脚本会在 Biome、`pnpm -r` 和 `turbo` 之间分工：Biome 负责 lint / format，包级递归 `typecheck` 负责轻量类型检查，`turbo` 负责 build / test；如果只关注某个 package，可进一步结合 `pnpm --filter <package>` 在对应包范围内执行。

## 环境变量

- 根目录提供了 `.env.example`，集中列出当前代码实际使用到的环境变量。
- 当前没有“无条件必需”的环境变量；`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GOOGLE_GENERATIVE_AI_API_KEY` 是代码里内置识别的 provider API key 名称，仅在“使用对应 provider 且走默认 env 读取 API key”时必需。
- 如果直接在 JSON 配置中提供 provider `apiKey`、`baseUrl` 或 `headers`，则不必依赖上述 env 名称。
- 配置系统支持任意 `${env:VAR_NAME}` 占位符，因此 `.env.example` 只覆盖当前代码内置识别的环境变量，不是完整白名单。

## Git Hooks

- 仓库使用 Husky 安装 `pre-commit` hook，`pnpm install` 后会通过 `prepare` 自动安装。
- `pre-commit` 仅对已暂存文件执行 `biome check --staged`，然后递归执行各 package 的 `typecheck`。
- 这套流程的目标是让提交前检查尽量轻量：lint / format 语义只覆盖 staged 文件，类型检查不再通过 `turbo` 触发依赖包构建。

## 文档

- `docs/ARCHITECTURE_V1.md`：v1 架构设计草案，描述整体分层、核心原则与包边界。
- `docs/CONFIG_DESIGN.md`：配置系统设计文档，描述多层 JSON 配置、优先级与 `${env:VAR_NAME}` 解析规则。

补充说明：当前仓库中尚未提交根级 `tianji.config.json` 示例文件，因此配置入口应以代码实现和设计文档为准，而不是假定已有默认项目配置文件。

## 当前状态说明

- 仓库目前以基础设施 package 为主，尚无 `apps/` 目录。
- `docs/` 中部分内容会提到后续规划的 `apps/`、`tools-node`、`observer` 等模块，但这些并未在当前仓库中完整落地。
- 因此，阅读本仓库时应优先以 `packages/` 下现有源码和导出 API 为准。

## License

本仓库使用 Apache License 2.0，详见根目录 `LICENSE`。
