# Minimal Agent 阶段 2 详细计划

## 阶段目标

新增 `apps/cli` 应用骨架，建立可扩展的 CLI 入口、命令分发、配置装载边界、runtime 启动边界与日志边界，使 `tianji run "hi"` 和 `tianji log -f` 至少能进入稳定的主流程。

本阶段重点是“应用层结构”和“命令主流程骨架”，不要求一次性完成完整的 LLM 运行链路与 JSONL follow 细节；这些能力会在阶段 3 和阶段 4 继续填充。

## 完成定义

- 仓库中新增 `apps/cli` 包，并加入 workspace 可识别结构。
- CLI bin 能把 `process.argv` 路由到 `run` 与 `log -f` 两条主流程。
- 配置目录定位、默认配置初始化入口、runtime 工厂入口、日志写入入口、日志 follow 入口都已有明确模块边界。
- 根目录 `package.json` 的 `typecheck` 已覆盖 `apps/*`。
- `apps/cli/README.md` 对 CLI 使用方式和阶段性能力边界有说明。

## 目标文件

- `apps/cli/package.json`
- `apps/cli/tsconfig.json`
- `apps/cli/README.md`
- `apps/cli/bin/tianji.mjs`
- `apps/cli/src/bin.ts`
- `apps/cli/src/main.ts`
- `apps/cli/src/config.ts`
- `apps/cli/src/logger.ts`
- `apps/cli/src/log-follow.ts`
- `package.json`
- `README.md`

## 模块边界设计

### `apps/cli/src/main.ts`

负责 CLI 进程主入口编排：

- 解析 argv。
- 根据命令分发到 `run` / `log` handler。
- 统一处理成功退出码与失败退出码。
- 统一打印面向用户的错误消息。

建议新增定义：

- `type TianjiCliCommand = RunCommand | LogFollowCommand`
- `parseCliArgs(argv: readonly string[]): TianjiCliCommand`
- `runCli(argv: readonly string[]): Promise<number>`

### `apps/cli/src/config.ts`

负责用户配置目录与初始化入口：

- 定位 `~/.config/tianji-ai`。
- 读取 `tianji.json`。
- 若文件不存在，调用 `createDefaultUserTianjiConfig()` 创建默认配置与默认 `SOUL.md`。
- 返回后续阶段需要的结构化配置上下文。

建议新增定义：

- `interface UserConfigPaths`
- `interface LoadedAgentConfig`
- `interface LoadedUserConfigContext`
- `getUserTianjiConfigDir()`
- `getUserTianjiConfigPath()`
- `ensureDefaultUserConfig()`
- `loadUserConfigContext()`

### `apps/cli/src/logger.ts`

负责日志写入抽象，不直接承担 follow 行为：

- 定义日志记录结构。
- 负责目录创建、文件追加写入。
- 提供 scoped logger 或最小 append 接口。

建议新增定义：

- `interface CliLogEntry`
- `type CliLogLevel = 'debug' | 'info' | 'warn' | 'error'`
- `createCliLogger()`
- `appendCliLog(entry: CliLogEntry)`
- `logInfo(scope, message, data?)`
- `logError(scope, message, data?)`

### `apps/cli/src/log-follow.ts`

负责日志读取骨架：

- 打开日志文件。
- 输出已有内容。
- 提供后续阶段可扩展的 follow 循环。
- 将 JSONL 渲染为人类可读文本。

建议新增定义：

- `followCliLog(options)`
- `formatCliLogEntry(entry: CliLogEntry): string`
- `parseCliLogLine(line: string): CliLogEntry | null`

### `apps/cli/src/bin.ts` 与 `apps/cli/bin/tianji.mjs`

负责 Node bin 桥接：

- `bin/tianji.mjs` 作为 shebang 入口，加载编译后的 `src/bin.ts` 输出。
- `src/bin.ts` 调用 `runCli(process.argv.slice(2))`，并把返回码写回 `process.exitCode`。

## 业务逻辑拆解

### 1. 命令模型与参数解析

需要支持的最小命令：

- `tianji run "<prompt>"`
- `tianji log -f`

解析规则建议固定为：

- 第一个参数是主命令：`run` 或 `log`。
- `run` 要求第二个参数直接作为 prompt，不做复杂 option 解析。
- `log` 仅支持 `-f` 或 `--follow`，其他参数直接报错。
- 未知命令、缺失 prompt、错误 flag 都要走统一 usage 错误。

### 2. 配置装载骨架

虽然完整运行链路在阶段 3 才真正打通，但本阶段要先把配置加载边界固定下来：

- `run` handler 进入后先调用 `loadUserConfigContext()`。
- `loadUserConfigContext()` 内部负责：
  - 定位用户目录。
  - 自动初始化默认配置。
  - 校验 schema。
  - 解析 env placeholder。
  - 获取默认 agent。
  - 加载 `SOUL.md`。
- 返回值要足够支撑后续 runtime 创建，不让 `main.ts` 知道配置文件细节。

### 3. runtime 启动骨架

阶段 2 不要求跑通真实模型调用，但要先固定启动接口，避免阶段 3 再做结构性搬迁：

- `run` handler 中预留 `createCliRuntime(context)` 或同等内部函数。
- 该函数内部负责把 `provider/modelName` 映射为 runtime 需要的 `deepagents.model` 字符串。
- `snapshotStore` 路径、session 创建、事件消费细节先保留为后续实现点。
- 若阶段 2 尚不执行真实 `runTurn`，也要至少返回明确的 `not implemented` 流程占位，而不是把逻辑散落在 `main.ts`。

### 4. 日志骨架

本阶段日志系统以“接口先行”为主：

- `run` handler 入口、配置加载成功、命令分发失败都要能写日志。
- `log -f` 入口要能进入 `followCliLog()` 主流程。
- JSONL 格式与 scope 结构要与总计划一致，避免阶段 4 再做格式迁移。

## 详细 TODO

### 1. 创建 `apps/cli` 包结构

- 新建 `apps/cli/package.json`，声明包名、`type: module`、`bin` 字段、`typecheck` 脚本。
- 新建 `apps/cli/tsconfig.json`，继承根配置并适配 Node CLI 编译场景。
- 新建 `apps/cli/src` 与 `apps/cli/bin` 目录。
- 确认 `pnpm-workspace.yaml` 已包含 `apps/*`，无需重复改动。

### 2. 建立 bin 入口

- 在 `apps/cli/bin/tianji.mjs` 增加 shebang 与对编译产物的桥接逻辑。
- 在 `apps/cli/src/bin.ts` 中调用 `runCli()`。
- 统一处理异步未捕获错误，把错误消息输出到 stderr，并设置非零退出码。

### 3. 实现命令解析主流程

- 在 `apps/cli/src/main.ts` 中定义命令联合类型。
- 实现 `parseCliArgs()`：
  - `run` 命令解析 prompt。
  - `log -f` 解析 follow 标志。
  - 对错误输入抛出 usage 错误。
- 实现 `runCli()`：
  - 调用 `parseCliArgs()`。
  - 根据命令分发给 `handleRunCommand()` / `handleLogCommand()`。
  - 捕获错误并返回退出码。

### 4. 固化配置模块接口

- 在 `apps/cli/src/config.ts` 中定义路径与上下文类型。
- 封装目录路径方法：
  - `getUserTianjiConfigDir()`
  - `getUserAgentsDir()`
  - `getUserLogsDir()`
  - `getUserTianjiConfigPath()`
- 封装初始化入口：
  - 创建目录
  - 写默认 `tianji.json`
  - 写默认 `agents/default/SOUL.md`
- 封装加载入口 `loadUserConfigContext()`，把 `@tianji/shared` helper 串起来。

### 5. 固化运行命令 handler 骨架

- 在 `main.ts` 或独立内部函数中增加 `handleRunCommand(prompt)`。
- 先写入 `cli.run` 入口日志。
- 调用 `loadUserConfigContext()` 获取：
  - 配置路径
  - 默认 agent 名称
  - provider 名称
  - modelName
  - `SOUL.md` 文本
- 预留 runtime 创建函数签名，保证阶段 3 只是在函数内部补实现。
- 若阶段 2 尚未接入真实 runtime，输出明确占位信息并返回非零或受控退出码，避免假成功。

### 6. 固化日志命令 handler 骨架

- 增加 `handleLogCommand({ follow: true })`。
- 调用 `followCliLog()`。
- 即使 follow 的轮询/文件监听细节尚未完整，也要保证进入统一模块而不是直接在 `main.ts` 中写临时逻辑。

### 7. 实现日志写入基础抽象

- 在 `apps/cli/src/logger.ts` 定义 `CliLogEntry` 结构。
- 约定字段：`timestamp`、`level`、`scope`、`message`、`data`。
- 提供最小 logger 工厂，屏蔽路径创建与 JSON 序列化细节。
- 明确不写入 `SOUL.md` 正文，只记录 `agentName`、`model`、`soulPath` 等元信息。

### 8. 实现日志 follow 基础抽象

- 在 `apps/cli/src/log-follow.ts` 中定义读取与格式化函数。
- 先支持“读取现有日志并格式化输出”的基础能力。
- follow 循环、文件等待创建、增量读取可按骨架方式先预留清晰 TODO 注释或占位实现，但模块签名必须稳定。

### 9. 更新根目录脚本与仓库文档

- 修改根 `package.json` 的 `typecheck`，从 `./packages/*` 扩展到 `./packages/*` 与 `./apps/*`。
- 更新根 `README.md`，说明仓库已新增 `apps/cli`。
- 新增 `apps/cli/README.md`，记录：
  - 当前命令面
  - 目录结构
  - 配置入口职责
  - 阶段 2 仍未完成的能力边界

## 重要方法建议签名

```ts
export interface RunCommand {
  readonly kind: 'run'
  readonly prompt: string
}

export interface LogFollowCommand {
  readonly kind: 'log-follow'
}

export type TianjiCliCommand = RunCommand | LogFollowCommand

export async function runCli(argv: readonly string[]): Promise<number>

export async function loadUserConfigContext(): Promise<LoadedUserConfigContext>

export function createCliLogger(paths: UserConfigPaths): CliLogger

export async function followCliLog(logFilePath: string): Promise<void>
```

这些签名的目标是让阶段 3 和阶段 4 只填充实现，不再回头改调用关系。

## 测试与校验计划

### 结构级校验

- 检查 `apps/cli/package.json` 的 `bin` 与入口文件路径是否一致。
- 检查 `apps/cli/tsconfig.json` 是否能被根 TypeScript 配置正确继承。
- 检查根 `package.json` 的 `typecheck` 是否包含 `apps/*`。

### CLI 行为测试建议

阶段 2 可以先以轻量单元测试或集成骨架测试覆盖：

- `parseCliArgs(['run', 'hi'])` 返回 `RunCommand`。
- `parseCliArgs(['log', '-f'])` 返回 `LogFollowCommand`。
- 缺失 prompt、未知命令、错误 flag 时返回预期错误。
- `runCli(['run', 'hi'])` 至少进入 run handler。
- `runCli(['log', '-f'])` 至少进入 log handler。

### 手工审查

- 命令分发逻辑是否足够小，避免 `main.ts` 变成巨型文件。
- 配置逻辑是否全部收口到 `config.ts`，不在多个模块重复拼路径。
- 日志逻辑是否全部收口到 `logger.ts` / `log-follow.ts`，不在 handler 中直接写文件。
- 错误码与错误消息是否统一从 `runCli()` 出口处理。

## 进入阶段 3 前的审查出口

- `run` 主流程是否已经具备“加载配置上下文 -> 准备 runtime 输入”的骨架。
- `log -f` 主流程是否已经具备独立模块边界，而不是临时脚本式实现。
- 根级 `typecheck` 是否会覆盖 CLI 包，避免后续阶段遗漏类型错误。
- 文档是否已经告诉后续实现者：阶段 2 完成的是结构与边界，不是最终可运行能力。
