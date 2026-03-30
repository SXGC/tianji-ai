# @tianji/cli

`@tianji/cli` 是 `tianji-ai` 的命令行应用骨架。阶段 2 的目标是先固定 CLI 入口、命令分发、配置加载边界、runtime 启动边界与日志边界，而不是一次性完成完整模型执行链路。

## 当前命令面

- `tianji run "<prompt>"`
- `tianji log -f`

其中：

- `run` 会进入配置加载、默认 agent 解析、runtime 输入准备与日志写入主流程。
- `log -f` 会读取并持续 follow CLI JSONL 日志文件。

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
- 读取并校验用户配置
- 解析 `${env:VAR_NAME}` 占位符
- 解析默认 agent、模型引用与 `SOUL.md`

CLI 主流程不会直接拼接配置路径，也不会直接读取 `SOUL.md` 文件。

## 日志边界

- `src/logger.ts` 负责将结构化日志追加到 `~/.config/tianji-ai/logs/cli.jsonl`
- `src/log-follow.ts` 负责把 JSONL 渲染为可读文本并执行 follow 循环

日志仅记录元信息，例如 `agentName`、`provider`、`modelName`、`soulPath`，不会写入 `SOUL.md` 正文。

## 阶段 2 能力边界

当前实现仍然是阶段性骨架，明确未完成能力包括：

- `run` 尚未接入真实 runtime `runTurn`
- session 创建、snapshot store 与事件消费尚未落地
- 日志 follow 已具备基础轮询能力，但后续仍可替换为更完整的增量读取实现

因此，阶段 2 的完成标准是模块边界稳定、主流程可进入，而不是最终用户场景已经完全可用。
