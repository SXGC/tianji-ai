# Daemon Session Thread Alignment Design

## 背景

当前 session/thread 对齐链路里，`sessionId` 同时承担前端 thread 归属、daemon 会话标识和 runtime snapshot key 三种职责。最近改动把 `sessionId` 显式透传到 controlplane、daemon 和 runtime，是正确方向，但也暴露出三个语义问题：

1. `open` 路径会隐式重建 session，导致历史消息被覆盖。
2. session 是否属于当前 `nodeId + agentId` 主要依赖前端状态流维护，没有在请求边界形成硬约束。
3. daemon 仍使用全局单一 chat 锁，接口看起来支持显式 session，但执行模型仍是全局串行。

本设计只修正上述语义边界，不在本次内实现多 session 并发执行。

## 目标

本次改动的目标只有三个：

1. 明确 session 生命周期，彻底拆开 `create` 和 `open` 语义。
2. 明确 session owner 归属，在请求边界拒绝跨 node/agent 复用。
3. 明确 daemon 当前执行模型，同时给未来 session 级并发保留演进空间。

## 非目标

以下内容不属于本次范围：

1. 不实现不同 session 的并发执行。
2. 不支持同一 session 内多个 run 并发。
3. 不做 session 在不同 node 或 agent 之间的迁移能力。
4. 不添加降级兜底或隐式自动修复逻辑。

## 设计原则

### 1. Session 生命周期

系统只保留两种显式动作：

1. `createSession`：创建一个全新的 session，并初始化持久化状态。
2. `openSession`：打开一个已经存在的 session，并恢复其已有状态。

约束如下：

1. `openSession` 不允许隐式创建 session。
2. `openSession` 找不到目标 session 时直接报错。
3. `createSession` 不承担“恢复已有 session”的职责。
4. 任何上层调用方都必须先决定当前请求是“新会话”还是“恢复会话”，再调用对应入口。

这条原则的目的，是避免“打开已有 session”和“重建一个同 ID 空 session”被混成同一个动作，导致历史被覆盖。

### 2. Session Owner

每个 session 都必须绑定 owner 信息，最少包含：

1. `nodeId`
2. `agentId`

owner 信息是 session 元数据的一部分，而不是仅存在于前端内存状态中。

每次 chat/run 请求进入边界时，系统必须校验：

1. 当前请求声明的 `nodeId`
2. 当前请求声明的 `agentId`
3. 被引用 `sessionId` 的 owner 信息

如果三者不一致，直接报错，不允许：

1. 静默复用旧 session
2. 自动迁移 session owner
3. 自动清空并重建同一个 `sessionId`

前端在切换节点或 agent 时仍然可以主动清空 `sessionId`，但这只是体验优化，不承担最终一致性责任。

### 3. Daemon 调度边界

当前版本暂时保留“单 daemon 只允许一个 active chat”的执行限制，但不能继续把这个限制固化为永久架构前提。

本次需要明确两件事：

1. 当前实现仍是全局串行。
2. 内部状态模型应朝“同一 session 串行、不同 session 未来可并发”的方向收敛。

因此，daemon 侧设计要满足：

1. 活跃执行状态以 session 为核心建模，而不是抽象成永久性的全局唯一 chat。
2. 当前若因实现限制拒绝新的 chat 请求，错误语义要明确表达这是“当前 daemon 不支持并发 active session”，而不是模糊地返回一个通用 busy 错误。
3. 本次不实现 session 级并发，但后续若要开放不同 session 并发，不应需要重新定义 session 生命周期和 owner 规则。

## 错误语义

本次需要把以下错误显式区分开：

1. session 不存在
2. session owner 不匹配
3. 当前 daemon 实现暂不支持并发 active session

错误区分的目的，是让调用方能准确判断问题来源，而不是把“传错 session”、“跨节点复用”和“撞上当前调度限制”混成一种失败结果。

## 影响范围

按职责划分，本次设计会影响以下边界：

1. `@tianji/runtime`
   明确 `createSession` / `openSession` 的语义与失败条件。
2. `@tianji/agent`
   明确 `createAgentSession` / `openAgentSession` 的装配职责，不再让 `open` 路径隐式创建 session。
3. daemon API
   明确 session 打开、owner 校验和 busy 错误的外部语义。
4. controlplane / CLI 调用方
   显式决定请求是在创建新会话还是恢复已有会话，不能继续依赖底层猜测意图。

## 验收标准

本次设计完成后，应满足以下行为：

1. 同一个 `sessionId` 的后续请求不会因为 `open` 路径而清空历史。
2. 使用错误的 `nodeId + agentId` 组合复用已有 `sessionId` 时，请求会被边界直接拒绝。
3. daemon 在仍为全局串行实现时，会返回明确的“当前不支持并发 active session”错误。
4. 同一套 session 生命周期和 owner 规则，在未来开放不同 session 并发时仍然成立。
