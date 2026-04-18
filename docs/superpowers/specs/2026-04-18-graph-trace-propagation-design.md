# Graph Trace Propagation Design

> **For agentic workers:** 本文档定义编排图 tracing 的设计边界。后续实现必须以本文为准，不得把“共享 graph trace”误实现成“全图共享一个 SessionRuntime”。

## 背景

当前仓库已经支持 `runtime.tracing.langsmith`，`@tianji/runtime` 在直接执行 `runTurn()` 时会创建 `LangSmith Client`、`LangChainTracer`，并把 `callbacks/tags/metadata` 注入 deepagents 执行链。

但用户平时实际跑的主路径不是直接调用 `createAgentRuntime().runTurn()`，而是：

- `apps/node` / `tianji chat`
- `createAgentSession().queryWithGraph()`
- `runOrchestrationGraph()`
- `createDeepagentsExecutorFactory()`
- 节点级 `SessionRuntime`

问题在于：graph 执行层没有把 tracing 配置和 graph 级 tracing 上下文传给节点级 runtime。结果是：

- `runtime.tracing.langsmith` 在直接 runtime 路径上有效
- 在编排图路径上失效
- 用户已经正确配置 LangSmith，但看不到 trace

## 目标

本次设计的目标是：

- 让一轮 graph run 拥有统一的 tracing 上下文
- 让 graph 中每个 agent 节点创建的 runtime 都继承这份 tracing 上下文
- 保持当前“节点级 runtime 隔离”架构不变
- 让 LangSmith 中能按同一个 graph run 聚合查看所有节点的运行
- 不引入模糊兜底逻辑；如果 tracing 配置非法，继续 fail fast

## 非目标

以下事项不在本次范围内：

- 不把整张图改成共享一个 `SessionRuntime`
- 不重写 `@tianji/runtime` 的执行模型
- 不引入新的 tracing provider；本次只打通已有 LangSmith tracing 透传
- 不把 graph 事件总线日志自动镜像成 LangSmith runs
- 不在本次同时解决 LangSmith org-scoped key 的 `workspaceId` 支持

## 关键约束

### 1. 共享的是 tracing 上下文，不是 runtime 实例

当前节点执行器的设计边界很明确：每次节点被调度时，按该节点的模型、tools、skills、snapshot 语义创建独立 `SessionRuntime`。这是执行隔离边界，不应该为了 tracing 被打破。

因此本次设计必须坚持：

- graph run 共享 tracing config / tracing context
- 节点 runtime 继续独立创建
- tracing 通过上下文透传，而不是通过 runtime 单例共享

### 2. runtime 自己的运行元数据仍由 runtime 负责

`@tianji/runtime` 已经会在每次 run 构造自己的 tracing metadata，例如：

- `sessionId`
- `runId`
- `triggerType`
- `model`
- `parentRunId`
- `threadId`
- `checkpointId`

graph 层不应该覆盖这些字段，只能补充 graph 级上下文。

### 3. graph 层只能补“稳定基础字段”

graph 层补充的 tracing metadata 必须是跨节点稳定、对排查有价值、不会和 runtime 内部字段冲突的字段。禁止把整个 state、提示词全文、工具明细等大对象塞进隐式 tracing metadata。

## 设计方案对比

### 方案 A：整张图只创建一个共享 `SessionRuntime`

优点：

- 表面上最容易理解，看起来“全图一个 runtime，自然全图一个 trace”

缺点：

- 破坏当前节点执行隔离
- 不同节点的 `model/tools/skills/systemPrompt` 会被混在一起
- 会把 tracing 修复升级成执行模型重构，风险过高

结论：不采用。

### 方案 B：保留节点级 runtime，graph tracing 上下文透传到每个节点

优点：

- 与当前架构一致
- 改动面集中在 `packages/agent` 的 graph/executor 边界和 runtime tracing 上下文合并逻辑
- 可以马上修复“配了 LangSmith 但 graph 路径没 trace”的问题
- LangSmith 中可通过共同的 graph metadata 聚合查看节点 runs

缺点：

- LangSmith UI 中未必天然表现为严格父子树，更多是“可关联的一组 runs”

结论：采用。

### 方案 C：显式创建 graph 根 trace，再让节点 run 成为它的子 trace

优点：

- 观测模型最完整，LangSmith 视图最理想

缺点：

- 当前 runtime tracing 边界没有显式 parent run 透传能力
- 改动会跨 `packages/agent`、`packages/runtime`、LangChain/LangSmith 集成细节
- 复杂度明显高于当前问题所需

结论：本次不做。若方案 B 落地后仍不足，再单独设计第二阶段。

## 推荐架构

采用方案 B：graph run 共享 tracing config 和 tracing context，节点级 runtime 继续独立创建，但在构造时继承 graph 级 tracing 信息。

架构分四层：

### 1. Config 层：Tracing Config 来源保持不变

LangSmith tracing 配置仍然只从现有配置中心进入：

- `runtime.tracing.langsmith.enabled`
- `runtime.tracing.langsmith.project`
- `runtime.tracing.langsmith.apiKey`
- `runtime.tracing.langsmith.apiUrl`
- `runtime.tracing.langsmith.tags`
- `runtime.tracing.langsmith.metadata`

graph 层不新增另一套 tracing 配置来源，也不允许节点图定义私有 LangSmith 配置，避免多头配置。

### 2. Graph Build 层：默认执行器工厂获得 tracing config

`buildDefaultGraph()` 当前只把 `resolveModel` 等执行器能力注入 `createDeepagentsExecutorFactory()`。

本次改造后，默认执行器工厂还需要拿到：

- 全局 tracing config：来自 `LoadedAgentContext.config.runtime?.tracing`

这样 graph 执行器在创建节点 runtime 时，才能把 tracing config 原样透传下去。

### 3. Graph Run 层：创建 graph 级 tracing context

每次 graph run 启动时，编排层需要生成一份 graph 级 tracing context。它不负责创建 LangSmith client/tracer，只负责描述这一轮 graph run 的公共上下文。

推荐字段：

- tags:
  - `tianji`
  - `graph`
  - `graph:<graphId>`
- metadata:
  - `graphRunId`
  - `graphId`
  - `graphVersion`
  - `entrypoint`: `daemon` / `cli` / `controlplane` / `acp`

如果存在 session 语义，再补：

- `graphSessionId`

如果当前节点执行在 graph 中，还要在节点级别再补：

- `nodeId`
- `nodeKind`
- `agentModelRef` 或节点解析后的模型标识

原则是：graph 层只提供 graph 公共上下文和节点身份，不重复写 runtime run 自己已经有的字段。

### 4. Node Runtime 层：合并 tracing config 和 tracing context

节点执行器在 `buildRuntimeForNode()` 构造 `SessionRuntimeOptions` 时，新增：

- `tracing`
- graph/node 级 tracing context

然后 `@tianji/runtime` 在自己的 run 执行阶段继续做现有事情：

- 创建或复用 `LangChainTracer`
- 补齐 runtime 自己的 `sessionId/runId/triggerType/model/...`
- 把 graph tracing context 和 runtime tracing context 做合并
- 最终注入 `callbacks/tags/metadata`

合并规则必须明确：

- tags：拼接
- metadata：浅合并
- runtime 自己生成的关键字段优先，防止外部上下文覆盖 `runId/sessionId/triggerType`

## 数据流

目标数据流如下：

1. 用户配置 `runtime.tracing.langsmith`
2. `loadAgentContext()` 读取并保留该配置
3. `buildDefaultGraph()` 把 tracing config 注入默认 `deepagents` executor factory
4. `runOrchestrationGraph()` 为本次 graph run 准备 graph tracing context
5. graph 调度到某个 agent 节点时，节点执行器：
   - 创建独立 `SessionRuntime`
   - 把 tracing config 透传给 runtime
   - 把 graph + node tracing context 一并透传
6. `SessionRuntime` 运行节点时：
   - 生成 runtime 自己的 run tracing context
   - 与 graph/node tracing context 合并
   - 注入 deepagents runnable config
7. LangSmith 收到每个节点的 runs
8. 用户可以通过共同的 `graphRunId/graphId/nodeId` 聚合查看整轮 graph 行为

## 接口变化

### `packages/agent`

需要扩展 graph executor factory 的输入能力，使其能接收 tracing config。这里不要求暴露太多 runtime 内部类型，只需要保留清晰边界：

- graph build 层知道“有没有 tracing config”
- executor 知道“怎么把 tracing config 和 graph tracing context 传给 runtime”
- executor 不负责创建 LangSmith client

### `packages/runtime`

runtime 需要接受两类 tracing 输入：

- tracing config：决定是否启用 LangSmith、project/key/url 等
- external tracing context：来自 graph 层的 tags / metadata 补充

runtime 不应该接受 graph 专属业务对象，只接受扁平的 tracing context。

## 字段设计

本次推荐的 graph tracing metadata 最小集合：

- `graphRunId`
- `graphId`
- `graphVersion`
- `nodeId`
- `nodeKind`
- `entrypoint`

可选：

- `graphSessionId`
- `agentName`

不应放入 tracing metadata 的内容：

- 整个 graph state
- 全量 message 历史
- 系统提示词全文
- 工具输入输出原文的大对象

### 字段优先级

- graph/node tracing context 只能补充上下文
- runtime 自己生成的 `sessionId/runId/triggerType/model` 始终优先
- 外部上下文不得覆盖 runtime 内部身份字段

## 错误语义

继续保持 fail fast：

- tracing config 缺 `project` 或 `apiKey` 时，仍然直接报错
- graph tracing context 构造失败时，直接让 graph run 暴露问题
- 不添加“没有 trace 就静默退化为无 tracing”的补丁逻辑

唯一允许保持现有静默行为的点是：

- tracing 完全未启用时，按当前逻辑不注入 LangSmith tracer

也就是说：

- “没开 tracing”可以无 tracing 运行
- “开了 tracing 但配置/透传有问题”必须暴露问题

## 测试策略

至少补三层测试：

### 1. Executor 单元测试

验证 graph 节点执行路径在构造 `SessionRuntimeOptions` 时，确实带上了 tracing config。

关注点：

- `createDeepagentsExecutorFactory()` 生成的节点 action
- `buildRuntimeForNode()` 调用 `createSessionRuntime()` 时的参数
- graph 层 tracing config 不会丢

### 2. Runtime 单元测试

验证 runtime 会把外部 tracing context 与内部 run tracing context 合并。

关注点：

- tags 正确拼接
- metadata 正确合并
- runtime 自己的 `sessionId/runId/triggerType/model` 优先

### 3. Graph 集成测试

验证最小编排图路径下，节点 runtime 生成的 LangChain RunnableConfig 中包含：

- `callbacks`
- graph 级 tags
- graph/node 级 metadata
- runtime 自己的 run metadata

不要求真实访问 LangSmith，只需要断言构造参数正确。

## README 影响

文档需要补一段非常明确的话，防止后续再把架构理解错：

- 编排图 tracing 的共享单位是 graph tracing context
- 节点仍然使用独立 `SessionRuntime`
- graph tracing context 会被透传到节点 runtime
- 当前版本不保证 LangSmith UI 中天然展示严格父子 trace 树；通过 `graphRunId` 等字段做聚合

## 风险与约束

### 风险 1：把 graph tracing 和 runtime tracing 混成一套业务状态

如果把 graph state、message history、tool payload 大对象直接塞进 tracing context，会让 tracing 变成隐式全局载体。这违反当前项目“隐式全局变量只允许放基础变量”的约束。

### 风险 2：graph 层覆盖 runtime 内部字段

如果 graph tracing metadata 可以覆盖 `runId/sessionId/triggerType`，最后 LangSmith 中的 run 身份会变脏，排查更难。必须由 runtime 内部字段优先。

### 风险 3：误把问题扩大成执行模型重构

本次问题是 tracing 透传断了，不是执行模型本身坏了。不能借修 tracing 去强推“全图一个 SessionRuntime”。

## 最终设计结论

采用“共享 graph trace，上下文透传到每个节点 runtime”的方案。

具体来说：

- 保持当前节点级 `SessionRuntime` 独立创建模型不变
- graph 层新增 graph tracing context
- 执行器把 tracing config + graph tracing context 一起传给节点 runtime
- runtime 在原有 run tracing 基础上合并 graph/node tracing context
- 通过共同的 `graphRunId/graphId/nodeId` 让 LangSmith 中的节点 runs 可以被整轮 graph run 聚合查看

这样既能修掉当前“LangSmith 配了但 graph 路径无 trace”的问题，也不会破坏现有执行边界。
