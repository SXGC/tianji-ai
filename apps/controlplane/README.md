# @tianji/controlplane

`@tianji/controlplane` 是 `tianji-ai` 的控制平面 Web 应用，负责提供浏览器 UI、管理在线 node、创建 task，并通过 HTTP / SSE 与 node 交互。

## 构建与启动

在仓库根目录执行：

```bash
pnpm install
pnpm --filter @tianji/controlplane build
pnpm --filter @tianji/controlplane start
```

默认访问地址：

```text
http://127.0.0.1:3000/
```

如果需要修改监听地址，可设置环境变量：

```bash
TIANJI_CP_HOST=127.0.0.1 TIANJI_CP_PORT=3100 pnpm --filter @tianji/controlplane start
```

## 运行前提

Controlplane 自身不执行模型调用，任务实际由在线 node 执行。

典型流程：

1. 启动并注册至少一个 node。
2. 构建并启动 controlplane。
3. 打开浏览器，访问 `/`。
4. 选择在线节点和 agent。
5. 提交任务并查看流式输出。

如果页面中没有可选节点，通常说明 node 尚未注册成功，或者心跳已超时。

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `TIANJI_CP_PORT` | `3000` | HTTP 监听端口 |
| `TIANJI_CP_HOST` | `0.0.0.0` | HTTP 监听地址 |
| `TIANJI_CP_DATA_DIR` | `~/.config/tianji-ai/controlplane` | 数据目录 |

默认 SQLite 数据库路径：

```text
~/.config/tianji-ai/controlplane/controlplane.db
```

## Web UI 与接口

当前 Web UI 提供这些能力：

- 查看节点在线状态和基础信息
- 查看节点下可用 agent
- 创建 task 并派发到指定 node
- 通过 SSE 接收任务执行过程中的流式输出

当前前端依赖的主要接口：

- `GET /api/ui/nodes`
- `POST /api/ui/tasks`
- `GET /api/ui/tasks/:taskId/stream`

## 包脚本

| 命令 | 说明 |
|---|---|
| `pnpm --filter @tianji/controlplane build` | 构建前端资源并编译服务端代码 |
| `pnpm --filter @tianji/controlplane typecheck` | 运行服务端与前端类型检查 |
| `pnpm --filter @tianji/controlplane test` | 运行 Vitest |
| `pnpm --filter @tianji/controlplane start` | 启动已构建产物 |
| `pnpm --filter @tianji/controlplane clean` | 清理 `dist/` |

## 目录结构

```text
apps/controlplane/
├─ src/
│  ├─ app.ts                 # Hono 应用装配
│  ├─ server.ts              # 服务启动入口
│  ├─ db/                    # SQLite 初始化与 schema
│  ├─ routes/                # HTTP / SSE 路由
│  ├─ services/              # 事件与观测服务
│  └─ web/                   # React SPA
├─ dist/                     # 构建产物
├─ package.json
├─ README.md
└─ vite.config.ts
```

## 相关文档

- 仓库级使用说明：[`../../docs/usage/controlplane.md`](../../docs/usage/controlplane.md)
- node 使用说明：[`../../docs/usage/node.md`](../../docs/usage/node.md)
- 架构设计：[`../../docs/development/ARCHITECTURE.md`](../../docs/development/ARCHITECTURE.md)
