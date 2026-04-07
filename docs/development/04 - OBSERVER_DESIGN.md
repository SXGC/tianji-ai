# Tianji AI Observer 设计文档

> 状态：当前
> 日期：2026-04-02
> 相关文档：[`01 - ARCHITECTURE.md`](./01%20-%20ARCHITECTURE.md)、[`03 - RUNTIME_DESIGN.md`](./03%20-%20RUNTIME_DESIGN.md)
> 范围：`@tianji/observer` 包的设计——结构化日志协议、sink 机制、数据脱敏、tracing 初始化。

---

## 1. 定位与职责

`@tianji/observer` 是独立于分层体系的横切基础设施包，为 CLI、runtime 和 agent 提供统一的可观测性原语：

- **结构化日志**：类型安全的日志 API，支持层级 scope、数据绑定、多 sink 写入
- **数据脱敏**：自动过滤敏感字段，规范化 Error 对象
- **分布式追踪**：基于 OpenTelemetry 的 span 创建与生命周期管理

observer 不关心日志的消费方式（终端展示、文件回放、聚合平台），只负责"写入"侧的协议与实现。

---

## 2. 结构化日志

### 2.1 JSONL 协议

每条日志是一行完整的 JSON 对象，遵循 `ObserverLogEntry` schema：

```json
{
  "timestamp": "2026-04-02T10:00:00.000Z",
  "level": "info",
  "scope": ["cli", "run", "config"],
  "message": "Loaded user config context",
  "data": {
    "agentName": "default",
    "provider": "openai"
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `timestamp` | `string` | ISO 8601 格式，由 `new Date().toISOString()` 生成 |
| `level` | `ObserverLogLevel` | 六个级别之一 |
| `scope` | `readonly [string, ...string[]]` | 非空字符串元组，表示日志来源层级 |
| `message` | `string` | 人类可读的日志消息 |
| `data` | `Record<string, unknown> \| undefined` | 可选的结构化上下文数据，经过脱敏处理 |

### 2.2 日志级别

六个级别按严重程度递增排列：

| 级别 | 用途 |
|------|------|
| `trace` | 最细粒度的调试信息 |
| `debug` | 开发阶段的诊断信息 |
| `info` | 关键业务流程节点 |
| `warn` | 可恢复的异常情况 |
| `error` | 需要关注的错误 |
| `fatal` | 不可恢复的致命错误 |

当前实现不做级别过滤——所有级别的日志都写入全部 sink。级别过滤是消费侧（如 `log -f`）的职责。

### 2.3 Scope 机制

Scope 是一个非空字符串元组（至少 1 个元素），表示日志的来源层级：

```typescript
type ObserverLogScope = readonly [string, ...string[]]
```

**层级拼接**：通过 `child()` 创建子 logger 时，scope 自动拼接：

```typescript
const parent = createObserverLogger({ sinks, scope: ['cli'] })
const child = parent.child({ scope: ['run'] })
// child 的 scope = ['cli', 'run']
```

**常见 scope 模式**：

| Scope | 含义 |
|-------|------|
| `['cli', 'run']` | CLI run 命令主流程 |
| `['cli', 'run', 'config']` | 配置加载 |
| `['cli', 'run', 'event']` | 运行时事件处理 |
| `['cli', 'log', 'follow']` | 日志跟踪 |
| `['cli', 'daemon']` | 守护进程管理 |

### 2.4 Bindings

Bindings 是附加到 logger 实例上的静态上下文数据，会自动合并到每条日志的 `data` 字段：

```typescript
const logger = createObserverLogger({
  sinks,
  bindings: { sessionId: 'sess_123' },
})
// 所有通过此 logger 写入的日志都会包含 sessionId
```

子 logger 的 bindings 与父级合并，子级覆盖父级同名字段。

---

## 3. Sink 机制

Sink 是日志写入的目标端，实现 `ObserverLogSink` 接口：

```typescript
interface ObserverLogSink {
  write(entry: ObserverLogEntry): Promise<void>
}
```

Logger 创建时接收 sink 数组，每条日志写入所有 sink。

### 3.1 JSONL File Sink

```typescript
createJsonlFileSink({ filePath: string }): ObserverLogSink
```

- 每条日志调用 `appendFile()` 追加一行 JSON + `\n`
- 写入前自动 `mkdir -p` 创建父目录
- 适合 `tail -f` 实时跟踪和日志聚合工具解析
- 默认日志路径：`~/.config/tianji-ai/logs/tianji.log`

### 3.2 Memory Sink

```typescript
createMemorySink(): ObserverMemorySink
```

- 将日志存入内存数组 `entries: ObserverLogEntry[]`
- `entries` 属性可同步访问
- 主要用于测试和临时检查

### 3.3 Stdout Sink

```typescript
createStdoutSink(options?: { pretty?: boolean }): ObserverLogSink
```

**默认模式**：输出完整 JSON 对象（与 JSONL file sink 格式一致）

**Pretty 模式**（`pretty: true`）：

```
[info] cli.run.config Loaded user config context {"agentName":"default"}
```

格式为 `[level] scope message {data}`，scope 用 `.` 连接。

---

## 4. 数据脱敏

### 4.1 设计决策

日志系统在写入侧统一执行脱敏，而非依赖调用方手动过滤。这确保敏感数据不会因为某个调用方忘记过滤而泄漏到日志文件。

脱敏策略是**完全移除**敏感字段（不是替换为 `***`），因为：
- 日志消费者无需知道敏感字段的存在
- 避免 `***` 掩码值被误当作有效数据

### 4.2 默认敏感字段

```typescript
const DEFAULT_SENSITIVE_KEYS = ['apiKey', 'prompt', 'soul'] as const
```

| 字段 | 过滤原因 |
|------|---------|
| `apiKey` | Provider API 密钥 |
| `prompt` | 用户原始输入 |
| `soul` | SOUL.md 系统提示词内容 |

通过 `getDefaultObserverSensitiveKeys()` 获取默认列表。创建 logger 时可传入自定义 `sensitiveKeys` 扩展。

### 4.3 脱敏规则

| 数据类型 | 处理方式 |
|---------|---------|
| 敏感字段 | 整个字段移除（key-value 对不出现在输出中） |
| `Error` 对象 | 规范化为 `{ name, message }`，丢弃 stack trace |
| 嵌套对象 | 递归处理 |
| 数组 | 逐元素递归处理，过滤 `undefined` 结果 |
| `undefined` 值 | 从结果中移除 |
| 空对象 | 移除（返回 `undefined`） |

字段名匹配为**大小写敏感的精确匹配**。

---

## 5. 分布式追踪

### 5.1 技术选型

基于 OpenTelemetry API（`@opentelemetry/api`），只依赖 API 层不绑定具体 SDK 实现。消费方可以选择任意 OpenTelemetry SDK 和 exporter。

### 5.2 Tracer 生命周期

```
initTracing(config)  →  全局单例 tracer 就绪  →  shutdownTracing()
```

- `initTracing()` 是幂等的：重复调用返回已有的 shutdown 函数
- Tracer 以进程级单例存储（模块级变量）
- 默认 tracer 名称：`'@tianji/observer'`

### 5.3 配置

```typescript
interface ObserverTracingConfig {
  readonly serviceName: string
  readonly exporters: readonly ObserverTracingExporterConfig[]
}

interface ObserverTracingExporterConfig {
  readonly kind: 'otlp' | 'langfuse'
  readonly endpoint?: string
  readonly headers?: Record<string, string>
}
```

当前 `otlp` exporter 可用，`langfuse` 尚未接入（调用时抛出错误）。

### 5.4 Span 类型

observer 提供四种预定义 span，覆盖核心执行路径：

| 函数 | Span 名称 | 属性 |
|------|----------|------|
| `startSessionSpan()` | `session` | `tianji.session.id` |
| `startRunSpan()` | `run` | `tianji.run.id`，可选 `tianji.session.id` |
| `startToolSpan()` | `tool` | `tianji.tool.name`，可选 `tianji.run.id` |
| `startLlmCallSpan()` | `llm.call` | `tianji.llm.provider`，`tianji.llm.model`，可选 session/run id |

**行为特点**：

- 所有 span 使用 `SpanKind.INTERNAL`
- 如果 tracing 未初始化，所有 `start*Span()` 返回 `undefined`（安全降级）
- 返回 `ObserverStartedSpan`，包含 `span` 对象和 `end()` 便捷函数

### 5.5 属性命名规范

所有 span 属性使用 `tianji.` 前缀，避免与其他系统的属性冲突：

```
tianji.session.id
tianji.run.id
tianji.tool.name
tianji.llm.provider
tianji.llm.model
```

---

## 6. 依赖约束

| 允许的外部依赖 | 允许的内部依赖 | 禁止依赖 |
|--------------|--------------|---------|
| `@opentelemetry/api` | 无 | 所有内部包, `ai`, `@ai-sdk/*`, `@langchain/*`, `zod` |

observer 是零内部依赖的横切包，任何内部包都可以消费它而不引入循环依赖。

---

## 7. 模块组织

```text
packages/observer/src/
├─ index.ts                    # 公共导出
├─ logger/
│  ├─ types.ts                 # ObserverLogEntry, ObserverLogger 等类型
│  ├─ logger.ts                # createObserverLogger 实现
│  ├─ sanitize.ts              # 脱敏逻辑
│  └─ sinks/
│     ├─ file-jsonl.ts         # JSONL 文件 sink
│     ├─ memory.ts             # 内存 sink
│     └─ stdout.ts             # 标准输出 sink
└─ tracing/
   ├─ types.ts                 # tracing 配置与 span 类型
   ├─ tracer.ts                # initTracing, shutdownTracing, getTracer
   ├─ state.ts                 # 全局单例状态
   └─ spans.ts                 # startSessionSpan 等 span 工厂
```
