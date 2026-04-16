# Task 聚合结果事件设计

> 日期：2026-04-16
> 范围：`apps/node`、`apps/controlplane`、`packages/shared`
> 目标：让 controlplane 只消费 `Task` 聚合数据，也能稳定显示任务对应的 LLM 文本输出。

---

## 一、问题定义

当前事件模型中：

| 聚合 | 事件 | 是否携带 LLM 文本 |
|---|---|---|
| `Task` | `TaskStarted` / `TaskCompleted` / `TaskFailed` / `TaskSessionAttached` | 否 |
| `Run` | `MessageStarted` / `MessageDelta` / `MessageCompleted` | 是 |

这导致一个结构性问题：

| 现象 | 根因 |
|---|---|
| controlplane 能看到任务开始和结束，但看不到 LLM 消息 | LLM 文本挂在 `Run` 聚合，不挂在 `Task` 聚合 |
| controlplane 想显示消息时，必须追 `task -> session -> run -> message` | 这是核心业务关联逻辑，不应该放在 controlplane |

因此，当前模型违反了这条职责边界：

| 组件 | 应有职责 | 当前问题 |
|---|---|---|
| daemon | 执行业务，产出完整业务事实 | 只产出了 run 级消息事实，没有产出 task 级展示事实 |
| controlplane | 接收数据、存储数据、转发数据、显示数据 | 想显示任务消息时，被迫推理 task 和 run 的关系 |

本设计的目标，就是把“任务最终展示结果”重新建模为 `Task` 聚合事件。

---

## 二、设计目标

### 必须满足

| 目标 | 说明 |
|---|---|
| controlplane 只订 `Task` 聚合也能显示消息 | 不依赖额外追 run/session |
| 任务消息支持流式输出 | 不把最终文本硬塞进 `TaskCompleted` |
| `TaskCompleted` 仍然只表示生命周期完成 | 不混入正文 |
| 现有 `Run` / `Message` 事件继续保留 | 不破坏调试、审计、观测链路 |
| daemon 负责映射 | controlplane 不承担核心业务逻辑 |

### 明确不做

| 不做什么 | 原因 |
|---|---|
| 不让 controlplane 自己追 `task -> session -> run` | 这是业务逻辑，不是展示逻辑 |
| 不把 LLM 最终文本塞进 `TaskCompleted` | 会破坏生命周期语义，也失去流式能力 |
| 不删除现有 `Run` 聚合消息事件 | 这些事件仍然对 runtime 调试和 observability 有价值 |

---

## 三、推荐方案

新增一组 `Task` 聚合结果事件，让 daemon 在消费 run 级消息事件时，同步发射 task 级展示事件。

### 新增事件

| 事件 | 作用 | 是否流式 |
|---|---|---|
| `TaskMessageStarted` | 当前 task 开始产生一条 assistant 消息 | 是 |
| `TaskMessageDelta` | 当前 task 的 assistant 消息增量文本 | 是 |
| `TaskMessageCompleted` | 当前 task 的 assistant 消息完成，携带最终消息 | 是 |

### 事件职责划分

| 事件族 | 用途 | 消费者 |
|---|---|---|
| `Run` / `Message` | runtime 内部原始执行事实 | observer、调试、审计、深度观测 |
| `TaskMessage*` | task 视角的最终展示事实 | controlplane、AG-UI、前端 |

一句话：

**Run 级消息是“执行事实”，Task 级消息是“展示事实”。**

---

## 四、事件定义建议

### 4.1 TaskMessageStarted

| 字段 | 类型 | 说明 |
|---|---|---|
| `type` | `'TaskMessageStarted'` | 固定值 |
| `taskId` | `string` | 任务 ID |
| `messageId` | `string` | task 视角消息 ID |
| `role` | `'assistant'` | 当前只允许 assistant |
| `timestamp` | `number` | 发射时间 |

### 4.2 TaskMessageDelta

| 字段 | 类型 | 说明 |
|---|---|---|
| `type` | `'TaskMessageDelta'` | 固定值 |
| `taskId` | `string` | 任务 ID |
| `messageId` | `string` | task 视角消息 ID |
| `sequence` | `number` | task 内该消息的 delta 序号 |
| `channel` | `'text' | 'thinking'` | 先与现有 `MessageDelta` 对齐 |
| `payload.content` | `string` | 增量内容 |
| `timestamp` | `number` | 发射时间 |

### 4.3 TaskMessageCompleted

| 字段 | 类型 | 说明 |
|---|---|---|
| `type` | `'TaskMessageCompleted'` | 固定值 |
| `taskId` | `string` | 任务 ID |
| `messageId` | `string` | task 视角消息 ID |
| `message` | `AppMessage` | 最终完整 assistant 消息 |
| `timestamp` | `number` | 发射时间 |

---

## 五、为什么字段这样设计

### 5.1 不复用 runId 作为主关联键

| 选择 | 结论 | 原因 |
|---|---|---|
| task 事件继续以 `taskId` 为主键 | 选它 | 保证 controlplane 只看 task 线 |
| 直接把 runId 带进 task 事件让 cp 自己追 | 不选 | 这会把 run 关联逻辑重新漏到 cp |

### 5.2 `messageId` 独立保留

| 原因 | 说明 |
|---|---|
| AG-UI 需要 message 级开始/增量/结束三段式 | 没有 messageId 不好做稳定映射 |
| 一个 task 未来可能产生多条 assistant 消息 | 不能默认一个 task 只有一条输出 |

### 5.3 保留 `channel`

| 选择 | 结论 |
|---|---|
| 只保留 `text` | 现在能工作，但会把 thinking 能力提前砍掉 |
| 保留 `text | thinking` | 更稳，和现有运行时事件模型一致 |

本设计选择保留 `channel`，但第一阶段允许 controlplane 只消费 `text`。

---

## 六、数据流设计

新增后的数据流如下：

| 阶段 | 事件 |
|---|---|
| 1 | `TaskStarted` |
| 2 | `TaskSessionAttached` |
| 3 | `RunStarted` |
| 4 | `MessageStarted` / `MessageDelta` / `MessageCompleted` |
| 5 | daemon 将其映射为 `TaskMessageStarted` / `TaskMessageDelta` / `TaskMessageCompleted` |
| 6 | `TaskCompleted` |

这里最关键的规则是：

| 规则 | 说明 |
|---|---|
| daemon 同时保留 run 级事件 | 供底层审计与调试 |
| daemon 额外补 task 级结果事件 | 供 controlplane 展示 |
| controlplane 只使用 task 级结果事件渲染消息 | 不追 run |

---

## 七、放在哪里发

推荐发射点放在 `apps/node/src/task/task-executor.ts`，原因如下：

| 备选位置 | 结论 | 原因 |
|---|---|---|
| runtime 引擎层 | 不推荐 | runtime 不知道 task 概念 |
| in-process runner | 不推荐 | runner 知道 session，不天然拥有 task 展示边界 |
| task executor | 推荐 | 这里同时拥有 `taskId` 和 run/message 事件流，最适合做 task 级映射 |

因此，推荐策略是：

| 输入 | 输出 |
|---|---|
| `MessageStarted` | `TaskMessageStarted` |
| `MessageDelta` | `TaskMessageDelta` |
| `MessageCompleted` | `TaskMessageCompleted` |

---

## 八、映射规则

### 8.1 基本映射

| Run 级事件 | Task 级事件 | 备注 |
|---|---|---|
| `MessageStarted` | `TaskMessageStarted` | 直接映射 |
| `MessageDelta` | `TaskMessageDelta` | 直接映射 |
| `MessageCompleted` | `TaskMessageCompleted` | 直接映射 |

### 8.2 过滤规则

| 规则 | 原因 |
|---|---|
| 只映射 `assistant` 消息 | task 结果展示只关心 assistant 输出 |
| 暂不把 tool result 映射成 task message | tool 输出属于步骤信息，不等于最终回答 |
| thinking 是否直出到 task 事件，按开关决定 | 默认允许事件存在，但前端可以先不显示 |

### 8.3 多消息任务

| 情况 | 处理方式 |
|---|---|
| 一个 task 产生多条 assistant 消息 | 多次发 `TaskMessageStarted/Delta/Completed` |
| 一个 task 中间有工具调用 | 不影响 task message 链 |
| 一个 task 失败 | 已经发出的 task message 保留，最后再发 `TaskFailed` |

---

## 九、controlplane 的使用方式

controlplane 的职责收敛成下面这样：

| 输入 | controlplane 动作 |
|---|---|
| `TaskStarted` | 更新任务状态 |
| `TaskMessageStarted` | 开始一条文本消息 |
| `TaskMessageDelta` | 追加文本内容 |
| `TaskMessageCompleted` | 结束文本消息 |
| `TaskCompleted` | 标记任务完成 |
| `TaskFailed` | 标记任务失败 |

这意味着 `TianjiAgent` 可以继续只按 `taskId` 订阅，不需要：

| controlplane 不再需要做的事 |
|---|
| 不需要跟 session 追 run |
| 不需要从 run 事件里找 message |
| 不需要猜哪条 message 属于当前 task |

这正好符合“controlplane 只关心数据”的原则。

---

## 十、兼容性与迁移策略

### 第一阶段

| 策略 | 说明 |
|---|---|
| 保留现有 `Message*` AG-UI 映射代码 | 避免一次删太多 |
| 新增 `TaskMessage*` 映射优先路径 | controlplane 优先消费 task 级消息 |
| 当 task 级消息存在时，不再依赖 run 级消息显示正文 | 逐步完成职责切换 |

### 第二阶段

| 策略 | 说明 |
|---|---|
| controlplane 展示逻辑完全切到 `TaskMessage*` | 彻底去掉 task 视角对 run 消息的依赖 |
| run/message 事件保留给 observability 和低层调试 | 保持架构分层清晰 |

---

## 十一、测试要求

| 层级 | 需要验证什么 |
|---|---|
| shared 单测 | 新增 Task 事件类型与聚合归属正确 |
| node 单测 | `TaskExecutor` 收到 `Message*` 后会发 `TaskMessage*` |
| node 集成测试 | 事件顺序正确：`TaskStarted -> TaskMessage* -> TaskCompleted` |
| controlplane 单测 | `TianjiAgent` 只订 task 事件也能输出 `TEXT_MESSAGE_*` |
| 端到端测试 | 页面在不追 run/session 的情况下显示流式文本 |

---

## 十二、风险与取舍

| 风险 | 说明 | 处理方式 |
|---|---|---|
| 事件重复 | 同一条消息会同时存在 run 级和 task 级两份事件 | 明确职责：run 给观测，task 给展示 |
| thinking 语义膨胀 | task 级也带 thinking，会让前端复杂度上升 | 第一阶段允许事件存在，但 UI 可只消费 text |
| 多消息任务边界不清 | 后续 agent 可能一次 task 产出多条消息 | 保留 `messageId`，不偷懒简化成单消息模型 |

---

## 十三、最终结论

本设计的核心结论只有一句：

**如果 controlplane 不承担核心业务逻辑，那么 daemon 必须把“任务可展示结果”直接建模成 `Task` 聚合事件。**

因此，本设计选择：

| 选择 | 结论 |
|---|---|
| 是否修改 `TaskCompleted` 结构 | 否 |
| 是否让 controlplane 自己推理 run/message | 否 |
| 是否新增 Task 聚合结果事件 | 是 |
| 推荐事件集合 | `TaskMessageStarted` / `TaskMessageDelta` / `TaskMessageCompleted` |

这套设计能把职责边界收正：

| 组件 | 角色 |
|---|---|
| daemon | 执行与业务事实生产者 |
| controlplane | 数据接收、存储、转发、展示器 |
| 前端 | 纯渲染 |
