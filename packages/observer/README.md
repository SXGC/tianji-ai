# @tianji/observer

`@tianji/observer` 提供统一的结构化 logger、日志 sink 和 tracing 初始化原语，供 CLI、runtime 或其他应用层复用。

## 当前公开内容

- logger 类型：`ObserverLogger`、`ObserverLogEntry`、`ObserverLogLevel`、`ObserverLogScope`、`ObserverLogSink`
- logger 入口：`createObserverLogger`
- sink：`createJsonlFileSink`、`createMemorySink`、`createStdoutSink`
- 数据脱敏：`sanitizeObserverLogData`、`getDefaultObserverSensitiveKeys`
- tracing：`initTracing`、`shutdownTracing`、`isTracingEnabled`、`getTracer`
- span 辅助：`startSessionSpan`、`startRunSpan`、`startToolSpan`、`startLlmCallSpan`

## Logger API

```ts
import { createObserverLogger, createStdoutSink } from '@tianji/observer'

const logger = createObserverLogger({
  sinks: [createStdoutSink({ pretty: true })],
  scope: ['cli'],
  bindings: { app: 'tianji' },
})

await logger.info(['run', 'config'], 'Loaded config', {
  agentName: 'default',
})

const runLogger = logger.child({
  scope: ['run'],
  bindings: { sessionId: 'session-1' },
})

await runLogger.error(['event'], 'Run failed', {
  reason: 'provider unavailable',
})
```

- `scope` 类型为 `readonly [string, ...string[]]`，至少包含一个层级。
- `child()` 会继承父 logger 的 sinks 和敏感字段集合，并追加 scope 或 bindings。
- 写入前会自动做敏感字段脱敏，默认会过滤 `apiKey`、`prompt`、`soul` 这些字段；也可以在创建 logger 时追加自定义敏感键。

## JSONL Sink

```ts
import { createJsonlFileSink, createObserverLogger } from '@tianji/observer'

const logger = createObserverLogger({
  sinks: [
    createJsonlFileSink({
      filePath: '/tmp/tianji.log',
    }),
  ],
})

await logger.info(['cli', 'run'], 'Started run')
```

- `createJsonlFileSink({ filePath })` 会在写入前自动创建父目录。
- 每条日志以单行 JSON 追加写入，适合 `tail -f`、follow 或后续解析。

## Memory Sink

```ts
import { createMemorySink, createObserverLogger } from '@tianji/observer'

const sink = createMemorySink()
const logger = createObserverLogger({ sinks: [sink] })

await logger.warn(['test'], 'Captured in memory')

console.log(sink.entries)
```

- `createMemorySink()` 主要用于测试或临时检查。
- 已写入记录可直接通过 `sink.entries` 读取。

## Stdout Sink

```ts
import { createObserverLogger, createStdoutSink } from '@tianji/observer'

const logger = createObserverLogger({
  sinks: [createStdoutSink({ pretty: true })],
})

await logger.debug(['cli', 'run', 'event'], 'Received runtime event', {
  eventType: 'message.delta',
})
```

- `pretty: true` 时输出格式为 `[level] scope message {data}`。
- 不传 `pretty` 时，stdout sink 会直接输出原始 JSON。

## Tracing 初始化

```ts
import { initTracing, startRunSpan } from '@tianji/observer'

const disposeTracing = initTracing({
  serviceName: 'tianji-cli',
  exporters: [],
})

const runSpan = startRunSpan({
  runId: 'run-1',
  sessionId: 'session-1',
})

runSpan.end()
await disposeTracing()
```

- `initTracing()` 会初始化全局 tracer，并返回一个异步清理函数。
- `exporters` 当前支持 `otlp` 和 `langfuse` 两种配置类型。
- `startSessionSpan`、`startRunSpan`、`startToolSpan`、`startLlmCallSpan` 都返回 `{ span, end }`，便于在应用层显式结束 span。

## 依赖方边界

- CLI 可以使用 JSONL sink 落盘，再自行实现 follow 与渲染。
- runtime 通过 `logger?: ObserverLogger` 接口接入 observer，不关心底层 sink 细节。
- 其他包如果只需要 logger 类型，也可以直接从 `@tianji/observer` 顶层导入。

## 开发命令

```bash
pnpm --filter @tianji/observer build
pnpm --filter @tianji/observer typecheck
pnpm --filter @tianji/observer test
pnpm --filter @tianji/observer clean
```

## 开源协议

MIT
