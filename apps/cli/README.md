# @tianji/cli

`@tianji/cli` 是 `tianji-ai` 的命令行应用。当前阶段已支持完整的 LLM 运行链路：`tianji run "<prompt>"` 会真实调用 LLM 并流式输出 assistant 响应文本。

## 当前命令面

- `tianji run "<prompt>"` — 调用 LLM 执行一次对话轮次，流式输出 assistant 文本到 stdout。
- `tianji log -f` — 读取并持续 follow CLI JSONL 日志文件。

## 运行前提

- 用户需要配置正确的 provider apiKey（通过环境变量或配置文件）。
- 支持的 provider 及其环境变量映射：

| provider 名称 | 环境变量 |
|--------------|---------|
| `openai` | `OPENAI_API_KEY` |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `google` | `GOOGLE_GENERATIVE_AI_API_KEY` |

## SOUL.md 的作用

`SOUL.md` 定义了 agent 的行为描述。CLI 会自动加载默认 agent 的 `SOUL.md` 并将其内容注入为 LLM 的 system prompt。

## 目录结构

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

## 配置入口职责

`src/config.ts` 负责以下边界：

- 定位 `~/.config/tianji-ai`
- 初始化默认 `tianji.json`
- 初始化默认 `agents/default/SOUL.md`
- 调用 `@tianji/runtime` 配置中心加载三层配置并取得最终生效配置
- 基于最终生效配置解析默认 agent、模型引用与 `SOUL.md`
- 将 provider apiKey 注入 `process.env`（`injectProviderEnv`）

CLI 主流程不会直接拼接配置路径，也不会直接读取 `SOUL.md` 文件。

## 日志边界

- `src/logger.ts` 负责将结构化日志追加到 `~/.config/tianji-ai/logs/cli.jsonl`
- `src/log-follow.ts` 负责把 JSONL 渲染为可读文本并执行 follow 循环

日志仅记录元信息，例如 `agentName`、`provider`、`modelName`、`soulPath`、`sessionId`、`runId`，不会写入 prompt 正文、SOUL.md 正文或 assistant 响应正文。

## 当前能力边界

当前仍处于最小实现阶段，明确未完成能力包括：

- 不支持工具调用。
- 不支持多轮对话（每次 `run` 命令创建独立的 session）。
