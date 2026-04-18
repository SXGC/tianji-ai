# MCP 渐进式披露接入设计文档

- **日期**：2026-04-18
- **作者**：brainstorming 会话结论
- **范围**：`@tianji/agent`、`@tianji/runtime`、`packages/shared`
- **状态**：设计已确认，待撰写实现计划

## 1. 背景与目标

### 1.1 当前问题

当前仓库的运行时工具面是：

1. 会话或节点运行前构造 `ToolCatalog`
2. 运行时把 `ToolCatalog` 一次性转成 deepagents tools
3. 本轮 run 内模型可见的工具集合固定

这套模型对普通工具没有问题，但对 MCP 会直接暴露三个问题：

1. 如果把所有 MCP server 的所有工具都注册进 `ToolCatalog`，上下文会膨胀
2. 如果试图在同一轮 run 中“先发现 server，再动态追加工具”，会和当前“run 开始前工具集合固定”的模型冲突
3. 在编排图里，如果每个节点都共享同一份 `ToolCatalog` 和 `skills`，节点之间的能力边界会直接泄漏

### 1.2 已确认目标

本次设计只解决以下目标：

1. 模型一开始不要看到所有 MCP tool schema
2. 模型一开始要知道“系统里有哪些 MCP server，以及各自大致擅长什么”
3. 真正执行 MCP 调用时，仍然保留 runtime 侧的超时、取消、日志和事件边界
4. 工具调用的目标表达方式要模仿 `mcporter` 的 `server.tool` 心智模型
5. 编排图里的每个节点只能看到并调用自己被显式授予的 Skill / Tool / MCP target

### 1.3 非目标

本次设计明确**不**做以下事情：

1. 不在同一轮 run 内动态修改 `ToolCatalog`
2. 不把所有 MCP tool 直接映射为 runtime tools
3. 不把 MCP 完全翻译成纯 `Skill`，绕过工具执行边界
4. 不复制 `mcporter` 面向 CLI 的字符串语法，例如 `key=value`、`foo:bar`、`server.tool(...)`
5. 不做模糊匹配、自动纠错、猜测最可能 tool 之类的启发式行为

## 2. 方案选择

### 2.1 备选方案

| 方案 | 描述 | 结论 |
|------|------|------|
| A | 把所有 MCP tools 全量注册成 runtime tools | 不选 |
| B | 把 MCP 完全翻译成 deepagents skills，不保留工具边界 | 不选 |
| C | 用 Skill 承载 MCP server 目录信息；执行面只保留单一 `call_mcp` 工具 | 选中 |

### 2.2 不选 A 的原因

1. tool schema 总量不可控，server 一多就会撑爆上下文
2. 本轮 run 里模型看到的工具噪音太大，选择成本上升
3. 很多 MCP tool 根本不会被用到，却要为每轮 prompt 付上下文成本

### 2.3 不选 B 的原因

1. deepagents `skills` 的语义是按需加载说明文件，不是可执行工具注册
2. 纯 skill 路径天然缺少参数 schema、权限门、超时、取消、事件等执行边界
3. 如果把执行藏到“模型输出意图，宿主自己猜着跑”，只会把显式契约变成隐式协议

### 2.4 选择 C 的原因

1. deepagents 的 `skills` 天然适合“先暴露目录，再按需读取说明”的渐进式披露
2. 单一 `call_mcp` 工具可以把上下文成本压到最小
3. 真实执行仍然经过 runtime 工具边界，不需要另造一套旁路执行系统
4. `call_mcp` 的目标格式可以直接采用 `mcporter` 的 `server` / `server.tool` 心智模型
5. 节点能力边界可以在图执行装配层完成裁剪，不需要侵入 runtime 内核

## 3. 整体架构

### 3.1 总体思路

系统拆成两层：

1. **发现层**
   - 以 session-scoped `Skill` 目录形式暴露 MCP server 摘要
   - 模型通过 skill 知道“有哪些 server、各自能做什么”
2. **执行层**
   - 以单一 `call_mcp` runtime tool 承载真实 MCP 调用
   - 模型通过结构化参数指定是“发现某个 server 的 tools”还是“调用某个 tool”

### 3.2 运行链路

```text
创建图运行上下文
  -> 解析本次 graph run 的能力上限
  -> 生成 session-scoped MCP skills
  -> 注册单一 call_mcp 工具
  -> 每个节点执行时再按节点声明裁剪 Skill / Tool / MCP target
  -> createSessionRuntime(...)

本轮对话
  -> 模型先从 skill 里知道有哪些 MCP server
  -> 若需要细看某个 server 的具体 tools，调用 call_mcp(action=discover, target=server)
  -> 若需要真实执行，调用 call_mcp(action=invoke, target=server.tool, arguments={...})
```

### 3.3 架构不变量

本设计必须保持以下不变量：

1. run 开始前工具集合固定，运行中不热插拔
2. MCP server 摘要走 `skills`
3. MCP 执行只走 `call_mcp`
4. 不允许从 skill 直接触发隐式执行
5. 节点可见能力必须是图运行能力上限的子集，不能越权

## 4. 能力模型

### 4.1 两层能力边界

本设计采用两层能力边界：

1. **图运行能力上限**
   - 本次 graph run 整体最多允许使用哪些 skill、tool、MCP target
2. **节点能力子集**
   - 每个节点只能从图运行能力上限中声明自己的可见能力

唯一合法关系是：

```text
节点可见能力 ⊆ 图运行能力上限 ⊆ 系统全局能力
```

### 4.2 为什么必须分两层

如果只做节点级声明，不做图运行能力上限，会出现两个问题：

1. LLM 生成图时可能偷偷把节点能力提到系统全局能力
2. 同一张图里的不同节点无法被统一压缩到一个安全边界内

如果只做图运行能力上限，不做节点级子集，会出现另一个问题：

1. 图里每个节点都会默认看到同一套能力，导致边界泄漏

所以两层都必须有，不能只保留一层。

### 4.3 能力种类

本设计里需要限制的能力分三类：

1. `skills`
   - 供模型读取说明和能力目录
2. `tools`
   - runtime 真正注册的可调用工具
3. `mcpTargets`
   - 对 `call_mcp` 进一步细化到 `server` 或 `server.tool` 的允许范围

其中：

1. `skills` 解决“模型能看到什么”
2. `tools` 解决“模型能调用哪些 runtime tool”
3. `mcpTargets` 解决“模型即使能调用 `call_mcp`，也只能打到哪些 MCP 目标”

## 5. 分层职责

### 5.1 `@tianji/agent` 的职责

`@tianji/agent` 负责图运行级装配：

1. 解析本次 graph run 的能力上限
2. 为能力上限中的 MCP server 生成 session-scoped `SKILL.md`
3. 维护逻辑能力 ID 到真实 skill 路径 / tool 定义 / MCP target 策略的映射
4. 创建 `call_mcp` 工具定义
5. 节点执行时，按节点声明把共享能力上限裁成节点子集
6. 把裁剪后的 `skills` 路径和 `toolCatalog` 注入节点级 `createSessionRuntime(...)`

`@tianji/agent` 不负责：

1. 在运行中途修改 tool set
2. 让模型直接看到所有 MCP tool schema
3. 允许节点绕过上限自己提升能力

### 5.2 `@tianji/runtime` 的职责

`@tianji/runtime` 继续维持当前边界：

1. 接收 `skills` 路径
2. 接收 `ToolCatalog`
3. 把 `call_mcp` 当普通 runtime tool 执行
4. 继续统一处理工具调用事件、取消、超时和日志

`@tianji/runtime` 不负责：

1. 解析外部 MCP 配置文件来源
2. 推断某个 server 应不应该被当前 session 看见
3. 在内部维护一套“动态增删工具”的特殊行为
4. 理解图节点自己的授权模型

### 5.3 `packages/shared` 的职责

`packages/shared` 只在需要时新增共享契约：

1. MCP server 摘要类型
2. `call_mcp` 输入输出类型
3. 图节点能力声明类型
4. 若需要，再补充 observer / protocol 侧使用的结构化 payload 类型

## 6. 图节点能力声明

### 6.1 节点字段

对 `AgentNode.agent`，建议采用以下字段模型：

```ts
interface AgentNodeAgentConfig {
  readonly model: string
  readonly systemPrompt: string
  readonly skills?: readonly string[]
  readonly tools?: readonly string[]
  readonly mcpTargets?: readonly string[]
  readonly subagents?: readonly SubAgentDef[]
}
```

### 6.2 字段语义

1. `skills`
   - 节点可见的 skill 逻辑 ID
   - 不是文件路径
2. `tools`
   - 节点可调用的 runtime tool 名单
3. `mcpTargets`
   - 节点允许通过 `call_mcp` 访问的 MCP 目标
   - 允许值形如 `github` 或 `github.list_pull_requests`

### 6.3 默认值策略

本设计明确采用保守默认值：

1. `skills` 缺省 = 空
2. `tools` 缺省 = 空
3. `mcpTargets` 缺省 = 空

也就是说，节点默认什么都看不到、什么都不能调，必须显式授予。

不允许使用以下危险语义：

1. `undefined = 全部可见`
2. `空数组 = 全部可见`

### 6.4 为什么 `skills` 不能直接写路径

图里不应该直接写真实 skill 路径，原因有三个：

1. 图和宿主文件布局会强耦合
2. session 动态生成的 skill 目录没有稳定路径可供图长期引用
3. LLM 生成图时更容易生成出无效路径

因此图层只保存逻辑能力 ID，执行层再解析成真实路径。

## 7. Skill 设计

### 7.1 Skill 的定位

每个 MCP server 生成一个 session-scoped skill。

skill 只负责回答：

1. 这个 server 是什么
2. 适合做什么
3. 大概有哪些能力类别
4. 什么时候应该用它
5. 什么时候不应该用它
6. 如果需要精确工具签名，应该调用 `call_mcp`

skill **不**负责：

1. 携带完整 tool schema
2. 直接执行真实 MCP 请求

### 7.2 Skill 文件布局

语义上需要一个**session 级临时目录**，其中包含每个 server 的 `SKILL.md`。

示意结构：

```text
<session-generated-skill-root>/
  github/
    SKILL.md
  linear/
    SKILL.md
  context7/
    SKILL.md
```

具体落盘路径不在本设计里写死，但必须满足：

1. 对当前 backend 可读
2. 与 session 生命周期绑定
3. 不污染用户源码目录的主结构

### 7.3 Skill 内容模板

每个 `SKILL.md` 至少包含：

```md
---
name: github
description: GitHub MCP，适合仓库、issue、PR 查询与变更
---

# GitHub MCP

## 适用场景
- 查看仓库、Issue、Pull Request
- 读取评论、检查 CI 状态

## 不适用场景
- 本地文件系统读写
- 通用网页抓取

## 认证状态
- authenticated

## 风险等级
- medium

## 能力摘要
- repository
- issues
- pull_requests
- checks

## 使用规则
- 如果你只需要知道有哪些 GitHub 工具，调用 `call_mcp`，`action=discover`，`target=github`
- 如果你已经知道要调用哪个 GitHub 工具，调用 `call_mcp`，`action=invoke`
```

### 7.4 Skill 逻辑 ID 与路径映射

需要显式维护一层映射：

```ts
type SkillId = string

interface ResolvedSkillRef {
  readonly id: SkillId
  readonly path: string
}
```

执行器装配时：

1. 节点声明 `skills = ["mcp.github", "mcp.linear"]`
2. 宿主从图运行能力上限中解析出对应真实路径
3. 节点 runtime 只注入这些路径

### 7.5 Skill 生成时机

skill 必须在 graph run 上下文创建前完成生成，并作为可解析资源挂入能力上限。

不允许在 run 中途追加 skill 源目录。

## 8. Tool 裁剪设计

### 8.1 当前问题

当前节点执行器虽然已经把 `node.agent.skills` 透传给节点级 runtime，
但 `toolCatalog` 仍然可能是所有节点共享的整包目录。

这意味着：

1. 图 schema 虽然有 `node.agent.tools`
2. 但节点实际上仍然可能看到共享 catalog 里的全部工具

这条链路必须被切断。

### 8.2 正确做法

节点执行时，不能把共享 `toolCatalog` 直接塞进节点 runtime。

必须先按节点声明裁成子集，再注入：

```text
共享图运行工具上限
  -> 按 node.agent.tools 裁剪
  -> 生成节点专属 ToolCatalog
  -> 注入节点 runtime
```

### 8.3 设计要求

1. 节点 runtime 只能看到裁剪后的 `ToolCatalog`
2. 如果节点声明了不存在的 tool，图编译阶段直接失败
3. 如果节点声明了超出图运行上限的 tool，图编译阶段直接失败

## 9. `call_mcp` 工具契约

### 9.1 设计原则

`call_mcp` 必须模仿 `mcporter` 的**目标表达方式**，但不复制它的 CLI 语法糖。

保留的部分：

1. 目标写法采用 `server` 或 `server.tool`
2. 动作分为“发现”和“调用”

不保留的部分：

1. `key=value`
2. `foo:bar`
3. `server.tool(...)`
4. 任意字符串解析

### 9.2 输入结构

`call_mcp` 使用一个统一对象输入：

```ts
type CallMcpInput =
  | {
      action: "discover"
      target: string          // server，例如 "linear"
      schema?: boolean
      allParameters?: boolean
    }
  | {
      action: "invoke"
      target: string          // server.tool，例如 "linear.create_comment"
      arguments: Record<string, unknown>
      timeoutMs?: number
    }
```

### 9.3 discover 语义

`action = "discover"` 时：

1. `target` 必须是 server 名，不允许带 tool
2. 系统连接对应 MCP server
3. 拉取该 server 的工具列表
4. 返回适合模型消费的结构化摘要

示例：

```json
{
  "action": "discover",
  "target": "linear"
}
```

### 9.4 invoke 语义

`action = "invoke"` 时：

1. `target` 必须是 `server.tool`
2. `arguments` 必须是结构化对象
3. 运行时不解析任何 CLI 风格字符串
4. 所有校验失败都直接报错

示例：

```json
{
  "action": "invoke",
  "target": "linear.create_comment",
  "arguments": {
    "issueId": "ENG-123",
    "body": "Looks good!"
  }
}
```

### 9.5 输出结构

`discover` 输出建议：

```ts
interface CallMcpDiscoverResult {
  readonly target: string
  readonly server: string
  readonly description?: string
  readonly tools: readonly {
    readonly name: string
    readonly qualifiedName: string
    readonly description?: string
    readonly requiredParameters: readonly string[]
    readonly optionalParameterCount: number
    readonly schema?: unknown
  }[]
}
```

`invoke` 输出建议：

```ts
interface CallMcpInvokeResult {
  readonly target: string
  readonly server: string
  readonly tool: string
  readonly content: unknown
  readonly structuredContent?: unknown
  readonly isError: boolean
}
```

## 10. `mcpTargets` 二级约束

### 10.1 为什么仅限制 `tools` 不够

如果节点只声明了：

```ts
tools: ["call_mcp"]
```

但没有额外约束，它理论上仍然可能通过 `call_mcp` 访问任意 `server.tool`。

所以对 MCP 必须再加一层 target 级限制。

### 10.2 `mcpTargets` 语义

`mcpTargets` 表示节点允许访问的 MCP 目标集合。

允许两种粒度：

1. server 级
   - 例如 `github`
   - 表示允许 discover 该 server，并允许 invoke 其下游 tool，前提是全局策略不拒绝
2. tool 级
   - 例如 `github.list_pull_requests`
   - 表示只允许这个精确 tool

### 10.3 检查顺序

执行 `call_mcp` 时，必须按以下顺序检查：

1. 该节点是否拥有 `call_mcp`
2. 目标 `server` 或 `server.tool` 是否在节点 `mcpTargets` 允许范围内
3. 目标是否在图运行能力上限内
4. 全局策略是否允许执行该 target

任一步失败都直接报错。

### 10.4 discover 的限制

即使是 `discover`，也不能无限制地探测所有 server。

节点只能 discover 自己 `mcpTargets` 允许的 server。

## 11. 执行流程

### 11.1 图运行初始化

```text
load graph-run capability upper bounds
  -> build session skill files
  -> build shared capability resolvers
  -> create call_mcp tool
  -> register tool into shared ToolRegistry
```

### 11.2 图编译校验流程

```text
compile graph
  -> validate node.skills are resolvable from graph-run skill upper bound
  -> validate node.tools are subset of graph-run tool upper bound
  -> validate node.mcpTargets are subset of graph-run MCP upper bound
  -> fail fast on any mismatch
```

### 11.3 节点 runtime 装配流程

```text
buildRuntimeForNode(node)
  -> resolve node skill ids to concrete paths
  -> slice shared ToolRegistry by node.agent.tools
  -> build node-scoped MCP target policy from node.agent.mcpTargets
  -> inject node-scoped skills + ToolCatalog + MCP policy into node runtime
```

### 11.4 discover 流程

```text
call_mcp(action=discover, target=server)
  -> validate current node can use call_mcp
  -> validate target within node mcpTargets
  -> validate target is server only
  -> resolve server definition from session registry
  -> query MCP tool list
  -> normalize to model-facing summary
  -> return result
```

### 11.5 invoke 流程

```text
call_mcp(action=invoke, target=server.tool, arguments)
  -> validate current node can use call_mcp
  -> validate target within node mcpTargets
  -> validate qualified target
  -> resolve server and tool
  -> validate arguments shape
  -> execute MCP call
  -> normalize result
  -> return result
```

## 12. 策略与安全边界

### 12.1 关键问题：`call_mcp` 是单一工具，但内部副作用不单一

这是本设计里最容易踩坑的点。

当前 runtime 的 `RuntimeToolDefinition.sideEffect` 是静态字段。  
但 `call_mcp` 实际上包住了：

1. 只读 MCP tools
2. 幂等写操作
3. 破坏性写操作

这意味着：**不能只靠 `call_mcp` 自身的静态 `sideEffect` 来表达真实风险。**

### 12.2 V1 约束

为了不把问题做假，V1 必须采取保守策略，二选一：

1. **只允许显式白名单的只读 MCP targets**
   - `call_mcp` 在 V1 仅允许 discover 和白名单只读 invoke
   - 所有未声明 side effect 的 target 一律拒绝
2. **引入 target 级策略表**
   - 对每个 `server.tool` 维护 `none | idempotent | destructive`
   - `call_mcp` 在执行前按 target 级别做策略检查

如果实现阶段无法同时把 target 级策略和 HITL 接好，则必须先走方案 1。

### 12.3 节点能力相关禁止行为

1. 不允许节点默认继承图运行全部能力
2. 不允许节点声明真实 skill 路径
3. 不允许节点声明超出图运行上限的 tool 或 MCP target
4. 不允许在节点执行中途追加 skill 或 tool

### 12.4 明确禁止的行为

1. 不允许 tool name 模糊匹配
2. 不允许自动猜测最可能 server
3. 不允许 schema 校验失败后自动重试修正
4. 不允许把未认证、离线、HTTP 异常吞掉

## 13. 事件与观测

### 13.1 V1 事件策略

V1 不强制新增 MCP 专用领域事件。

理由：

1. `call_mcp` 已经会被 runtime 当普通 tool 产生 `ToolStarted` / `ToolCompleted` / `ToolFailed`
2. 先把主链打通，比先扩展事件模型更重要

### 13.2 V1 日志最低要求

`call_mcp` 在 observer data 中至少记录：

1. `action`
2. `target`
3. `server`
4. `tool`（invoke 时）
5. `timeoutMs`
6. 错误类型与错误消息

### 13.3 V2 可选增强

后续如果需要更细观测，再新增 MCP 专用事件，例如：

1. `McpDiscoverStarted`
2. `McpDiscoverCompleted`
3. `McpInvokeStarted`
4. `McpInvokeCompleted`

本次设计不把它们列为前置条件。

## 14. 模块拆分建议

### 14.1 `packages/agent`

建议新增：

1. `src/mcp/registry.ts`
   - 解析 session / graph run 可用 MCP server 集合
2. `src/mcp/skill-generator.ts`
   - 生成 session-scoped `SKILL.md`
3. `src/mcp/call-mcp-tool.ts`
   - `call_mcp` 工具定义
4. `src/orchestration/capability-resolver.ts`
   - 解析图运行能力上限
   - 负责 skill id -> path、tool name -> definition、mcp target -> policy 的映射和校验

建议修改：

1. `src/session.ts`
   - 在 graph run 入口处构造图运行能力上限
2. `src/orchestration/executors/deepagents-executor.ts`
   - 不再把共享 `toolCatalog` 直接塞给所有节点
   - 节点 runtime 装配时按节点声明裁剪 skills / tools / mcpTargets

### 14.2 `packages/shared`

建议新增或补充：

1. `McpServerSummary`
2. `CallMcpInput`
3. `CallMcpDiscoverResult`
4. `CallMcpInvokeResult`
5. `AgentNode` 的 `mcpTargets` 字段
6. 图运行能力上限与节点能力声明的共享类型

### 14.3 `@tianji/runtime`

V1 目标是**尽量少改** runtime：

1. 不要求 runtime 新增 MCP 配置解析能力
2. 不要求 runtime 支持动态 tool set
3. 只把 `call_mcp` 当普通 tool 执行
4. 节点能力裁剪逻辑保持在 agent/orchestration 装配层，不下沉到 runtime 内核

如果后续要做 target 级 side-effect policy，再考虑在 runtime 扩展专门钩子。

## 15. 实施顺序

### 15.1 Phase 1：最小可用版本

1. 给 `AgentNode` 增加 `mcpTargets`
2. 引入图运行能力上限模型
3. 生成 MCP skills
4. 注册 `call_mcp`
5. 节点执行时按声明裁剪 `skills` 和 `tools`
6. 支持 `discover`
7. 支持白名单只读 `invoke`
8. 打通日志和基础工具事件

### 15.2 Phase 2：安全增强

1. 引入 target 级 side-effect policy
2. 支持更丰富的认证失败分类
3. 支持 discover 结果缓存

### 15.3 Phase 3：观测增强

1. 补 MCP 专用领域事件
2. 补 controlplane / AG-UI 展示

## 16. 最终结论

本次设计最终收口为一句话：

**MCP server 的“存在与用途”走 Skill，MCP 的“精确发现与真实执行”走单一 `call_mcp` 工具；每个节点只能看到图运行能力上限中显式授予给它的子集。**

这条边界解决了四个问题：

1. 避免全量 MCP tool schema 进入初始上下文
2. 保留 deepagents 原生支持的渐进式 skill 披露
3. 保留 runtime 对真实执行链路的控制权
4. 让编排图里的节点之间形成真正的能力隔离，而不是共享一整包隐式能力

任何偏离这条边界的方案都会重新掉回三个坏方向之一：

1. 全量 tools，导致上下文膨胀
2. 纯 skill 执行，导致丢失工具执行契约
3. 节点共享整包能力，导致图内边界失效
