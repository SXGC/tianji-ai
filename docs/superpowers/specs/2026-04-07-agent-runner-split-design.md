# Agent Runner 内外分离设计文档

**日期：** 2026-04-07  
**状态：** 待实现

---

## 背景与动机

当前所有 agent 调用统一走 ACP subprocess 模型：daemon 进程 spawn 子进程，通过 stdin/stdout JSON-RPC 通信。对内部原生 agent（`tianji-agent`）来说，这引入了三个问题：

1. **symlink 问题**：pnpm workspace 环境下 `isMain` 判断因 symlink 路径失效，spawn 内部 agent 时需要特殊处理 PATH。
2. **不必要的 IPC 开销**：同仓库代码走 subprocess + JSON-RPC，序列化/反序列化纯属浪费。
3. **调试困难**：daemon stdio 被 ignore，内部 agent 的 stderr 无法直接观察。

**目标**：内部原生 agent 在 daemon 进程内直接以函数调用方式运行；外部 agent（claude、codex 等）保留 ACP subprocess 模型不变。

---

## 核心概念

### Agent 类型判断

`@tianji/shared` 已有 `resolveAgentType(config: TianjiAgentConfig): 'native' | 'external'`：

- `command` 未设置或 `=== 'tianji-agent'` → `'native'`
- 其他 command（如 `claude`、`codex`）→ `'external'`

### 当前调用链

```
ControlPlane 下发 Command
  → TaskExecutor.execute(command)
  → createRunner(command)         → new AgentRunner(...)    ← 所有 agent 统一走这里
  → AgentRunner.connect()         → spawn 子进程 (ACP)
  → AgentRunner.chat(goal)        → stdin/stdout JSON-RPC
  → AgentRunner.disconnect()      → kill 子进程
```

### 目标调用链

```
ControlPlane 下发 Command
  → TaskExecutor.execute(command)
  → createRunner(command)
      ├─ native agent  → new InProcessAgentRunner(...)   ← 直接函数调用
      └─ external agent → new AgentRunner(...)           ← ACP subprocess（不变）
```

---

## 架构设计

### 1. `IAgentRunner` 接口

提取公共行为为接口，`TaskExecutor` 改为依赖接口而非具体类：

```typescript
// apps/node/src/acp/runner-interface.ts
interface IAgentRunner {
  readonly agentId: string
  connect(): Promise<void>
  chat(prompt: string): AsyncIterable<RuntimeEvent>
  disconnect(): Promise<void>
}
```

`AgentRunner` 已满足此接口（结构兼容，TypeScript duck typing）。

### 2. `InProcessAgentRunner`

同进程实现，`connect()` 时加载 agent 上下文并创建 `AgentSession`：

```
apps/node/src/acp/in-process-runner.ts
  └── InProcessAgentRunner
        ├── connect()     → loadAgentContextForName() + createAgentSession()
        ├── chat(prompt)  → AgentSession.chat(prompt)，yield RuntimeEvent 流
        └── disconnect()  → 调用 session.abort()（若存在）后置 session = null
```

#### 事件契约等价性要求

`AgentSession.chat()` 输出的事件流必须与 `AgentRunner` 经 ACP 协议适配后输出的 `RuntimeEvent` 流完全等价，包括：

- **错误事件**：错误类型、格式与 `AgentRunner` 的 `mapSessionUpdateToRuntimeEvent` 转换结果保持一致
- **中间消息顺序**：事件顺序不得与 TaskExecutor 状态机的预期消费顺序冲突
- **结束事件唯一性**：`run.completed` 事件必须恰好出现一次，不能重复或缺失
- **abort/disconnect 收尾语义**：调用 `disconnect()` 后正在执行的 `chat()` 必须尽快终止并关闭事件流；`session.abort()` 是首选机制，实现时需确认 AgentSession 是否暴露该能力

实现前需通过代码审查或单测验证以上四点与旧链路行为一致。

### 3. `loadAgentContextForName`（新增至 `@tianji/agent`）

从已有 `LoadedAgentContext` 派生指定 agent 的上下文，复用 paths/config/snapshotStore，只额外读取对应 agent 的 soul 文件：

```typescript
// packages/agent/src/context.ts
async function loadAgentContextForName(
  agentName: string,
  baseContext: LoadedAgentContext
): Promise<LoadedAgentContext>
```

#### 字段共享与隔离规则

返回的新 `LoadedAgentContext` 字段按如下策略处理：

| 字段 | 策略 | 原因 |
|------|------|------|
| `paths` | 共享引用 | 只读路径结构，无并发写入风险 |
| `snapshotStore` | 共享引用 | 设计为并发安全的存储抽象 |
| `config` | **浅拷贝**，agent 级字段覆盖 | 防止多 session 并发时互相污染 agent 特定配置 |
| `soul` | 新对象 | 每个 agent 有独立 soul |

调用方对返回的上下文拥有独立的 agent 级配置视图，不影响 baseContext 及其他 runner。

### 4. `controlplane-runtime.ts` 路由分支

`ControlPlaneRuntimeConfig` 新增可选字段 `nativeAgentContext?: LoadedAgentContext`，`createRunner` 工厂路由逻辑：

```
createRunner(agentId, config, nativeAgentContext):
  1. 若 agentConfigs 中不存在 agentId 对应的配置
       → 抛出明确错误（见边界处理第 1 条），不进入 resolveAgentType
  2. 若 config 存在：
       resolveAgentType(config) === 'native' && nativeAgentContext 存在
         → InProcessAgentRunner
       其他情况
         → AgentRunner（向后兼容）
```

**`nativeAgentContext` 入口范围：**

| 入口 | 是否传入 nativeAgentContext |
|------|----------------------------|
| `daemon-entry.ts` | 是，传入完整 daemon context |
| 单元测试（通过 deps.createTaskExecutor 覆盖） | 否，不受影响 |
| 其他脚本/CLI 入口 | 否，fallback subprocess，行为与改动前一致 |

仅 daemon 入口走 in-process 路径，其余入口静默降级到 subprocess 是**有意设计**，不是缺陷。测试须分别覆盖两条路径（见验证部分）。

### 5. `daemon-entry.ts` 传入上下文

```typescript
createControlPlaneRuntime({
  ...controlPlaneConfig,
  agentConfigs: context.config.agents?.items ?? {},
  nativeAgentContext: context,   // ← 新增
  ...
})
```

---

## 数据流对比

| 维度 | 旧（ACP subprocess） | 新（InProcess） |
|------|---------------------|-----------------|
| 进程数 | daemon + agent 子进程 | 仅 daemon |
| 通信方式 | stdin/stdout JSON-RPC | 直接函数调用 |
| 序列化 | JSON encode/decode | 无 |
| 事件来源 | ACP SessionUpdate → mapSessionUpdateToRuntimeEvent | runtime.streamEvents() 直接 yield |
| run.completed | AgentRunner 手动追加 | runtime 已内置 yield |
| 调试 | stderr 不可见 | 直接在 daemon 日志中可见 |

---

## 变更文件清单

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `packages/agent/src/context.ts` | 修改 | 新增 `loadAgentContextForName` |
| `packages/agent/src/index.ts` | 修改 | 导出新函数 |
| `apps/node/src/acp/runner-interface.ts` | 新增 | `IAgentRunner` 接口 |
| `apps/node/src/acp/in-process-runner.ts` | 新增 | `InProcessAgentRunner` 实现 |
| `apps/node/src/acp/index.ts` | 修改 | 导出新增内容 |
| `apps/node/src/task/task-executor.ts` | 修改 | `createRunner` 类型改为 `IAgentRunner` |
| `apps/node/src/node-runtime/controlplane-runtime.ts` | 修改 | 配置加 `nativeAgentContext`，路由分支 |
| `apps/node/src/daemon-entry.ts` | 修改 | 传入 `nativeAgentContext: context` |
| `apps/node/src/acp/__tests__/in-process-runner.test.ts` | 新增 | `InProcessAgentRunner` 单元测试 |
| `apps/node/src/task/__tests__/task-executor.test.ts` | 修改 | stub 类型从 `AgentRunner` 改为 `IAgentRunner` |

---

## 边界处理

- `agentConfigs` 中不存在的 agentId → **直接抛出明确错误**，不构造空 config 进入 resolveAgentType，不静默降级。原因：空 config 会导致 `command === undefined`，被误判为 native，与预期相反。
- `nativeAgentContext` 未传（如测试通过 `deps.createTaskExecutor` 覆盖）→ 完全不受影响，走 AgentRunner 路径
- `loadAgentContextForName` 找不到指定 agent → 抛出明确错误
- `loadAgentContextForName` agent 无 `model` 字段 → 抛出明确错误（native agent 必须有 model）

---

## 验证方式

```bash
# 类型检查 + lint
pnpm check

# 单元测试（在 apps/node 包内执行）
cd apps/node && pnpm test

# 冒烟测试（需要 .env.test）
SMOKE_E2E=1 pnpm --filter @tianji/node test:smoke
```

### 必须覆盖的专项测试

以下测试须在实现阶段逐一落地，缺一不可：

| 测试文件 | 测试场景 |
|----------|---------|
| `in-process-runner.test.ts` | native runner 正常 chat 流程（in-process 函数调用路径） |
| `in-process-runner.test.ts` | disconnect() 后 chat() 事件流终止，资源正确释放 |
| `in-process-runner.test.ts` | AgentSession 事件流等价性：错误事件、completed 唯一性 |
| `task-executor.test.ts` | createRunner 分流：native + nativeAgentContext → InProcessAgentRunner |
| `task-executor.test.ts` | createRunner 分流：external → AgentRunner（subprocess 路径未退化） |
| `task-executor.test.ts` | createRunner 分流：nativeAgentContext 缺省时 native agent 也走 AgentRunner |
| `task-executor.test.ts` | agentId 在 agentConfigs 中不存在 → 抛出明确错误 |
| `task-executor.test.ts` | loadAgentContextForName：agent 无 model 字段 → 抛出明确错误 |
