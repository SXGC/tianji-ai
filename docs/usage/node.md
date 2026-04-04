# Tianji Node 使用指南

`@tianji/node` 是 `tianji-ai` 的节点命令行入口，提供本地单次执行、日志查看、守护进程和多轮对话能力。

## 安装与构建

在仓库根目录执行：

```bash
pnpm install
pnpm --filter @tianji/node build
```

构建后推荐通过仓库根脚本调用：

```bash
pnpm tianji --help
```

如果你已经把 `@tianji/node` 链接到全局环境，也可以直接执行 `tianji`。

## 快速开始

```bash
# 发送一条 prompt 给默认 agent
pnpm tianji run "hello"

# 查看最近日志并持续跟踪
pnpm tianji log -f

# 启动后台守护进程
pnpm tianji daemon start

# 连接守护进程进行多轮对话
pnpm tianji chat
```

首次运行时，如果 `~/.config/tianji-ai/` 不存在，node 会自动创建：

- `~/.config/tianji-ai/tianji.json`
- `~/.config/tianji-ai/agents/default/SOUL.md`
- `~/.config/tianji-ai/logs/`

## 常用命令

| 命令 | 用途 |
|---|---|
| `pnpm tianji run "<prompt>"` | 向默认 agent 发送一次请求 |
| `pnpm tianji log -f` | 跟踪 JSONL 日志并渲染为可读文本 |
| `pnpm tianji daemon start [--fg]` | 启动守护进程 |
| `pnpm tianji daemon status` | 查看守护进程状态 |
| `pnpm tianji daemon stop` | 停止守护进程 |
| `pnpm tianji daemon restart [--fg]` | 重启守护进程 |
| `pnpm tianji chat` | 连接守护进程进行多轮对话 |
| `pnpm tianji help` | 查看帮助 |

## 配置文件

主配置文件位于：

```text
~/.config/tianji-ai/tianji.json
```

最小示例：

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

补充路径：

| 路径 | 说明 |
|---|---|
| `~/.config/tianji-ai/tianji.json` | 用户配置文件 |
| `~/.config/tianji-ai/agents/<agent-name>/SOUL.md` | agent 系统提示词 |
| `~/.config/tianji-ai/logs/tianji.log` | CLI JSONL 日志 |
| `~/.config/tianji-ai/daemon.port` | 守护进程端口 |
| `~/.config/tianji-ai/daemon.pid` | 守护进程 PID |

更多配置细节见 [`../development/CONFIG_DESIGN.md`](../development/CONFIG_DESIGN.md)。

## 日志

Node 默认把结构化日志写到：

```text
~/.config/tianji-ai/logs/tianji.log
```

查看方式：

```bash
pnpm tianji log -f
pnpm tianji log --lines 20
```

日志由 `@tianji/observer` 统一生成，CLI 负责 follow 文件并渲染为人类可读文本。

## 与 Controlplane 配合

如果你需要让浏览器界面把任务派发到 node，需要先启动 node 侧能力并保持节点在线。Controlplane 的使用方式见 [`./controlplane.md`](./controlplane.md)。

## 更多资料

- 开发与命令细节：[`../../apps/node/README.md`](../../apps/node/README.md)
- 架构说明：[`../development/ARCHITECTURE.md`](../development/ARCHITECTURE.md)
