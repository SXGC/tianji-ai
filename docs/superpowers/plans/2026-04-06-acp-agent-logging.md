# ACP Agent 执行链路日志补全 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 ACP agent 执行链路添加结构化日志，覆盖从进程 spawn 到 agent 会话完成的全流程，消除当前的可观测性盲区。

**Architecture:** node 侧（`apps/node/src/acp/`）使用现有的 `RuntimeLogger` 接口（logDebug/logInfo/logError），通过构造函数注入 logger。agent 侧（`packages/agent/src/`）因为运行在独立子进程中、stdout 被 ACP 协议占用，使用 `console.error`（写入 stderr，被父进程 inherit）输出关键生命周期日志。日志不需要测试。

**Tech Stack:** TypeScript, @tianji/observer（已有）, vitest

---

## 文件变更清单

| 操作 | 文件 | 职责 |
|------|------|------|
| Modify | `apps/node/src/acp/agent-process.ts` | 添加进程 spawn/exit/kill 日志 |
| Modify | `apps/node/src/acp/agent-runner.ts` | 添加 connect/chat/disconnect 日志 |
| Modify | `apps/node/src/node-runtime/controlplane-runtime.ts` | 将 logger 传入 AgentRunner |
| Modify | `packages/agent/src/acp-entry.ts` | 添加启动/连接生命周期的 stderr 日志 |
| Modify | `packages/agent/src/acp/agent-bridge.ts` | 添加 ACP 方法调用的 stderr 日志 |

---

### Task 1: AgentProcessManager 添加日志

**Files:**
- Modify: `apps/node/src/acp/agent-process.ts`

- [ ] **Step 1: 添加 logger 参数并在关键生命周期点记录日志**

`AgentProcessManager` 构造函数增加可选 `logger` 参数，在 spawn、exit、kill 流程中添加日志：

```typescript
// agent-process.ts 顶部添加导入
import type { RuntimeLogger } from '../logger.js'

// AgentProcessConfig 增加 logger 字段
export interface AgentProcessConfig {
  readonly agentId: string
  readonly command: string
  readonly args?: readonly string[]
  readonly env?: Record<string, string>
  readonly logger?: RuntimeLogger
}

// class 内部添加字段
readonly #logger: RuntimeLogger | undefined

// constructor 中赋值
this.#logger = config.logger

// spawn() 方法中，在 this.#process = spawn(...) 之后添加：
void this.#logger?.logInfo(['acp', 'process'], 'Agent process spawned', {
  agentId: this.agentId,
  command: this.#config.command,
  pid: this.#process.pid,
})

// exit 回调中添加：
this.#process.on('exit', (code, signal) => {
  void this.#logger?.logInfo(['acp', 'process'], 'Agent process exited', {
    agentId: this.agentId,
    pid: currentProcess.pid,
    code,
    signal,
  })
  this.#process = null
})
// 注意：需要在注册 exit 前保存 currentProcess 引用：const currentProcess = this.#process

// kill() 方法中，在 currentProcess.kill('SIGTERM') 之后添加：
void this.#logger?.logDebug(['acp', 'process'], 'Sent SIGTERM to agent process', {
  agentId: this.agentId,
  pid: currentProcess.pid,
})

// SIGKILL 分支添加：
void this.#logger?.logWarn(['acp', 'process'], 'Agent process did not exit in time, sent SIGKILL', {
  agentId: this.agentId,
  pid: currentProcess.pid,
})
```

- [ ] **Step 2: 运行 pnpm check 确认编译通过**

Run: `pnpm check`

---

### Task 2: AgentRunner 添加日志

**Files:**
- Modify: `apps/node/src/acp/agent-runner.ts`

- [ ] **Step 1: 添加 logger 参数并在 connect/chat/disconnect 中记录日志**

`AgentRunnerConfig` 增加可选 `logger`，在关键节点记录：

```typescript
// 顶部导入
import type { RuntimeLogger } from '../logger.js'

// AgentRunnerConfig 增加
export interface AgentRunnerConfig {
  readonly agentId: string
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Record<string, string>
  readonly logger?: RuntimeLogger
}

// connect() 方法中添加日志：

// 1. 在 spawn 之前：
await this.#config.logger?.logInfo(['acp', 'runner'], 'Connecting to agent', {
  agentId: this.agentId,
  command: this.#config.command ?? DEFAULT_AGENT_COMMAND,
})

// 2. 将 logger 传入 AgentProcessManager：
this.#processManager = new AgentProcessManager({
  agentId: this.#config.agentId,
  command: this.#config.command ?? DEFAULT_AGENT_COMMAND,
  args: [...(this.#config.args ?? [])],
  env: this.#config.env,
  logger: this.#config.logger,
})

// 3. 在 initialize 完成后：
await this.#config.logger?.logDebug(['acp', 'runner'], 'ACP connection initialized', {
  agentId: this.agentId,
})

// 4. 在 newSession 完成后：
await this.#config.logger?.logInfo(['acp', 'runner'], 'ACP session created', {
  agentId: this.agentId,
  acpSessionId: this.#acpSessionId,
})

// chat() 方法中添加日志：

// 1. 在方法开头：
await this.#config.logger?.logInfo(['acp', 'runner'], 'Agent chat started', {
  agentId: this.agentId,
  promptLength: prompt.length,
})

// 2. 在 yield run.completed 之前：
await this.#config.logger?.logInfo(['acp', 'runner'], 'Agent chat completed', {
  agentId: this.agentId,
})

// disconnect() 方法中添加日志：

// 在方法开头：
await this.#config.logger?.logDebug(['acp', 'runner'], 'Disconnecting agent', {
  agentId: this.agentId,
})
```

- [ ] **Step 2: 运行 pnpm check 确认编译通过**

Run: `pnpm check`

---

### Task 3: controlplane-runtime 传递 logger 到 AgentRunner

**Files:**
- Modify: `apps/node/src/node-runtime/controlplane-runtime.ts`

- [ ] **Step 1: 在 createRunner 中将 logger 传入 AgentRunner**

`controlplane-runtime.ts` 第 145 行的 `new AgentRunner(...)` 调用需要添加 `logger`：

```typescript
// 在 createRunner 回调中（约 143-151 行），修改 new AgentRunner：
createRunner: async (command) => {
  const agentConfig = config.agentConfigs[command.payload.agentId]
  return new AgentRunner({
    agentId: command.payload.agentId,
    command: agentConfig?.command,
    args: agentConfig?.args,
    env: agentConfig?.env,
    logger: config.logger,
  })
},
```

- [ ] **Step 2: 运行 pnpm check 确认编译通过**

Run: `pnpm check`

---

### Task 4: ACP 入口添加 stderr 生命周期日志

**Files:**
- Modify: `packages/agent/src/acp-entry.ts`

- [ ] **Step 1: 在关键生命周期点添加 console.error 日志**

agent 子进程的 stdout 被 ACP 协议占用，只能用 stderr 输出日志。stderr 被父进程 inherit，会直接输出到 daemon 进程的 stderr。

```typescript
// runAcpAgent() 函数中添加：

// 1. 函数开头：
console.error('[acp-agent] Starting ACP agent process')

// 2. loadAgentContext 之后：
console.error('[acp-agent] Agent context loaded:', context.agent.agentName)

// 3. AgentSideConnection 创建后、await connection.closed 前：
console.error('[acp-agent] ACP connection established, waiting for requests')

// 4. connection.closed resolve 后（函数末尾）：
console.error('[acp-agent] ACP connection closed, agent exiting')
```

- [ ] **Step 2: 运行 pnpm check 确认编译通过**

Run: `cd packages/agent && pnpm run typecheck`

---

### Task 5: agent-bridge 添加 stderr 方法调用日志

**Files:**
- Modify: `packages/agent/src/acp/agent-bridge.ts`

- [ ] **Step 1: 在 ACP 方法中添加日志**

```typescript
// initialize() 方法开头：
console.error('[acp-agent] Received initialize request')

// newSession() 方法中，在 return 前：
console.error('[acp-agent] New session created:', this.#currentSession!.sessionId)

// prompt() 方法中：
// 1. 方法开头：
console.error('[acp-agent] Received prompt request, session:', params.sessionId)

// 2. 在 for await 循环完成后（return stopReason 前）：
console.error('[acp-agent] Prompt completed')

// 3. 在 catch（如果需要 catch）或者 aborted 分支：
// aborted 分支已有 return { stopReason: 'cancelled' }，在前面加：
console.error('[acp-agent] Prompt cancelled')

// cancel() 方法中：
console.error('[acp-agent] Received cancel request')
```

- [ ] **Step 2: 运行 pnpm check 确认编译通过**

Run: `cd packages/agent && pnpm run typecheck`

---

### Task 6: 最终验证

- [ ] **Step 1: 从仓库根目录运行 pnpm check**

Run: `pnpm check`
Expected: 零 error，零 warning。

- [ ] **Step 2: 运行受影响包的测试**

Run: `cd apps/node && pnpm test`
Run: `cd packages/agent && pnpm test`

因为日志是可选的（logger 为 undefined 时不输出），所有现有测试应继续通过，无需修改。

- [ ] **Step 3: Commit**

```bash
git add apps/node/src/acp/agent-process.ts apps/node/src/acp/agent-runner.ts apps/node/src/node-runtime/controlplane-runtime.ts packages/agent/src/acp-entry.ts packages/agent/src/acp/agent-bridge.ts
git commit -m "feat(acp): 为 agent 执行链路添加结构化日志

覆盖 agent-process spawn/exit/kill、agent-runner connect/chat/disconnect、
ACP 入口生命周期和 agent-bridge 方法调用。node 侧使用 RuntimeLogger，
agent 侧使用 stderr 输出。"
```
