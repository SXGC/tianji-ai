# E2E 测试设计文档：Daemon 子命令模式

> 对应未提交变更：`apps/cli/src/main.ts` + `apps/cli/src/__tests__/main-daemon.test.ts`
> 日期：2026-03-31

## 一、变更范围

将 daemon 命令从顶层扁平模式重构为子命令模式：

| 旧命令 | 新命令 |
|--------|--------|
| `tianji daemon [--fg]` | `tianji daemon start [--fg]` |
| `tianji status` | `tianji daemon status` |
| `tianji stop` | `tianji daemon stop` |
| _(无)_ | `tianji daemon restart` (新增) |
| `tianji daemon` (无参数) | 报错 "Missing daemon subcommand" |

新增的 `restart` 实现为 `stop + start`：先 shutdown 现有 daemon，清理残留文件，再 fork 新进程。

### 涉及文件

| 文件 | 变更类型 |
|------|----------|
| `apps/cli/src/main.ts` | 重构 `DaemonCommand` 增加 `subcommand` 字段，删除 `StatusCommand`/`StopCommand`，新增 `parseDaemonCommandArgs`、`handleDaemonRestartCommand` |
| `apps/cli/src/__tests__/main-daemon.test.ts` | 重写为子命令解析测试 |

## 二、现有测试覆盖清单

### 已覆盖

| 文件 | 覆盖范围 |
|------|----------|
| `main-daemon.test.ts` | 解析：`daemon start`/`start --fg`/`status`/`stop`/`restart`；拒绝：无子命令/未知子命令/`--bad`/非 start 带参数/旧顶层 `status`/`stop`；runCli：无 daemon 时 `daemon status` 返回 1 |
| `daemon-server.test.ts` | `/ping` 元数据、`/chat` SSE 流 + done、并发 BUSY、shutdown 清理文件/幂等、404、400、内部错误 |
| `daemon-client.test.ts` | ping/shutdown/sendChat 正常流、SSE error 抛出、非 2xx 抛出 |
| `daemon-protocol.test.ts` | `encodeSseMessage` 编码、常量值、类型形状 |

### 未覆盖（本次 e2e 补充目标）

| 场景 | 涉及命令 | 缺失原因 |
|------|---------|----------|
| daemon start --fg 完整生命周期 | `daemon start --fg` → ping → shutdown | 需要真实 DaemonServer + Client 联动 |
| daemon start 检测已运行 daemon | `daemon start` | 需要模拟已有 daemon 场景 |
| daemon stop 成功停止 | `daemon stop` | 需要真实 DaemonServer |
| daemon stop 无 daemon 时报错 | `daemon stop` | 类似 status 场景但未测试 |
| daemon restart 完整流程 | `daemon restart` | 全新逻辑 |
| daemon restart 无已有 daemon | `daemon restart` | 边界条件 |
| daemon restart --fg | `daemon restart --fg` | 前台模式 |
| stale 文件清理后启动 | `daemon start` | 需要模拟残留文件 |
| chat REPL 基本交互 | `chat` | 需要 readline mock + 真实 DaemonServer |
| chat 无 daemon 时报错 | `chat` | 未测试 |
| 完整端到端旅程 | start → status → chat → stop | 多步联动 |

## 三、基础设施修复

`createTempCliPaths()` 当前缺少 `daemonPortPath` 和 `daemonPidPath`（`cli-test-utils.ts:172-178`），无法用于 daemon 相关的 runCli 测试。需要补充：

```typescript
// cli-test-utils.ts - createTempCliPaths 返回值补充
daemonPortPath: join(configDir, 'daemon.port'),
daemonPidPath: join(configDir, 'daemon.pid'),
```

## 四、测试用例设计

新增测试文件：`apps/cli/src/__tests__/daemon-e2e.test.ts`

### 辅助工具

| 工具 | 用途 |
|------|------|
| `setupLiveDaemon(session, paths?)` | 启动真实 `DaemonServer`，返回 `{ server, client, cleanup }` |
| `runCommand(argv, deps)` | 调用 `runCli` 并捕获 stdout，返回 `{ exitCode, stdout }` |
| `createStubSession(events)` | 构造可控事件流的 stub `AgentSession`（复用现有模式） |
| `createBlockingSession()` | 构造可阻塞的 session，用于并发和 shutdown 等待测试 |

### A. daemon start 测试组

| 编号 | 用例名称 | 优先级 | 测试步骤 | 验证点 |
|------|---------|--------|----------|--------|
| A1 | 前台启动 + ping + 停止完整生命周期 | P0 | 1. setupLiveDaemon(stubSession, paths)<br>2. client.ping()<br>3. 收集 sendChat 事件<br>4. client.shutdown() | port > 0；ping 返回有效 sessionId/pid/uptime；sendChat 收到预期事件；shutdown 后 port/pid 文件被删除 |
| A2 | 检测到已运行 daemon 时不重复启动 | P0 | 1. setupLiveDaemon(stubSession)<br>2. 写 port 文件指向 server.port<br>3. runCli(['daemon', 'start'], { getUserConfigPaths }) | stdout 包含 "already running"；退出码 0 |
| A3 | stale 残留文件时清理后正常启动 | P1 | 1. 写 port 文件（端口 9999，无进程监听）<br>2. 写 pid 文件<br>3. runCli(['daemon', 'start', '--fg'], deps) | 旧文件被清理；stdout 包含 "Daemon listening" |

### B. daemon status 测试组

| 编号 | 用例名称 | 优先级 | 测试步骤 | 验证点 |
|------|---------|--------|----------|--------|
| B1 | 有 daemon 时显示运行信息 | P0 | 1. setupLiveDaemon(stubSession, paths)<br>2. runCli(['daemon', 'status'], deps) | stdout 包含 pid/port/sessionId/uptime；退出码 0 |
| B2 | 无 daemon 时返回错误 | P0 | 已在 `main-daemon.test.ts` 覆盖 | 退出码 1 |

### C. daemon stop 测试组

| 编号 | 用例名称 | 优先级 | 测试步骤 | 验证点 |
|------|---------|--------|----------|--------|
| C1 | 成功停止 daemon | P0 | 1. setupLiveDaemon(stubSession, paths)<br>2. runCli(['daemon', 'stop'], deps) | stdout 包含 "Daemon stopped"；退出码 0；server 端收到 shutdown |
| C2 | 无 daemon 时返回错误 | P0 | 1. runCli(['daemon', 'stop'], { 无 port 文件的 paths }) | stderr 包含 "No daemon running"；退出码 1 |

### D. daemon restart 测试组

| 编号 | 用例名称 | 优先级 | 测试步骤 | 验证点 |
|------|---------|--------|----------|--------|
| D1 | 有 daemon 时重启（stop + start） | P0 | 1. setupLiveDaemon(stubSession, paths)<br>2. runCli(['daemon', 'restart'], deps) — 注入 loadContext/createSession 避免 fork | stdout 包含 "Daemon stopped" + "Daemon started"；退出码 0 |
| D2 | 无 daemon 时直接启动 | P1 | 1. runCli(['daemon', 'restart', '--fg'], deps) — 无 port 文件 | 无 "Daemon stopped"；stdout 包含 "Daemon listening" |
| D3 | daemon 已死但残留文件时清理后启动 | P1 | 1. 写 stale port/pid 文件<br>2. runCli(['daemon', 'restart', '--fg'], deps) | 文件被清理；正常启动 |
| D4 | restart --fg 前台模式 | P1 | 1. setupLiveDaemon + runCli(['daemon', 'restart', '--fg'], deps) | 不 fork 子进程；直接在前台启动 |

### E. chat 命令测试组

| 编号 | 用例名称 | 优先级 | 测试步骤 | 验证点 |
|------|---------|--------|----------|--------|
| E1 | chat 无 daemon 时报错 | P0 | runCli(['chat'], { 无 port 文件 }) | stderr 包含 "No daemon running"；退出码 1 |
| E2 | chat 单轮对话流式输出 | P0 | 1. setupLiveDaemon(stubSession, paths)<br>2. 直接调用 client.sendChat("hello") | 收到全部 RuntimeEvent |
| E3 | chat 多轮共享 session | P1 | 1. 构造记录 prompt 的 session<br>2. client.sendChat 两轮<br>3. 检查 session 记录 | 两轮 prompt 都被记录；sessionId 相同 |

### F. 端到端集成场景

| 编号 | 用例名称 | 优先级 | 测试步骤 | 验证点 |
|------|---------|--------|----------|--------|
| F1 | 完整旅程：start → status → chat → stop → status 失败 | P0 | 1. 前台启动 daemon<br>2. status 验证运行中<br>3. sendChat 验证对话<br>4. stop 停止<br>5. status 验证已停止 | 每步均成功；最后一步退出码 1 |
| F2 | restart 后新 daemon 可用 | P1 | 1. 启动 daemon<br>2. restart<br>3. 验证新 daemon 可 ping | 新 session 与旧 session 不同 |

## 五、依赖注入策略

`handleDaemonStartCommand` 和 `handleDaemonRestartCommand` 内部调用 `fork()` 和 `runDaemonEntry()`，无法直接 stub。对于 e2e 测试，采用两种策略：

**策略 1：使用 `--fg` 前台模式 + stub session（推荐）**

通过 `RunCommandDependencies` 注入 `loadContext` 和 `createSession`，配合 `--fg` 模式避免 fork。但当前 `handleDaemonStartCommand(--fg)` 调用的是 `runDaemonEntry()`（硬编码 `loadAgentContext` + `createAgentSession`），不走 deps 注入。

这意味着需要将 `runDaemonEntry` 的依赖也通过 deps 传入，或者在测试中直接使用 `DaemonServer` + `DaemonClient` 对象绕过 CLI 调度层。

**策略 2：直接使用 DaemonServer + DaemonClient（当前可行）**

不经过 `runCli` 调度，直接在测试中创建 `DaemonServer` 实例并启动，然后通过 `DaemonClient` 连接。CLI 命令处理逻辑通过 `runCli` 测试（仅覆盖到 `requireDaemonClient` 层级）。

**建议采用策略 2**，因为：
- `DaemonServer`/`DaemonClient` 已有完整的单元测试
- CLI 调度层的逻辑（解析、分支、错误处理）已有 `main-daemon.test.ts` 覆盖
- e2e 层需要验证的是两者联动的集成行为，不需要再经过 CLI 参数解析

## 六、测试文件结构

```
apps/cli/src/__tests__/daemon-e2e.test.ts
├── 辅助工具
│   ├── setupLiveDaemon(session, paths?)
│   ├── runCommand(argv, deps)
│   ├── createStubSession(events)
│   └── createBlockingSession()
├── describe('daemon start')
│   ├── A1: 前台启动完整生命周期
│   ├── A2: 检测已运行 daemon
│   └── A3: stale 文件清理后启动
├── describe('daemon status')
│   ├── B1: 有 daemon 时显示信息
│   └── B2: 无 daemon 时返回错误 (已有)
├── describe('daemon stop')
│   ├── C1: 成功停止
│   └── C2: 无 daemon 时返回错误
├── describe('daemon restart')
│   ├── D1: stop + start 完整流程
│   ├── D2: 无 daemon 时直接启动
│   └── D3: stale 文件清理后启动
├── describe('chat')
│   ├── E1: 无 daemon 时报错
│   ├── E2: 单轮对话流式输出
│   └── E3: 多轮共享 session
└── describe('end-to-end')
    ├── F1: start → status → chat → stop → status 失败
    └── F2: restart 后新 daemon 可用
```

## 七、注意事项

1. **`createTempCliPaths` 修复**：必须补充 `daemonPortPath`/`daemonPidPath` 字段，否则 `runCli` 中 `readDaemonPort` 读取路径为 undefined
2. **端口隔离**：所有测试用 `server.listen(0)` 随机端口
3. **时序控制**：并发测试（如 BUSY 场景）需要 `setTimeout` 确保第一个请求先到达
4. **timeout**：涉及真实 HTTP 通信的测试建议每个 it 设置 15s timeout
5. **afterEach 清理**：确保每个测试结束后 shutdown DaemonServer 并清理临时文件
