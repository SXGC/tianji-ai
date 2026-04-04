# Controlplane 使用指南

`apps/controlplane` 提供浏览器任务界面，用于查看在线节点、选择 agent，并把任务派发给 node 执行。

## 构建与启动

在仓库根目录执行：

```bash
pnpm install
pnpm --filter @tianji/controlplane build
pnpm --filter @tianji/controlplane start
```

默认启动后可访问：

```text
http://127.0.0.1:3000/
```

## 使用前提

Controlplane 只负责 Web UI、任务管理和调度，不直接执行模型请求。使用前需要至少有一个在线 node。

典型流程：

1. 启动一个可注册到 controlplane 的 node。
2. 启动 controlplane 服务。
3. 在浏览器打开 `http://127.0.0.1:3000/`。
4. 选择一个在线节点。
5. 输入任务并等待流式输出。

如果页面没有可选节点，通常说明当前还没有 node 注册成功，或者心跳已超时。

## 页面能力

当前浏览器界面包含这些基础能力：

- 查看节点在线状态与节点元信息
- 查看节点下可用 agent
- 创建 task 并派发给指定 node
- 通过 SSE 实时接收任务执行输出

Controlplane Web UI 使用这些接口：

- `GET /api/ui/nodes`
- `POST /api/ui/tasks`
- `GET /api/ui/tasks/:taskId/stream`

## 环境变量

Controlplane 服务支持以下环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `TIANJI_CP_PORT` | `3000` | HTTP 监听端口 |
| `TIANJI_CP_HOST` | `0.0.0.0` | HTTP 监听地址 |
| `TIANJI_CP_DATA_DIR` | `~/.config/tianji-ai/controlplane` | 数据目录 |

示例：

```bash
TIANJI_CP_PORT=3100 pnpm --filter @tianji/controlplane start
```

## 数据目录

默认数据目录：

```text
~/.config/tianji-ai/controlplane
```

当前会创建 SQLite 数据库文件：

```text
~/.config/tianji-ai/controlplane/controlplane.db
```

## 常见问题

### 页面能打开，但没有节点

- 检查 node 是否已经启动并完成注册
- 检查 node 是否持续发送心跳
- 检查 controlplane 与 node 的连接配置是否一致

### 想改监听端口

设置 `TIANJI_CP_PORT` 后再启动。例如：

```bash
TIANJI_CP_PORT=3100 pnpm --filter @tianji/controlplane start
```

## 更多资料

- node 使用方式：[`./node.md`](./node.md)
- 架构说明：[`../development/ARCHITECTURE.md`](../development/ARCHITECTURE.md)
