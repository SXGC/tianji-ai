# Daemon 注册状态检查与 Heartbeat PID 上报 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** daemon start/restart 后检查 controlplane 注册是否成功并反馈给用户；heartbeat 和 register 请求携带可选 pid 字段，controlplane 存储并在日志中打印。

**Architecture:** 分三层改动：shared 协议层增加 pid 字段 → controlplane 存储和打印 pid → node 端传递 pid 并在 start/restart 后轮询注册状态。

**Tech Stack:** TypeScript, SQLite (better-sqlite3), Hono

---

### Task 1: shared 协议层增加 pid 字段

**Files:**
- Modify: `packages/shared/src/node-types.ts:26-47`

- [ ] **Step 1: 在 NodeRegisterRequest 和 NodeHeartbeatRequest 中增加可选 pid 字段**

```typescript
// NodeRegisterRequest 增加:
readonly pid?: number

// NodeHeartbeatRequest 增加:
readonly pid?: number
```

- [ ] **Step 2: 运行 pnpm check 确认类型无误**

Run: `pnpm check`

---

### Task 2: controlplane 数据库 schema 增加 pid 列

**Files:**
- Modify: `apps/controlplane/src/db/schema.ts:16-31`

- [ ] **Step 1: nodes 表增加 pid 列**

在 `last_heartbeat_at` 行之前增加：
```sql
pid INTEGER,
```

- [ ] **Step 2: 运行 pnpm check 确认无误**

Run: `pnpm check`

---

### Task 3: controlplane 注册路由存储和打印 pid

**Files:**
- Modify: `apps/controlplane/src/routes/node-register.ts`

- [ ] **Step 1: INSERT 和 UPDATE 语句中增加 pid 字段**

新注册 INSERT 增加 `pid` 列和值 `body.pid ?? null`。
已有 node UPDATE 增加 `pid = ?` 和值 `body.pid ?? null`。

- [ ] **Step 2: 日志中打印 pid**

在 `logger.info` 的 metadata 中增加 `pid: body.pid ?? null`，同时适用于新注册和重新注册。

- [ ] **Step 3: 运行 pnpm check**

Run: `pnpm check`

---

### Task 4: controlplane 心跳路由存储和打印 pid

**Files:**
- Modify: `apps/controlplane/src/routes/node-heartbeat.ts`

- [ ] **Step 1: UPDATE 语句中增加 pid 字段**

```sql
UPDATE nodes SET
  status = 'online',
  execution_state = ?,
  pid = ?,
  last_heartbeat_at = ?,
  updated_at = ?
WHERE node_id = ?
```

参数增加 `body.pid ?? null`。

- [ ] **Step 2: 日志中打印 pid**

在 `logger.debug` 的 metadata 中增加 `pid: body.pid ?? null`。

- [ ] **Step 3: 运行 pnpm check**

Run: `pnpm check`

---

### Task 5: node 端 client 和 connection-loop 传递 pid

**Files:**
- Modify: `apps/node/src/controlplane/client.ts:54-71`
- Modify: `apps/node/src/controlplane/connection-loop.ts:80-89,98-125`

- [ ] **Step 1: client.heartbeat() 增加 pid 参数**

```typescript
async heartbeat(
  executionState: NodeExecutionState,
  agentList?: readonly AgentInfo[],
  pid?: number
): Promise<void> {
  const body: NodeHeartbeatRequest = { executionState, agentList, pid }
  // ... 其余不变
}
```

- [ ] **Step 2: client.register() 请求 body 中传入 pid**

register 方法接收的 `request` 参数类型 `NodeRegisterRequest` 已含 pid，调用方传入即可。

- [ ] **Step 3: connection-loop 的 #register() 传入 process.pid**

```typescript
async #register(): Promise<void> {
  await this.#client.register({
    nodeId: this.#config.nodeId,
    enrollmentToken: this.#config.enrollmentToken,
    hostname: this.#config.hostname,
    platform: this.#config.platform,
    version: this.#config.version,
    agentList: this.#config.agentList,
    pid: process.pid,
  })
}
```

- [ ] **Step 4: connection-loop 的 #heartbeatOnce() 传入 process.pid**

```typescript
await this.#client.heartbeat(this.#executionState, undefined, process.pid)
```

- [ ] **Step 5: 运行 pnpm check**

Run: `pnpm check`

---

### Task 6: daemon start/restart 后检查 controlplane 注册状态

**Files:**
- Modify: `apps/node/src/commands/daemon.ts:175-202,339-356,461-475`
- Modify: `apps/node/src/i18n/locales/en.json`
- Modify: `apps/node/src/i18n/locales/zh-CN.json`

- [ ] **Step 1: 添加 i18n key**

en.json 增加：
```json
"daemon.controlplane.connected": "Controlplane registered successfully.",
"daemon.controlplane.failed": "Controlplane registration failed: {error}"
```

zh-CN.json 增加：
```json
"daemon.controlplane.connected": "controlplane 注册成功。",
"daemon.controlplane.failed": "controlplane 注册失败: {error}"
```

- [ ] **Step 2: 新增 waitForControlPlaneSettled 函数**

在 `daemon.ts` 中 `waitForDaemonReady` 之后增加：

```typescript
async function waitForControlPlaneSettled(
  paths: UserConfigPaths,
  timeoutMs = 15000
): Promise<ControlPlaneStatusSnapshot> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const client = await tryCreateDaemonClient(paths)
    if (client !== undefined) {
      try {
        const ping = await client.ping()
        if (ping.controlPlane.status !== 'connecting') {
          return ping.controlPlane
        }
      } catch {
        // daemon 还没响应，继续等
      } finally {
        client.close()
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return {
    enabled: true,
    status: 'degraded',
    baseUrl: null,
    lastSuccessAt: null,
    lastError: 'Timed out waiting for controlplane registration',
  }
}
```

- [ ] **Step 3: 在 start 命令的后台模式分支中增加注册状态检查**

在 `daemonStartCommand` handler 的 `process.stdout.write(... daemon.started ...)` 之后：

```typescript
const cpStatus = await waitForControlPlaneSettled(paths)
if (cpStatus.status === 'connected') {
  process.stdout.write(`${i18n.t('daemon.controlplane.connected')}\n`)
} else {
  process.stderr.write(`${i18n.t('daemon.controlplane.failed', { error: cpStatus.lastError ?? 'unknown' })}\n`)
  return 1
}
```

- [ ] **Step 4: 在 restart 命令的后台模式分支中增加同样的检查**

在 `daemonRestartCommand` handler 的 `process.stdout.write(... daemon.started ...)` 之后，加入同样的 `waitForControlPlaneSettled` + 输出逻辑。

- [ ] **Step 5: 运行 pnpm check**

Run: `pnpm check`

- [ ] **Step 6: 提交**

```bash
git add packages/shared/src/node-types.ts apps/controlplane/src/db/schema.ts apps/controlplane/src/routes/node-register.ts apps/controlplane/src/routes/node-heartbeat.ts apps/node/src/controlplane/client.ts apps/node/src/controlplane/connection-loop.ts apps/node/src/commands/daemon.ts apps/node/src/i18n/locales/en.json apps/node/src/i18n/locales/zh-CN.json
git commit -m "feat: daemon start/restart 检查注册状态，heartbeat/register 上报 pid"
```
