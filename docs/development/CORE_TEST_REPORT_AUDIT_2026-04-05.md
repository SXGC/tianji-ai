# 核心包测试质量审查报告审计

日期：2026-04-05

## 审计结论

原报告整体可信，主判断基本成立，尤其是 3 个 Critical 和大部分 Important 都能从现有测试代码直接验证出来。

但原报告也有两个需要校正的点：

1. 个别措辞偏重，把“测试价值很低”写成了“零价值”或“纯实现快照”，方向对，但表述强度略夸张。
2. 有些条目本质是“覆盖缺口”或“脆弱性风险”，不应一律按同类缺陷理解，后续整改时要区分必修项和可后移项。

综合判断：这不是一份失真的报告，而是一份“事实基本准确、个别表述偏重”的报告，可以作为后续整改依据。

## 已核实属实的问题

### 1. `packages/runtime/src/__tests__/snapshot-store.test.ts`

现状只覆盖了：

- `InMemorySnapshotStore.saveSession/loadSession`
- `FileSnapshotStore.saveRun/loadRun/listRuns` 的单条正向路径

原报告指出的缺口大部分属实：

- `InMemorySnapshotStore` 缺少 `saveRun/loadRun/listRuns`
- 缺少不存在 ID 的返回值约束
- 缺少覆盖写入测试
- 缺少 clone 隔离测试
- `FileSnapshotStore` 缺少 session 相关测试
- 缺少损坏 JSON 场景
- 缺少并发写入场景

结论：该条成立，且优先级高。

### 2. `packages/agent/src/__tests__/acp-entry.test.ts`

现有测试对 `context`、`session`、ACP SDK 全量 mock，最终只验证 mock 是否被调用。

它只能证明入口装配链条发生了调用，几乎不验证 `runAcpAgent` 的业务行为。

结论：原报告主判断成立。

### 3. `packages/runtime/src/__tests__/suite/error-recovery.test.ts:62-103`

“run 失败后同 session 可发起新 runTurn” 这条测试确实使用了两个独立 runtime 实例，只共享 `snapshotStore`。

因此它验证的是“共享快照存储后可恢复”，而不是“同一 runtime 的恢复语义”。

结论：原报告成立。

### 4. `packages/observer/src/tracing/__tests__/tracing-spans.test.ts`

多个测试标题写着“includes attributes”或“correct attributes”，但断言内容基本只有：

- `toBeDefined()`
- `span` 存在
- `end()` 可调用

没有实际校验 attribute 内容。

结论：原报告成立，这是典型的标题和断言不一致问题。

### 5. `packages/runtime/src/__tests__/tool-catalog.test.ts`

当前仅覆盖：

- 工具注册与执行正向路径
- 重名工具拒绝
- destructive 工具被策略阻止

未覆盖：

- 不存在工具
- `ensureToolAllowed` 正向路径
- 更完整的策略矩阵
- `createCatalog` 的更多使用路径

结论：原报告成立。

### 6. `packages/runtime/src/__tests__/runtime-deepagents-bootstrap.test.ts`

文件中存在 `try/catch` 断言错误对象，但没有 `expect.assertions(...)`。

如果未来实现不再抛错，`catch` 分支不会执行，测试可能误通过。

结论：原报告成立。

### 7. `packages/runtime/src/__tests__/runtime-engine-selection.test.ts`

同样存在多处 `try/catch` 无 `expect.assertions(...)` 的写法。

结论：原报告成立。

### 8. `packages/shared/src/__tests__/identifiers.test.ts:158-176`

标题声称验证 branded type 的编译期隔离，但实现方式是 `as unknown as` 强转后再断言运行时字符串相等。

这与测试标题表达的目标相矛盾。

结论：原报告成立。

### 9. `packages/agent/src/__tests__/session.test.ts:59-79`

通过强转 `SessionRuntime & { options?: ... }` 去读取内部 `options`，属于穿透封装、窥探内部实现。

结论：原报告成立。

### 10. `packages/runtime/src/__tests__/runtime.test.ts:313-339`

同样通过强转去检查 runtime 内部结构，而不是通过公开行为断言。

结论：原报告成立。

### 11. `packages/runtime/src/__tests__/index.test.ts:143-167`

测试硬编码整个依赖列表并断言完全相等。任何合法依赖增减都会导致失败。

这类测试对重构和正常依赖调整过于敏感。

结论：原报告成立。

### 12. `packages/runtime/src/__tests__/runtime-public-api.test.ts:96-108`

测试通过直接读取源码并做字符串搜索，验证某些结构不存在。

这种方式容易被注释、命名调整或实现重构触发误报。

结论：原报告成立，但应把“源码字符串检查”与“README 契约检查”分开看待。

### 13. `packages/runtime/src/__tests__/llm-gateway-providers.test.ts`

目前主要验证返回对象类型和 provider info，没有验证 `apiKey`、`baseUrl`、`headers` 是否真正透传给 SDK factory。

结论：原报告成立。

### 14. `packages/runtime/src/__tests__/llm-sdk-gateway.test.ts`

`generate` 成功路径主要验证返回值映射，没有验证 `systemPrompt`、配置和工具参数是否透传给 `generateText/streamText`。

结论：原报告成立。

### 15. `packages/shared/src/__tests__/delta-aggregator.test.ts`

当前覆盖集中在常规文本聚合流程。原报告指出的以下边界没有看到：

- 非字符串 payload 的归一化错误路径
- `channel/part` 不匹配的错误路径

结论：原报告成立。

### 16. `packages/shared/src/__tests__/config.test.ts`

配置测试较多，但原报告指出的这些缺口未见覆盖：

- `getAgentSoulPath` 无效名称抛错
- 三层及以上配置合并

结论：原报告成立。

### 17. `packages/shared/src/__tests__/utils.test.ts`

`deepClone` 已覆盖大量正常路径，但未覆盖循环引用抛错场景。

若源码注释已明确声明该行为，则这是有效缺口。

结论：原报告成立。

### 18. `packages/runtime/src/__tests__/runtime-lifecycle.test.ts`

当前只测“有活跃 run 时关闭 session”的主路径。原报告指出的以下边界未覆盖：

- 无活跃运行时关闭
- 不存在 `sessionId`
- 重复关闭

结论：原报告成立。

## 判断正确但措辞偏重的条目

### 1. `shared` 下类型见证测试泛滥

涉及文件：

- `packages/shared/src/__tests__/artifact.test.ts`
- `packages/shared/src/__tests__/delta.test.ts`
- `packages/shared/src/__tests__/message.test.ts`
- `packages/shared/src/__tests__/tool.test.ts`

这些测试大多是在用运行时断言给 TypeScript 类型做“见证”，与 TS 编译器职责明显重叠，业务收益较低，这个判断是对的。

但“零运行时价值”表述过重。更准确的说法应是：

- 运行时收益很低
- 与类型系统职责重叠明显
- 维护成本高
- 适合改成 `expectTypeOf` 或直接删除冗余案例

### 2. `acp-entry.test.ts` 被定性为“零业务逻辑验证”

该文件确实没有验证核心业务结果，但仍然验证了入口是否串起：

- `loadAgentContext`
- `ndJsonStream`
- `AgentSideConnection`
- 等待 `closed`

因此更准确的表述应为：

- 主要验证装配，不验证核心行为
- 业务价值偏低
- 容易演变为实现绑定测试

## 建议降级理解的条目

### 1. `snapshot-store.test.ts` 的并发写入测试

这是合理建议，但是否应与 CRUD 覆盖缺失同列为最高优先级，需要看实现是否明确承诺并发安全。

如果 `FileSnapshotStore` 只是本地轻量持久化层，没有承诺跨进程或并发原子语义，那么该项更适合作为 Important，而不是和基础读写行为同级。

### 2. `runtime-public-api.test.ts` 的 README 断言

需要拆分看待：

- 读取源码做字符串搜索：脆弱，问题成立
- 断言 README 仍包含公开迁移说明：未必错误，属于文档契约测试的一种

因此不应把整条测试一概视为无效。

## 报告遗漏的根因视角

除了逐条缺口外，现有测试还有几个更底层的共性问题，原报告点到了部分现象，但没有明确总结根因：

1. 许多测试边界选错了。
   - 用 mock 验证装配，未验证可观察业务行为
   - 用内部结构断言，替代公开 API 断言
   - 用源码字符串搜索，替代契约级验证

2. 有些问题不是“没写测试”，而是“标题描述的行为”和“断言实际验证的内容”不一致。
   - `tracing-spans.test.ts` 是最明显例子

3. 类型见证测试过多，导致维护成本上升，但对真实回归的防护能力有限。

## 建议的整改优先级

相较原报告最后给出的顺序，建议调整为：

1. `snapshot-store.test.ts`
2. `tracing-spans.test.ts`
3. `error-recovery.test.ts`
4. `tool-catalog.test.ts`
5. 批量修复 `try/catch` 反模式
6. 清理 `shared` 下类型见证测试

调整理由：

- 前四项直接影响测试是否真的在验证业务行为
- `try/catch` 反模式修复成本低，可批量处理
- 类型见证测试虽然冗余，但短期内不是最容易放出行为回归的风险点

## 最终判断

可以把原报告作为后续整改依据，可信度高。

更精确的结论如下：

1. 3 个 Critical 中，前 2 个完全成立，第 3 个也成立。
2. Important 中，大多数条目成立。
3. 最需要修正的是措辞和优先级边界，而不是事实本身。
4. 这份报告的整体质量是可接受的，适合继续加工为可执行整改清单。
