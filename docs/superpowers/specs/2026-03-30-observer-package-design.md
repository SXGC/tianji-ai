# Tianji Observer Package Design

> **For agentic workers:** 本文档是 `@tianji/observer` 的设计规格，后续实施计划必须以本文为准，避免直接照搬外部项目实现。

## 背景

当前仓库里只有 `apps/cli` 实现了结构化日志，日志格式固定为 JSONL，每条记录包含 `timestamp`、`level`、`scope`、`message`、`data`。`packages/runtime` 与 `packages/agent` 尚未定义统一日志抽象，也没有 tracing 基础设施。

参考项目 `/workspaces/dev_docker/pi-mono/packages/observer` 已经提供了 logger + tracing 的统一包，但它的对外 API、默认输出模型和当前仓库的 CLI JSONL 日志约束并不一致。`tianji-ai` 需要一个适配自身分层的 `@tianji/observer`，既能承接当前 CLI 日志文件能力，也能为 runtime 后续接入可观测性预留稳定边界。

## 目标

本次设计的目标是新增一个 `@tianji/observer` workspace package，统一提供：

- 面向 `tianji` 领域的 logger API，调用形式固定为 `logger.info(scope, message, data)`。
- 兼容当前 CLI JSONL 文件格式的日志 sink，保证 `tianji log -f` 能继续工作。
- tracing 基础设施与领域化 span helper，但第一阶段只完成包设计与实现入口，不要求马上在 runtime 内铺开大量埋点。
- 一个能被 CLI、agent、runtime 逐步复用的稳定边界，避免后续业务代码直接依赖 `pino` 或 OpenTelemetry SDK 细节。

第一阶段迁移范围明确限定为：CLI 改用 `@tianji/observer` 输出日志；runtime 只准备 observer 接入边界，不要求补一批新的 runtime 日志。

## 非目标

以下事项不在第一阶段范围内：

- 不把 `tianji log -f` 从 CLI 挪到 `@tianji/observer`。
- 不要求把 runtime 的每一种事件都转换为 tracing span 或 tracing event。
- 不要求新增远程日志采集、日志轮转、日志上传或 metrics 系统。
- 不对现有日志文件路径 `~/.config/tianji-ai/logs/tianji.log` 做 breaking change。
- 不把 `pino.Logger` 直接暴露给业务层。

## 设计方案对比

### 方案 A：直接引入 `pino` 风格 logger，并将 `pino.Logger` 暴露给上层

优点：

- 与参考项目 `pi-mono/packages/observer` 最接近，开发速度快。
- 生态兼容性好，`pino` API 丰富。

缺点：

- 与当前 CLI 的 `scope + message + data` 调用风格不一致，迁移需要整体改写调用点。
- 业务层会直接依赖 `pino` 细节，后续要兼容 JSONL file sink、测试 sink、脱敏策略会更重。
- runtime 一旦依赖 `pino.Logger`，未来替换实现的成本很高。

结论：不采用。

### 方案 B：实现领域化 logger 接口，内部使用多 sink 适配文件、stdout 与测试场景

优点：

- 与当前 CLI 调用方式最匹配，迁移改动最小。
- 可以保持现有 JSONL entry 格式兼容。
- 可以把脱敏、scope 拼装、child logger、sink 路由统一下沉到 observer。
- 更适合作为 runtime 和 agent 的稳定依赖边界。

缺点：

- 需要自己定义少量接口和适配层，而不是直接复用外部 logger 类型。

结论：采用。

### 方案 C：第一阶段只抽一个 CLI logger 包，不引入 tracing

优点：

- 范围最小。
- 可以快速消除 `apps/cli/src/logger.ts` 的局部实现。

缺点：

- 无法建立后续 runtime tracing 的统一包边界。
- 第二阶段仍要再做一次包扩容和 API 设计。

结论：不采用。新包一开始就包含 logger + tracing 两类能力，但第一阶段只迁移 CLI logger。

## 推荐架构

`@tianji/observer` 分为三个层次：类型层、logger 层、tracing 层。

### 1. 类型层

类型层定义仓库级稳定协议，不暴露第三方实现细节。核心类型包括：

- `ObserverLogLevel`: `trace | debug | info | warn | error | fatal`
- `ObserverLogScope`: `readonly [string, ...string[]]`
- `ObserverLogEntry`: 结构化日志记录对象
- `ObserverLogger`: 统一 logger 接口
- `ObserverTracingConfig`: tracing 初始化配置
- `ObserverSpanAttributes`: 领域 helper 使用的属性模型

其中 `ObserverLogEntry` 保持与当前 CLI JSONL 格式兼容：

- `timestamp: string`
- `level: ObserverLogLevel`
- `scope: ObserverLogScope`
- `message: string`
- `data?: Record<string, unknown>`

第一阶段保留现有 JSONL 字段模型，不增加额外顶层字段，避免破坏 `apps/cli/src/log-follow.ts`。

### 2. Logger 层

logger 层负责把领域日志调用转换为结构化 entry，并把 entry 分发给一个或多个 sink。其职责包括：

- 统一创建 logger 实例
- 追加固定 scope 和 bindings
- 生成标准化 `ObserverLogEntry`
- 递归脱敏 `data`
- 把 entry 路由到多个 sink

推荐对外 API：

```ts
interface ObserverLogger {
  log(
    level: ObserverLogLevel,
    scope: ObserverLogScope,
    message: string,
    data?: Record<string, unknown>
  ): Promise<void>
  trace(scope: ObserverLogScope, message: string, data?: Record<string, unknown>): Promise<void>
  debug(scope: ObserverLogScope, message: string, data?: Record<string, unknown>): Promise<void>
  info(scope: ObserverLogScope, message: string, data?: Record<string, unknown>): Promise<void>
  warn(scope: ObserverLogScope, message: string, data?: Record<string, unknown>): Promise<void>
  error(scope: ObserverLogScope, message: string, data?: Record<string, unknown>): Promise<void>
  child(options?: {
    scope?: ObserverLogScope
    bindings?: Record<string, unknown>
  }): ObserverLogger
}
```

第一阶段的内部实现允许使用 `pino` 作为 stdout sink 的适配器，也允许直接写原生 JSONL 文件 sink，但 `ObserverLogger` 本身不能退化成 `pino.Logger` 的 re-export。

### 3. Tracing 层

tracing 层负责 OpenTelemetry SDK 初始化、全局 tracer 生命周期和领域 helper。第一阶段需要完成可用实现，但只要求 CLI 或未来应用入口可以主动初始化，runtime 侧暂不强制埋点。

推荐对外 API：

```ts
function initTracing(config: ObserverTracingConfig): () => Promise<void>
function shutdownTracing(): Promise<void>
function isTracingEnabled(): boolean
function getTracer(name?: string): Tracer | undefined

function startSessionSpan(sessionId: string, parent?: Span): Span | undefined
function startRunSpan(runId: string, sessionId?: string, parent?: Span): Span | undefined
function startToolSpan(toolName: string, runId?: string, parent?: Span): Span | undefined
function startLlmCallSpan(
  input: { provider: string; model: string; sessionId?: string; runId?: string },
  parent?: Span
): Span | undefined
```

命名采用 `session/run/tool/llm-call`，与当前仓库语义一致，不直接复用参考仓库里的 `turn` 概念。

## 包结构

建议新增如下文件：

```text
packages/observer/
├─ package.json
├─ README.md
├─ tsconfig.build.json
├─ src/
│  ├─ index.ts
│  ├─ types.ts
│  ├─ logger/
│  │  ├─ index.ts
│  │  ├─ types.ts
│  │  ├─ logger.ts
│  │  ├─ sanitize.ts
│  │  └─ sinks/
│  │     ├─ file-jsonl.ts
│  │     ├─ stdout.ts
│  │     └─ memory.ts
│  └─ tracing/
│     ├─ index.ts
│     ├─ types.ts
│     ├─ state.ts
│     ├─ tracer.ts
│     └─ spans.ts
```

说明：

- `file-jsonl.ts` 用于兼容当前 CLI 文件日志。
- `stdout.ts` 用于本地开发与未来 runtime 可见日志。
- `memory.ts` 用于测试断言。
- `sanitize.ts` 统一处理敏感字段过滤。
- `state.ts` 负责 tracing runtime 状态。
- `tracer.ts` 负责 OpenTelemetry SDK 初始化和 exporter 装配。

## Logger 详细设计

### 标准 entry

observer 写出的标准 entry 与当前 CLI 完全一致：

```ts
interface ObserverLogEntry {
  readonly timestamp: string
  readonly level: ObserverLogLevel
  readonly scope: ObserverLogScope
  readonly message: string
  readonly data?: Record<string, unknown>
}
```

`timestamp` 始终由 logger 层生成，不允许调用方自带。

### scope 设计

保留数组形式的 scope，不改成字符串。原因：

- 当前 CLI 已经使用数组 scope。
- child logger 可以自然地通过拼接数组形成更深 scope。
- tracing attributes 与终端展示都可以从数组派生。

例如：

- 根 logger scope: `['cli']`
- child logger: `['cli', 'run']`
- event child logger: `['cli', 'run', 'event']`

CLI 第一阶段可以继续保留现有常量 scope，也可以在后续迭代中逐步用 child logger 收敛。

### 脱敏规则

脱敏必须统一下沉到 observer，而不是继续由 CLI 自己处理。默认敏感 key 集合应覆盖当前实现：

- `apiKey`
- `prompt`
- `soul`

实现要求：

- 递归处理对象和数组。
- 遇到敏感 key 时直接丢弃该字段。
- `Error` 类型转换为 `{ name, message }`。
- 如果过滤后 `data` 为空对象，则不写 `data` 字段。

observer 允许创建 logger 时追加敏感 key，但第一阶段必须至少保留当前默认集合。

### sink 设计

定义统一 sink 接口：

```ts
interface ObserverLogSink {
  write(entry: ObserverLogEntry): Promise<void>
}
```

第一阶段至少实现三个 sink：

- `createJsonlFileSink({ filePath })`
- `createStdoutSink({ pretty?: boolean })`
- `createMemorySink()`

`createObserverLogger()` 支持挂多个 sink，写日志时顺序执行每个 sink。第一阶段不做并发写入优化，优先保证实现简单和可测。

### CLI 落地方式

CLI 初始化 logger 时使用 JSONL file sink，保持现有行为：

- 路径仍由 `packages/agent/src/context.ts` 提供
- 文件仍写入 `~/.config/tianji-ai/logs/tianji.log`
- `apps/cli/src/log-follow.ts` 继续 follow 这个文件

第一阶段不要求 CLI 同时输出 stdout sink，避免改变现有终端输出行为。

## Tracing 详细设计

### 初始化责任

tracing 只能由应用入口主动初始化，不能在 runtime 内部偷偷初始化。原因：

- runtime 是库层，不应控制全局 SDK 生命周期。
- CLI、未来 server 或其他入口可能需要不同的 tracing 配置。
- 测试场景下更容易显式开启或关闭 tracing。

因此 `createSessionRuntime()` 第一阶段不会主动调用 `initTracing()`。

### runtime 与 tracing 的关系

第一阶段只要求 observer 提供 tracing 基础设施，不要求 runtime 立刻铺开埋点。为了后续接入，runtime 应该在后续阶段支持：

- 显式接受 `logger?: ObserverLogger`
- 在合适的位置调用 observer span helper

但本次不要求大量新增 runtime 日志，也不要求 tracing helper 立刻融入所有执行路径。

### exporter 策略

参考包的思路可以复用，但命名与导出边界需适配当前仓库。第一阶段建议保留：

- `otlp` exporter
- `langfuse` exporter

如果实现中发现 Langfuse 依赖引入成本过高，可以允许 tracing 第一阶段先落 OTLP 基础设施，并保留 Langfuse 类型入口与扩展位；但计划层面应优先按“logger + tracing 完整包结构”设计。

## 与现有代码的衔接策略

### CLI

第一阶段唯一强制迁移对象是 CLI。

迁移方式：

1. 新建 `packages/observer`。
2. 将 `apps/cli/src/logger.ts` 的逻辑下沉到 observer logger + JSONL sink。
3. CLI 改为从 `@tianji/observer` import logger 类型与工厂。
4. `apps/cli/src/log-follow.ts` 改为依赖 observer 暴露的 entry 类型，而不是 CLI 自己定义的 logger 类型。
5. 保持 `tianji log -f` 的终端输出与容错行为不变。

### Runtime

第一阶段只准备边界，不要求新增大量行为。推荐在后续阶段做下面两个增量：

1. 为 `SessionRuntimeOptions` 增加 `logger?: ObserverLogger`
2. 在 `createSessionRuntime()` 与核心执行链路中补少量关键日志和 span helper

这样可以避免这次变更一次跨太多执行路径。

### Agent

`packages/agent` 目前只提供日志目录路径，第一阶段不需要引入新的 observer 依赖逻辑。CLI 仍然通过 agent 拿到 `cliLogFilePath`，再在 CLI 层创建 observer logger。

## 测试策略

第一阶段至少覆盖以下测试：

- observer logger 单元测试
  - JSONL sink 写出正确 entry
  - 脱敏规则生效
  - child logger 会正确拼接 scope 和 bindings
  - memory sink 可用于断言 entry
- tracing 单元测试
  - tracing disabled 时 `getTracer()` 返回 `undefined`
  - init/shutdown 生命周期不会抛出非预期异常
- CLI 回归测试
  - 现有 `run-e2e.test.ts` 中关于 `log -f` 的断言继续通过
  - CLI 运行日志格式与原来兼容

仓库约束要求代码变更后必须执行根目录 `pnpm check`，第一阶段计划必须把它作为必做验证步骤。

## README 影响

本次功能落地后，需要至少更新以下文档：

- 根目录 `README.md`
  - 仓库结构增加 `packages/observer`
  - 核心包说明增加 `@tianji/observer`
  - CLI 日志描述改为“由 observer 包统一提供”
- `packages/observer/README.md`
  - 说明 logger API、JSONL file sink、tracing 初始化方式

如果 CLI README 中有日志实现细节，也应同步修订，避免继续把 observer 能力写成 CLI 私有实现。

## 风险与约束

### 风险 1：observer API 过度贴近 `pino`

如果业务层直接拿到 `pino.Logger`，后续多 sink、JSONL 兼容和脱敏边界都会被侵蚀。因此 observer 必须坚持领域化接口。

### 风险 2：tracing 初始化责任下沉错误

如果把 tracing SDK 初始化塞进 runtime 内部，会污染库层边界，并使测试与多入口场景更难控制。

### 风险 3：破坏现有 JSONL 兼容性

一旦 observer 改动日志 entry 顶层字段，`tianji log -f` 和已有日志文件就会受影响。第一阶段必须保持向后兼容。

### 风险 4：一次把 runtime 观测改太大

本次范围已经明确选择“只迁 CLI，runtime 先准备边界”。实施计划必须严格遵守，避免顺手把 runtime 全链路日志也一起改掉。

## 最终设计结论

采用方案 B：实现新的 `@tianji/observer` 包，对外暴露 `tianji` 风格的 logger API 与 tracing API。observer 内部负责多 sink、统一脱敏和 tracing 生命周期管理，但不把第三方 logger 细节暴露给上层。

第一阶段只迁移 CLI 到 observer，并保持当前 JSONL 文件格式、日志路径和 `tianji log -f` 行为不变。runtime 与 agent 不做大规模行为变更，只为后续 observer 接入保留清晰边界。
