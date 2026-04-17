# Runtime 统一执行入口设计文档

- **日期**：2026-04-17
- **作者**：brainstorming 会话结论
- **范围**：`@tianji/agent`、`@tianji/runtime`、`apps/node`
- **状态**：设计已确认，待撰写实现计划

## 1. 背景与目标

### 1.1 当前问题不是“多入口”，而是“多入口 + 多主链”

当前仓库里存在 3 类起跑方式：

1. Controlplane 任务链
2. CLI / Daemon 本地链
3. ACP 独立进程链

表面上看，这是“入口来源不同”。
实际上更严重的问题是：这些入口没有先汇合到统一进程内入口，再进入唯一运行主链，而是分别持有自己的起跑逻辑、session 建立逻辑、执行后端选择逻辑。

现状导致的结果是：

- deepagents 相关路径最终会进入 Runtime
- ACP 相关路径仍然以独立主链形式存在
- 系统最终不是“多入口，单运行链路”，而是“多入口，多分叉，多主链”

这违背了本次架构收口目标。

### 1.2 用户确认后的目标链路

本次设计遵循以下已经确认的目标链路：

```text
入口来源
├─ Controlplane
├─ CLI
├─ Daemon
└─ ACP 请求
        |
        v
  [@tianji/agent 统一进程内入口]
        |
        v
   [创建默认编排图]
        |
        v
 [@tianji/runtime 运行图]
        |
   +----+----+
   |         |
   v         v
[deepagents 节点] [ACP 节点]
   |         |
   v         v
[进程内执行] [委托外部 agent 进程执行]
```

这里的关键点只有一个：

**统一的是控制链、状态链、事件链，不是强行要求所有节点都在 Runtime 进程内执行。**

所以 ACP 仍然可以调用外部 agent，但它只能作为编排图中的节点执行方式，不能继续作为一条平行主链存在。

### 1.3 目标

1. 所有入口先进入统一进程内入口
2. 所有请求先创建默认编排图，再进入运行阶段
3. Runtime 成为唯一运行控制层，统一控制 run / session / event / cancel / resume
4. ACP 被降级为图节点执行器，而不是独立主执行链
5. 旧的“入口直跑、直建 session、直走 ACP”路径退出主链

### 1.4 非目标

1. 不要求所有 agent 实际执行都进程内完成
2. 不在本次设计中引入渐进式双链兼容
3. 不在本次设计中先做 `@tianji/agent` 和 `@tianji/runtime` 物理合包
4. 不把所有配置装配职责下沉进 Runtime

## 2. 方案选择

### 2.1 备选方案

| 方案 | 描述 | 结论 |
|------|------|------|
| A | 保留 `agent` / `runtime` 双包，但把 `agent` 收窄为统一入口 + 默认图装配层，把 `runtime` 收口为唯一运行控制层 | 选中 |
| B | 直接把 `agent` 和 `runtime` 合成单个“编排层包” | 本次不选 |
| C | 把默认图创建和入口收口一起下沉到 `runtime` | 不选 |

### 2.2 选择 A 的理由

1. 当前真正要硬切的是主链控制权，不是先做物理合包
2. `runtime` 的运行控制职责已经比较清楚，问题不在于它不存在，而在于外层还在分散持有起跑权
3. `agent` 仍然需要保留一层，用来承接协议适配、默认图装配、节点执行器依赖准备
4. 若现在同时做主链硬切 + 包级重组，会把问题混在一起，改动面过大，验证难度明显增加

## 3. 分层职责

### 3.1 `@tianji/agent` 的新职责

`@tianji/agent` 不再持有主链运行控制权，它的职责只保留为：

1. 提供统一进程内入口
2. 将外部入口请求翻译为统一图运行请求
3. 加载或创建默认编排图
4. 为图节点准备执行器依赖
5. 适配外部协议边界，如 Daemon、ACP、Controlplane 对接

`@tianji/agent` 不再负责：

1. 自己创建并持有主链 session 运行模型
2. 让入口直接绕过默认图执行
3. 让 ACP 维持一条独立主链

### 3.2 `@tianji/runtime` 的新职责

`@tianji/runtime` 是唯一运行控制层，负责：

1. 接收已经准备好的图运行请求
2. 创建或恢复 session
3. 创建、推进、取消、恢复 run
4. 统一发射运行事件
5. 驱动整张图的执行
6. 在节点级调度不同 executor

`@tianji/runtime` 不负责：

1. 感知 CLI / Daemon / ACP / Controlplane 的外层协议差异
2. 直接读取入口层的请求结构
3. 猜测默认图从哪里来

### 3.3 两层之间的硬边界

以后只能是：

- `agent` 负责“把请求送上统一主链”
- `runtime` 负责“真正控制这条主链怎么跑”

不允许再出现“agent 和 runtime 同时持有部分主链控制权”的状态。

## 4. 唯一主链与不变量

### 4.1 唯一主链

统一后的系统只认这一条主链：

```text
任意入口请求
  -> 统一进程内入口
  -> 解析执行请求
  -> 创建默认编排图
  -> Runtime 开始图运行
  -> Runtime 控制节点调度、事件、取消、恢复
  -> 节点内部再决定具体执行后端
```

### 4.2 架构不变量

设计是否正确，按下面 3 条判断：

1. 是否先进入统一入口
2. 是否先创建默认编排图
3. 是否最终由 Runtime 控制 run / session / event / cancel / resume

只要某条链路绕开这 3 条中的任意一条，这条链路就不再是合法主链。

### 4.3 Runtime 内部的节点执行方式

Runtime 执行图时，节点可以有不同执行方式：

| 节点类型 | 执行位置 | 说明 |
|----------|----------|------|
| deepagents 节点 | 进程内 | 由 Runtime 直接驱动 |
| ACP 节点 | 进程外 | Runtime 通过 ACP executor 委托外部 agent |

这两种节点执行方式是 Runtime 内部的调度差异，不构成两条主链。

## 5. 统一进程内入口契约

### 5.1 入口形态

`@tianji/agent` 需要新增一个明确的一等入口，语义上等价于：

```text
createUnifiedRuntimeEntry(deps)
run(request)
resume(request)
cancel(request)
stream(request)
```

这里不要求函数名和文件名必须与上面完全一致，但职责必须一致。

### 5.2 入口请求的最小语义

统一入口收到的请求，至少要能表达以下信息：

| 字段语义 | 说明 |
|----------|------|
| source | 请求来源：controlplane / cli / daemon / acp |
| agentId 或 graph 选择信息 | 用于决定默认图里引用哪个 agent 或哪套图配置 |
| input | 本轮用户输入或任务目标 |
| session 信息 | 新建、复用、恢复时所需的 session 标识 |
| run 控制信息 | cancel / resume 所需的 run 标识与载荷 |
| observer / event hook | 供外层记录和转发事件 |

统一入口的职责不是自己跑，而是把这些输入收敛成 Runtime 能执行的统一图运行请求。

### 5.3 统一入口的处理顺序

统一入口内部必须固定按以下顺序处理：

1. 解析请求来源与基础上下文
2. 解析 agent / workspace / provider 等装配依赖
3. 创建默认编排图
4. 创建节点执行器注册表
5. 生成 Runtime 图运行请求
6. 调用 Runtime 进入运行控制链

不能把第 3 步和第 6 步颠倒。也不能在第 1 步后直接建 session 开跑。

## 6. Runtime 图运行入口

### 6.1 Runtime 新的一等能力

`@tianji/runtime` 需要提供一个真正面向“整张图”的运行入口，而不是让外层自己拼一半运行模型。

语义上需要具备以下能力：

1. 接收一张已验证的编排图
2. 接收初始状态输入
3. 接收节点执行器注册表
4. 创建或恢复 session / run
5. 统一产出事件流
6. 支持 cancel / resume

### 6.2 Runtime 对外暴露的边界

Runtime 对外只认“图运行请求”，不再认：

1. 某个入口自己的 session facade
2. 某个入口自己的 `query()` 私有约定
3. 某个入口自己的 ACP 直连运行模型

换句话说，Runtime 之后看到的世界里，只剩两类东西：

1. 图
2. 图里的节点执行器

## 7. 默认编排图模型

### 7.1 默认图的地位

默认编排图不是可选增强，而是统一主链的强制前置步骤。

任何入口请求都必须先落成一张默认图，再由 Runtime 去执行。

### 7.2 默认图的基本规则

1. 默认图的创建发生在统一入口层
2. 默认图是 Runtime 的直接输入
3. 默认图中可以包含 deepagents 节点和 ACP 节点
4. ACP 节点只表示“这个节点的执行委托给外部 agent”，不表示“从这里切换到另一条主链”

### 7.3 默认图的构造来源

统一入口可以通过以下来源得到默认图：

1. 静态配置文件加载
2. 由入口按既定规则装配最小默认图
3. 未来由更高层编排器生成

无论来源如何，进入 Runtime 前都必须已经是一张完整图，而不是半成品配置。

## 8. 四类入口如何接入主链

### 8.1 Controlplane 任务链

目标链路：

```text
Controlplane
  -> Node TaskExecutor
  -> @tianji/agent 统一入口
  -> 默认图
  -> Runtime
```

`TaskExecutor` 以后不能再自己决定：

1. 直接走 `AgentRunner`
2. 直接走 `InProcessRunner`
3. 按 native/external 选择主链

它只能把任务请求交给统一入口。真正的 deepagents / ACP 节点分流发生在 Runtime 执行图时。

### 8.2 CLI / Daemon 本地链

目标链路：

```text
CLI / Daemon HTTP
  -> DaemonServer
  -> @tianji/agent 统一入口
  -> 默认图
  -> Runtime
```

CLI 不能再直接 `new AgentRunner()`。
Daemon 启动时也不能再预先创建一套长期持有、绕开统一入口的主链 session facade。

Daemon 以后只保留：

1. HTTP / SSE 协议适配
2. 把请求转给统一入口
3. 将 Runtime 事件转回 SSE

### 8.3 ACP 请求链

ACP 请求也是入口来源之一，但它不能再天然等于 ACP 主链。

目标链路：

```text
ACP request
  -> ACP bridge / adapter
  -> @tianji/agent 统一入口
  -> 默认图
  -> Runtime
```

也就是说：

- ACP 是入口协议，不是运行主链
- ACP request 进入系统后，仍然要先走统一入口和默认图
- 如果默认图中某个节点是 ACP 节点，才会再次委托外部 agent

这看起来像“ACP 进来以后，图里还能再有 ACP 节点”，但两者语义不同：

1. 前者是入口协议
2. 后者是 Runtime 图中的节点执行器

不能把这两层混为一谈。

### 8.4 统一后对外层入口的共同约束

不管是哪类入口，都必须满足：

1. 不自己创建主链 session
2. 不自己决定主链执行后端
3. 不绕过默认图直接执行 agent
4. 不保留 ACP 直跑为主链

## 9. 现有链路中的问题点

### 9.1 当前不是“几个坏文件”，而是“起跑方式未汇合”

这次改造不能把问题理解成“修 4 个文件就完了”。

当前真正的问题是：

1. CLI / Daemon / Controlplane / ACP 各自都还握着部分起跑权
2. 它们没有先汇合到统一入口
3. 因此 Runtime 没有成为唯一运行控制层

### 9.2 已识别的旧链路症状

以下位置已经表现出旧主链症状，但它们只是症状，不是全部问题本体：

| 文件 | 旧行为 |
|------|--------|
| `apps/node/src/commands/run.ts` | 直接 `new AgentRunner()`，CLI 单轮直接走 ACP 路 |
| `apps/node/src/daemon-entry.ts` | 启动时直接创建长期持有的 agent session 运行对象 |
| `packages/agent/src/acp-entry.ts` | ACP 入口自己加载默认图并直接创建 session 语义 |
| `packages/agent/src/session.ts` | `createAgentSession()` 自己持有 runtime 和 graph 运行控制 |

这些代码以后都不能继续作为主链核心。

## 10. 旧能力的删除与替换

### 10.1 必须退出主链的旧模型

以下旧模型必须退出主链：

1. 入口直接 `new AgentRunner()`
2. 入口直接 `createAgentSession()`
3. 入口自己决定走 ACP 还是 in-process
4. ACP 作为独立主执行链存在
5. 由入口直接创建 session 后再决定是否编排

### 10.2 可保留但降级为内部细节的能力

以下能力可以保留，但只能作为内部实现细节，不再暴露成主链模型：

1. ACP client / process 管理能力
2. deepagents executor factory
3. 图加载器
4. graph compiler / validator / io mapping

保留这些能力的前提是：它们只能被统一入口或 Runtime 调用，不能让入口层再次绕开主链。

## 11. 错误处理与事件原则

### 11.1 Let it crash

本次统一链路不做双链兼容兜底，也不做静默回退。

如果某个入口仍然试图：

1. 直接跑旧 session 模型
2. 直接起 ACP 主链
3. 绕开默认图进入 Runtime

系统应直接报错暴露，而不是偷偷替它补一层兼容。

### 11.2 事件统一原则

统一后的事件链必须满足：

1. 所有运行事件都从 Runtime 发出
2. 外层协议只做事件适配和转发
3. 不允许某条主链拥有自己的终态、取消、恢复语义

这意味着：

- CLI 的 stdout 是 Runtime 事件的视图
- Daemon SSE 是 Runtime 事件的视图
- ACP SessionUpdate 也应该是 Runtime 事件的协议视图

而不是三套互不相同的运行事件源。

## 12. 测试与验证标准

### 12.1 必测主链场景

实现后必须覆盖以下整链测试：

1. Controlplane 请求进入统一入口，再由 Runtime 跑默认图
2. CLI / Daemon 请求进入统一入口，再由 Runtime 跑默认图
3. ACP 请求进入统一入口，再由 Runtime 跑默认图
4. 默认图包含 deepagents 节点时，事件、取消、恢复由 Runtime 正常控制
5. 默认图包含 ACP 节点时，事件、取消、恢复仍由 Runtime 正常控制

### 12.2 判定通过的标准

若以下任一现象仍然存在，则设计没有落地成功：

1. 存在入口直接起 session 主链
2. 存在入口直接起 ACP 主链
3. 存在“先执行、后补图”链路
4. 存在运行状态不受 Runtime 控制的路径

## 13. 实施顺序建议

本设计建议按以下顺序落地：

1. 先定义 `@tianji/agent` 的统一入口契约
2. 再定义 `@tianji/runtime` 的图运行入口契约
3. 再让默认图创建从入口私有逻辑迁移到统一入口
4. 再接入 Controlplane / CLI / Daemon / ACP 四类入口
5. 最后删除旧主链入口和旧 session facade

这个顺序的目的只有一个：先把新主链立起来，再拆旧链，而不是边拆边猜。

## 14. 最终结论

本次收口不采用“渐进式双链兼容”，而采用硬切方案。

最终架构结论是：

1. 保留 `@tianji/agent` 和 `@tianji/runtime` 两层
2. `@tianji/agent` 收窄为统一入口 + 默认图装配层
3. `@tianji/runtime` 成为唯一运行控制层
4. 所有入口必须先进入统一入口，再创建默认图，再进入 Runtime
5. ACP 只能作为图节点执行方式存在，不能继续作为平行主链

这才符合“多入口，单运行链路”的目标。
