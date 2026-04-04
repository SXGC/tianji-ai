# Tianji AI 运行时设计文档

> 状态：当前
> 日期：2026-04-03
> 相关文档：[`./ARCHITECTURE.md`](./ARCHITECTURE.md)、[`./CONFIG_DESIGN.md`](./CONFIG_DESIGN.md)
> 范围：`@tianji/runtime` 包的内部设计——会话生命周期、执行引擎、快照持久化、工具系统、事件流与 LLM 网关。

---

## 1. 定位与职责

`@tianji/runtime` 是 L1 执行层，承载"从配置到运行"的核心路径：

- **中心化配置加载**：三层 JSON 读取、schema 校验、placeholder 解析
- **会话运行时**：session / run 生命周期管理
- **执行引擎**：基于 deepagents，使用 LangGraph 状态机驱动
- **快照持久化**：session / run 快照的存取
- **工具系统**：注册、策略校验、执行
- **事件流**：可重放的异步事件流
- **LLM 网关**：作为内部模块封装 AI SDK 多 provider 适配

runtime 不负责配置组装、agent 定义解析、SOUL.md 加载——这些属于上层 `@tianji/agent` 的职责。

---

## 2. 会话生命周期

### 2.1 核心概念

| 概念 | 说明 |
|------|------|
| **Session** | 一组连续对话的容器，拥有唯一 `SessionId`，持有消息历史 |
| **Run** | 一次 assistant turn 的完整执行，拥有唯一 `RunId`，归属于某个 session |
| **ActiveRun** | 正在执行中的 run，持有 `AbortController` 与 `ReplayableEventStream` |

### 2.2 Session 状态

```
created ──→ (runTurn / resumeRun 可多次调用) ──→ closeSession
```

Session 是长生命周期对象。`closeSession` 会标记关闭并中止所有活跃 run。

### 2.3 Run 状态机

```
running ──→ completed    (正常结束)
       ├──→ cancelled    (用户取消 或 HITL 中断)
       └──→ failed       (执行异常)
```

| 状态 | 触发条件 |
|------|---------|
| `running` | `runTurn()` 或 `resumeRun()` 创建 run 后立即进入 |
| `completed` | deepagents 引擎正常返回最终消息 |
| `cancelled` | 用户调用 `cancelRun()`，或引擎返回 HITL 中断 |
| `failed` | 执行过程中抛出未捕获异常 |

### 2.4 Run 谱系

每个 run 记录：

- `triggerType`：`'new'`（新 turn）或 `'resume'`（恢复已取消的 run）
- `parentRunId`：仅 resume 类型存在，指向被恢复的原 run

Resume 要求原 run 处于 `cancelled` 状态且携带 checkpoint 元数据。

---

## 3. 公共 API

### 3.1 SessionRuntime 接口

```typescript
interface SessionRuntime {
  createSession(options?: CreateSessionOptions): Promise<SessionSnapshot>
  closeSession(sessionId: SessionId): Promise<void>
  getSessionSnapshot(sessionId: SessionId): Promise<SessionSnapshot | undefined>
  getRunSnapshot(runId: RunId): Promise<RunSnapshot | undefined>
  runTurn(options: RunTurnOptions): Promise<RunId>
  resumeRun(options: ResumeRunOptions): Promise<RunId>
  streamEvents(runId: RunId): AsyncIterable<RuntimeEvent>
  cancelRun(runId: RunId): Promise<boolean>
}
```

通过 `createSessionRuntime(options)` 工厂函数创建实例。

### 3.2 SessionRuntimeOptions

```typescript
interface SessionRuntimeOptions {
  deepagents: SessionRuntimeDeepagentsConfig
  snapshotStore: SnapshotStore
  toolCatalog: ToolCatalog
  logger?: ObserverLogger
}
```

`deepagents` 配置块支持以下字段：

| 字段 | 说明 |
|------|------|
| `model` | 模型标识符（字符串）或 LangChain `BaseLanguageModel` 实例 |
| `middleware` | 透传给 deepagents 的中间件数组 |
| `subagents` | 子 agent 定义 |
| `skills` | 技能路径 |
| `interruptOn` | HITL 中断配置 |
| `backend` | 状态后端（`state-backend`） |
| `checkpointer` | 检查点存储（`memory-saver`） |
| `store` | KV 存储（`memory-store`） |

---

## 4. 执行引擎：deepagents

### 4.1 执行流程

```
runTurn()
  → validateSession()
  → appendUserMessage()
  → createRunSnapshot(status: 'running')
  → executeDeepagentsRun()     ← 异步执行
      → createDeepAgent()
      → streamEvents()
          → on_chat_model_stream  → 文本/工具调用增量
          → on_chat_model_end     → 工具调用确认
          → on_chain_end          → 最终消息构建
      → readStateSnapshot()     → 检查 HITL 中断
      → buildResult()
  → updateRunSnapshot()
  → updateSessionMessages()
```

### 4.2 工具调用处理

引擎在流式事件中追踪工具调用：

1. **观测阶段**：`on_chat_model_stream` 事件中收集 `DeepagentsPendingToolCall[]`，合并分块到达的参数
2. **匹配阶段**：通过 `stableSerialize()` 确定性序列化参数，将执行请求与流式观测配对
3. **执行阶段**：
   - 调用 `ensureToolAllowed()` 执行策略校验
   - 通过 `executeWithTimeout()` 合并超时信号与外部取消信号
   - 记录 pending operation 状态
   - 如果工具标记为 `destructive`，记录副作用

### 4.3 HITL（Human-in-the-Loop）中断

当 deepagents 返回中断时：

1. Run 状态设为 `cancelled`
2. Metadata 中写入 `threadId` + `checkpointId`
3. 中断载荷存入 `RunSnapshot`
4. 后续通过 `resumeRun()` 传入 `resumeValue` 恢复执行

### 4.4 消息转换

**入方向（AppMessage → deepagents）**：
- 展平 content 数组为字符串
- 保留 text、thinking、image 元数据
- 工具调用编码为可读占位符：`[tool-call id=... name=... args=...]`

**出方向（deepagents → AppMessage）**：
- 从最终事件提取 assistant 文本
- 回退到聚合的流式文本
- Content 始终为 parts 数组格式

### 4.5 取消机制

取消通过 `AbortSignal` 组合实现：

```
用户取消 (cancelRun)  ─┐
                        ├── mergedSignal ──→ 中止执行
工具超时              ─┘
```

`createAbortSignalScope()` 将多个信号源合并为一个。取消后根据 pending operations 的状态判断 `resumeHint`：

- 有副作用的操作被中止 → `'require-user-confirmation'`
- 无副作用 → `'replay'`

---

## 5. 快照持久化

### 5.1 SnapshotStore 接口

```typescript
interface SnapshotStore {
  saveSession(snapshot: SessionSnapshot): Promise<void>
  saveRun(snapshot: RunSnapshot): Promise<void>
  loadSession(sessionId: SessionId): Promise<SessionSnapshot | undefined>
  loadRun(runId: RunId): Promise<RunSnapshot | undefined>
  listRuns(sessionId: SessionId): Promise<readonly RunSnapshot[]>
}
```

### 5.2 实现

| 实现 | 特点 |
|------|------|
| `InMemorySnapshotStore` | Map 存储，save/load 时深拷贝隔离，进程重启后丢失 |
| `FileSnapshotStore` | 文件系统持久化，原子写入（先写 `.tmp` 再 rename），懒创建目录 |

**FileSnapshotStore 文件布局**：

```
{baseDir}/
├─ sessions/
│  └─ {sessionId}.json
└─ runs/
   └─ {runId}.json
```

### 5.3 Run 元数据编码

RunSnapshot.metadata 中存储引擎特定信息：

```json
{
  "runtime": {
    "engine": "deepagents",
    "threadId": "session_xxx",
    "checkpointId": "checkpoint_yyy"
  },
  "systemPrompt": "...",
  "generationConfig": { ... },
  "resumedFromRunId": "run_zzz"
}
```

---

## 6. 工具系统

### 6.1 核心类型

```typescript
interface RuntimeToolDefinition {
  spec: ToolSpec                                    // 名称、描述、JSON Schema 参数
  execute: (args: unknown, context: RuntimeToolExecutionContext) => Promise<unknown>
  sideEffect?: 'none' | 'idempotent' | 'destructive'
}
```

### 6.2 ToolRegistry

Builder 模式的工具注册器：

```typescript
const registry = new ToolRegistry()
  .registerTool(toolA)
  .registerTool(toolB)

const catalog = registry.createCatalog(['toolA'])  // 创建固定子集
```

`createCatalog()` 返回不可变的 `ToolCatalog` 快照。

### 6.3 策略校验

```typescript
function ensureToolAllowed(
  definition: RuntimeToolDefinition,
  allowDestructive: boolean
): void
```

在工具执行前调用。如果工具声明 `sideEffect: 'destructive'` 而策略不允许，抛出 `PolicyError`。策略来源于 `RunSnapshot.policy.tool.allowDestructive`。

### 6.4 Pending Operations

Run 执行期间追踪每个工具调用的状态：

```typescript
interface PendingOperation {
  readonly id: string
  readonly invocation: ToolInvocation
  readonly status: 'running' | 'completed' | 'aborted-clean' | 'aborted-with-side-effect'
  readonly timestamp: number
}
```

用于取消后判断是否需要用户确认才能恢复。

---

## 7. 事件流

### 7.1 ReplayableEventStream

```typescript
class ReplayableEventStream<T> implements AsyncIterable<T> {
  push(event: T): void        // 写入事件，唤醒等待者
  close(): void               // 标记完成
  fail(error: Error): void    // 标记失败
  [Symbol.asyncIterator]()    // 从头消费，支持多消费者
}
```

**设计特点**：

- **可重放**：新 iterator 从 index 0 开始，可重新消费全部历史
- **背压**：`next()` 在无事件时异步等待
- **错误传播**：`fail()` 后所有迭代抛出异常
- **多消费者**：多个 `for await` 循环可以独立消费同一流

### 7.2 生命周期

```
创建 ──→ push(event)* ──→ close() 或 fail(error)
                              │
                         消费者收到 done / throw
```

---

## 8. LLM 网关（内部模块）

LLM 网关是 runtime 的内部实现，不通过公共 API 暴露。位于 `src/llm/`。

### 8.1 架构

```
factory.ts ──→ 根据 provider 选择具体 gateway
    ├── openai-gateway.ts      (基于 @ai-sdk/openai)
    ├── anthropic-gateway.ts   (基于 @ai-sdk/anthropic)
    └── google-gateway.ts      (基于 @ai-sdk/google)

sdk-gateway.ts ──→ 通用基类，统一 AI SDK 调用模式

message-conversion.ts  ──→ AppMessage ↔ CoreMessage 转换
tool-schema-bridge.ts  ──→ ToolSpec → AI SDK Tool schema
usage.ts               ──→ token 计数与成本计算
```

### 8.2 LlmGateway 接口（内部）

```typescript
interface LlmGateway {
  generate(request: LlmRequest): Promise<LlmResponse>
  stream(request: LlmRequest): Promise<LlmStream>
  isReady(): boolean
  getProviderInfo(): { provider: string; model: string }
}
```

### 8.3 LlmGenerationConfig

```typescript
interface LlmGenerationConfig {
  temperature?: number
  maxTokens?: number
  topP?: number
  stopSequences?: string[]
  seed?: number
  maxSteps?: number
  extra?: Record<string, unknown>
}
```

### 8.4 消息转换约束

AppMessage → CoreMessage 映射有严格限制：

| AppMessage 角色 | 允许的 content 类型 |
|----------------|-------------------|
| `system` | 仅 text（且只能一个） |
| `user` | text, image |
| `assistant` | text, thinking, tool-call |

不支持 file parts、binary images、redacted-reasoning，遇到时抛出 `ConversionError`。

### 8.5 Usage 计算

```typescript
function collectLlmUsage(
  sdkUsage: { promptTokens: number; completionTokens: number; totalTokens: number },
  pricing?: { inputCostPerMillionUsd: number; outputCostPerMillionUsd: number }
): LlmUsage
```

成本计算精度为小数点后 8 位。如果未提供 pricing，标记来源为 `'unavailable'`。

---

## 9. 中心化配置加载

配置加载是 runtime 的职责之一，但其设计细节见 [`CONFIG_DESIGN.md`](./CONFIG_DESIGN.md)。这里仅列出 runtime 侧的关键接口。

### 9.1 loadResolvedConfig()

按 `default < user < workspace` 顺序加载并合并三层配置：

1. **Default 层**：包内 `tianji.config.json`
2. **User 层**：`~/.config/tianji-ai/tianji.json`
3. **Workspace 层**：`~/.config/tianji-ai/workspaces/{workspace-id}.json`

返回 `ResolvedConfig`，包含最终配置、已解析的环境变量名、路径信息和各层元数据。

### 9.2 Workspace ID

```typescript
function createWorkspaceId(normalizedPath: string): string
// SHA-256(normalizedPath) 取前 16 字符
```

### 9.3 错误码

| 错误码 | 含义 |
|-------|------|
| `config.parse_error` | JSON 解析失败 |
| `config.schema_error` | Zod schema 校验失败 |
| `config.placeholder_error` | `${env:VAR}` 语法解析失败 |
| `config.env_missing` | 引用的环境变量不存在 |
| `config.workspace_resolution_error` | 工作区路径解析失败 |

---

## 10. 模块组织

```text
packages/runtime/src/
├─ index.ts              # 公共导出（受控）
├─ config.ts             # 中心化配置加载
├─ runtime.ts            # SessionRuntimeImpl
├─ event-stream.ts       # ReplayableEventStream
├─ snapshot-store.ts     # SnapshotStore + 两个实现
├─ tool-catalog.ts       # ToolRegistry + ToolCatalog
├─ engines/
│  └─ deepagents-engine.ts   # 执行引擎
└─ llm/                  # 内部模块，不公开导出
   ├─ index.ts
   ├─ factory.ts
   ├─ sdk-gateway.ts
   ├─ openai-gateway.ts
   ├─ anthropic-gateway.ts
   ├─ google-gateway.ts
   ├─ message-conversion.ts
   ├─ tool-schema-bridge.ts
   └─ usage.ts
```

---

## 11. 依赖约束

| 允许的外部依赖 | 允许的内部依赖 | 禁止依赖 |
|--------------|--------------|---------|
| `ai`, `@ai-sdk/*`, `@langchain/*`, `langchain`, `deepagents`, `zod` | `@tianji/shared`, `@tianji/observer` | `@tianji/agent`, `apps/*` |

LangChain / LangGraph 类型不通过公共 API 外泄。消费者只看到 `@tianji/shared` 定义的协议类型。
