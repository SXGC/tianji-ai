# Minimal Agent 阶段 4 详细计划

完整计划在 `minimal-agent-implementation.md` 中。

## 阶段目标

在 `apps/cli` 中将现有日志骨架补齐为可实际使用的最小日志系统，满足两条主链路：

- `tianji run "<prompt>"` 运行期间持续写入结构化 JSONL 日志。
- `tianji log -f` 能先输出已有日志，再持续跟随新增日志，并以人类可读格式渲染。

本阶段只解决“日志模型、日志写入、日志 follow、CLI 日志输出格式统一”四件事，不扩展新的命令，也不修改 agent 配置模型。

## 完成定义

当以下条件同时满足时，阶段 4 视为完成：

- CLI 日志文件固定落在 `~/.config/tianji-ai/logs/tianji.log`。
- 每条日志均以单行 JSON 写入，字段为 `timestamp`、`level`、`scope`、`message`、`data`。
- `scope` 使用数组表达层级，例如 `["cli", "run", "config"]`。
- `tianji log -f` 能在日志文件不存在时等待创建，存在后先输出历史内容，再持续输出新增内容。
- follow 读取过程中能容忍坏行或半行，不因单条日志损坏而退出。
- CLI 输出格式与主计划一致，稳定显示时间、级别、scope、消息与可选 `data`。
- `run` 相关主路径与失败路径都有日志落盘。
- `pnpm check` 通过。

## 当前状态与差距

结合当前 `apps/cli` 代码，阶段 4 需要补齐以下差距：

- `apps/cli/src/logger.ts` 已有写入骨架，但 `scope` 仍是扁平字符串，和主计划中的分层结构不一致。
- `apps/cli/src/config.ts` 当前日志文件路径是 `logs/cli.jsonl`，主计划要求的是 `logs/tianji.log`。
- `apps/cli/src/log-follow.ts` 当前通过 `readFile()` 轮询整文件，能工作，但不适合作为长期 follow 实现；至少要改为按偏移量增量读取。
- 当前 `formatCliLogEntry()` 的输出格式还是 `[timestamp] LEVEL scope: message`，需要统一为主计划的人类可读形式。
- 当前 `run` 主流程只写了阶段 2 骨架日志，阶段 4 需要把日志点位补到配置加载、runtime 创建、事件流转与失败收口。

## 目标文件

- `apps/cli/src/config.ts`
- `apps/cli/src/logger.ts`
- `apps/cli/src/log-follow.ts`
- `apps/cli/src/main.ts`
- `apps/cli/README.md`
- `README.md`（如果已有 CLI 日志能力说明则同步更新）

## 日志模型设计

### 1. 日志文件位置

统一收敛为：

- `~/.config/tianji-ai/logs/tianji.log`

对应实现：

- 在 `apps/cli/src/config.ts` 中将 `cliLogFilePath` 从 `cli.jsonl` 改为 `tianji.log`。

### 2. 日志结构

建议固定为：

```ts
export interface CliLogEntry {
  readonly timestamp: string
  readonly level: CliLogLevel
  readonly scope: readonly string[]
  readonly message: string
  readonly data?: Record<string, unknown>
}
```

约束：

- `timestamp` 使用 `new Date().toISOString()`。
- `level` 固定为 `'debug' | 'info' | 'warn' | 'error'`。
- `scope` 必须是非空数组，元素为非空字符串。
- `data` 只记录元数据，不写入 prompt、`SOUL.md` 正文、apiKey 等敏感信息。

### 3. scope 规范

建议统一使用数组，避免各处自由拼字符串：

- `['cli', 'run']`
- `['cli', 'run', 'config']`
- `['cli', 'run', 'runtime']`
- `['cli', 'run', 'event']`
- `['cli', 'log', 'follow']`
- `['cli', 'main']`

这样后续既能格式化成人类可读文本，也方便未来做过滤。

## 模块职责细化

### `apps/cli/src/logger.ts`

负责日志写入，不负责 follow。

建议新增或调整：

- `type CliLogScope = readonly string[]`
- `interface CliLogger`
- `createCliLogger(paths)`
- `appendCliLog(paths, entry)`
- `logDebug()` / `logInfo()` / `logWarn()` / `logError()`
- 可选增加 `createScopedLogger(baseScope)`，减少调用侧重复声明前缀

关键要求：

- 写入前确保 `logs/` 目录存在。
- 每次写入严格追加单行 JSON，不做多行 pretty print。
- 对 `data` 做最小过滤，避免写入：
  - `soul`
  - `prompt`
  - `apiKey`
  - 其他敏感原文
- 若 `data` 序列化失败，不能让整个 CLI 崩溃；应降级为安全的错误描述或提前约束输入类型。

### `apps/cli/src/log-follow.ts`

负责日志读取、解析、格式化与 follow。

建议新增或调整：

- `followCliLog(logFilePath: string): Promise<void>`
- `readExistingAndFollow(logFilePath: string): Promise<void>`
- `readCliLogChunk(fileHandle, offset): Promise<{ chunk: string; nextOffset: number }>`
- `parseCliLogLine(line: string): CliLogEntry | null`
- `formatCliLogEntry(entry: CliLogEntry): string`

关键要求：

- 文件不存在时循环等待，不报错退出。
- 首次检测到文件后，先从头读取已有内容。
- 后续按 `offset` 增量读取，不重复输出，不整文件重读。
- 检测文件被截断或重建时重置 `offset`。
- 处理半行时保留 `remainder`，等下次拼接。
- 遇到非法 JSON 行时输出 `[invalid-cli-log] ...`，但不中断 follow。

### `apps/cli/src/main.ts`

负责补全日志埋点，不承载日志实现细节。

阶段 4 需要补的日志点：

- `['cli', 'run']`：收到命令
- `['cli', 'run', 'config']`：开始加载配置
- `['cli', 'run', 'config']`：配置加载成功
- `['cli', 'run', 'runtime']`：开始创建 runtime
- `['cli', 'run', 'runtime']`：runtime 创建成功
- `['cli', 'run', 'event']`：收到关键事件，例如 `message.delta`、`run.completed`、`run.failed`
- `['cli', 'run']`：最终成功结束
- `['cli', 'main']`：统一失败出口
- `['cli', 'log', 'follow']`：开始 follow、等待日志文件、检测文件重置等

注意：

- 事件日志不记录完整模型输出逐字符原文，避免日志量失控。
- `message.delta` 建议只记录事件名、增量长度与必要标识，例如 `runId`、`sessionId`。
- 完整 assistant 文本仍走 CLI stdout，不走日志文件。

## 详细 TODO

### 1. 收敛日志路径与命名

- 修改 `apps/cli/src/config.ts`，将 `cliLogFilePath` 固定为 `join(logsDir, 'tianji.log')`。
- 全仓检查 `cli.jsonl` 是否还有残留引用。
- 更新 README 中的日志路径说明，确保文档与实现一致。

### 2. 重构日志 entry 结构

- 将 `CliLogEntry.scope` 从 `string` 改为 `readonly string[]`。
- 增加 `CliLogScope` 类型别名，统一 logger API。
- 更新 `createCliLogger()`、`logInfo()`、`logWarn()`、`logError()` 的签名。
- 统一调用侧，把 `'cli.run'` 这类字符串改为 `['cli', 'run']`。

### 3. 补齐写入侧约束

- 在 `logger.ts` 中增加 entry 构造逻辑，避免调用方手动拼 `timestamp`。
- 加入最小数据清洗逻辑，明确哪些字段不能进入日志。
- 明确写入失败策略：
  - 主命令中的日志写入失败尽量不影响主流程。
  - 关键失败出口可降级打印到 stderr。
- 如有必要，为 logger 增加 `safeLog*` 包装，避免二次异常覆盖原始错误。

### 4. 重写 follow 读取逻辑为增量模式

建议仍保留轮询，而不是引入复杂文件监听，最小实现更稳。

实现步骤：

- 用 `stat` 获取文件大小。
- 维护 `offset` 与 `remainder`。
- 每轮如果文件不存在，则 `sleep()` 后继续。
- 文件存在且 `size < offset`，认为文件被截断或重建，重置 `offset = 0` 与 `remainder = ''`。
- 只读取 `[offset, size)` 区间的新增内容。
- 按换行切分，保留最后一段不完整内容为 `remainder`。
- 对每个完整行做 `parseCliLogLine()` 与 `formatCliLogEntry()`。

### 5. 统一 CLI 友好输出格式

格式建议固定为：

```text
2026-03-25T10:00:00.000Z INFO  cli > run > config   Loaded user config {"agentName":"default"}
```

实现要点：

- `level` 固定大写。
- `scope` 使用 ` > ` 连接。
- `message` 前做最小对齐，保证输出易扫读。
- `data` 存在时追加紧凑 JSON。
- 不输出多余前缀如方括号，尽量贴近主计划示例。

### 6. 补齐 run 链路日志点位

基于阶段 3 的实现，将日志打点补齐到以下关键节点：

- 收到 `run` 命令
- 自动初始化默认配置
- 加载配置成功
- 解析默认 agent 成功
- 创建 runtime 成功
- 创建 session 成功
- 开始 `runTurn`
- 收到 `message.delta`
- 收到 `run.completed`
- 收到 `run.failed`
- run 命令退出

每个点位仅记录元数据：

- `agentName`
- `provider`
- `modelName`
- `soulPath`
- `promptLength`
- `runId`
- `sessionId`
- `deltaLength`
- `error.message`

### 7. 补齐 follow 链路日志点位

`log -f` 自身也要写日志，但需要避免“自己写自己读”造成噪音过大。

建议只记录少量控制类事件：

- 开始 follow
- 等待日志文件创建
- 检测到日志文件已创建
- 检测到日志文件被截断或重建
- follow 读取异常

不建议为每一行被输出的日志再次写一条日志，否则会形成递归噪音。

### 8. 更新 README

`apps/cli/README.md` 至少补充：

- 日志文件位置
- `tianji log -f` 用法
- 日志以 JSONL 落盘，CLI 侧做人类可读渲染
- 日志中不会记录 `SOUL.md` 正文与敏感凭据

如果根 `README.md` 已有 CLI 小节，也同步补一段最小说明。

## 测试与校验计划

### 功能验收

- 执行一次 `tianji run "hi"` 后，`~/.config/tianji-ai/logs/tianji.log` 被创建。
- 日志文件内容为合法 JSONL，每行都能独立解析。
- `tianji log -f` 在日志文件不存在时会等待。
- 日志文件创建后，`tianji log -f` 会立即输出历史日志。
- 新增日志写入时，`tianji log -f` 能实时看到。
- 日志文件被清空或替换后，follow 仍能继续工作。

### 结构验收

- `scope` 在类型和序列化结果中都为数组，而不是点分字符串。
- `config.ts`、`logger.ts`、`log-follow.ts` 的职责边界清晰，没有互相侵入。
- `main.ts` 只负责编排，不直接处理日志文件读写细节。

### 安全验收

- 日志不包含 `apiKey`。
- 日志不包含完整 prompt 原文。
- 日志不包含 `SOUL.md` 正文。
- 错误日志仅包含必要元信息与错误消息。

## 实施顺序建议

1. 先修改 `apps/cli/src/config.ts` 中的日志路径。
2. 再重构 `apps/cli/src/logger.ts` 的 entry 结构与 scope 类型。
3. 然后修改 `apps/cli/src/main.ts` 中全部调用点，完成 scope 迁移与日志点位补齐。
4. 再重写 `apps/cli/src/log-follow.ts` 的增量读取逻辑与格式化输出。
5. 最后更新 README，并执行 `pnpm check` 收口。

## 进入阶段 5 前的审查出口

在进入文档收尾前，至少确认以下问题都已回答：

- 日志格式是否已经稳定，不会在阶段 5 再改字段。
- `tianji log -f` 是否已经具备“等待创建 + 历史输出 + 增量 follow”的完整行为。
- `run` 链路是否已经覆盖配置、runtime、事件、失败四类关键日志。
- 是否已经避免把敏感文本写入日志。
- `pnpm check` 是否通过。
