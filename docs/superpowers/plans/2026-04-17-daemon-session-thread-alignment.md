# Daemon Session Thread Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修正 session/thread 对齐链路中的语义错误，确保 `open` 不再覆盖历史、请求边界校验 session owner，并把 daemon 的 busy 语义改成面向未来 session 级调度的表达。

**Architecture:** 本次改动分三层推进。先在 runtime/agent 层拆开 `create` 与 `open` 语义，并让 `open` 在 session 不存在时直接失败；再在 controlplane 边界持久化并校验 session owner；最后在 daemon 层保留当前全局串行实现，但把错误语义和内部状态命名改成未来“同 session 串行、不同 session 可并发”的方向。

**Tech Stack:** TypeScript, Vitest, Hono, React, Zustand, `@tianji/runtime`, `@tianji/agent`

---

## File Map

- Modify: `packages/runtime/src/runtime/types.ts`
  暴露显式 `openSession` 能力与对应错误语义。
- Modify: `packages/runtime/src/runtime/session-runtime.ts`
  实现 `openSession`，禁止隐式创建，复用已有 snapshot。
- Modify: `packages/runtime/src/runtime/graph-runtime.ts`
  明确当前图运行入口使用 create 还是 open，避免继续依赖混合语义。
- Modify: `packages/runtime/src/__tests__/runtime.test.ts`
  增加 `openSession` 正常路径与不存在时报错测试。
- Modify: `packages/runtime/src/__tests__/suite/multi-turn.test.ts`
  回归验证 open 后不会清空历史。
- Modify: `packages/agent/src/session.ts`
  让 `openAgentSession` 调用 runtime `openSession`，并补 owner metadata 透传入口。
- Modify: `packages/agent/src/__tests__/session.test.ts`
  覆盖 `openAgentSession` 不再重建 session、缺失 session 时报错。
- Modify: `apps/node/src/daemon-entry.ts`
  根据请求语义明确调用 create 或 open，并把 runtime 错误映射到 daemon 协议错误。
- Modify: `apps/node/src/__tests__/daemon-entry.test.ts`
  覆盖 session 不存在和 busy 错误的新语义。
- Modify: `apps/controlplane/src/agents/tianji-agent.ts`
  在创建 task/command 时附带 owner 上下文，保证 node 能做边界校验。
- Modify: `apps/controlplane/src/routes/copilot.ts`
  统一校验 `x-node-id` / `x-agent-id` / `x-session-id`，并为新 session 创建 owner 绑定。
- Modify: `apps/controlplane/src/web/routes/index.tsx`
  前端继续做体验层 session 初始化，但不再承担 correctness 保障。
- Modify: `apps/controlplane/src/web/stores/app-store.ts`
  如有必要，补充与 owner 约束一致的状态操作说明。
- Modify: `apps/controlplane/src/agents/__tests__/tianji-agent.test.ts`
  覆盖 owner 信息透传。
- Modify: `apps/controlplane/src/routes/__tests__/copilot.test.ts`
  覆盖 owner 不匹配时请求被拒绝。
- Modify: `packages/agent/src/daemon-server.ts`
  把 busy 错误文案和内部状态名改成“当前不支持并发 active session”的显式语义。
- Modify: `packages/agent/src/daemon-protocol.ts`
  如协议错误码或错误文案需要更新，在这里同步。
- Modify: `packages/agent/src/__tests__/daemon-client.test.ts`
  覆盖新的 busy 错误语义。
- Modify: `packages/runtime/README.md`
  更新 runtime session 生命周期说明。
- Modify: `README.md`
  如需对 daemon/controlplane session 语义补充说明，在仓库级 README 更新。

### Task 1: 拆开 runtime 的 create/open 语义

**Files:**
- Modify: `packages/runtime/src/runtime/types.ts`
- Modify: `packages/runtime/src/runtime/session-runtime.ts`
- Modify: `packages/runtime/src/runtime/graph-runtime.ts`
- Test: `packages/runtime/src/__tests__/runtime.test.ts`
- Test: `packages/runtime/src/__tests__/suite/multi-turn.test.ts`

- [ ] **Step 1: 写 runtime `openSession` 的失败测试**

```ts
it('throws when openSession targets a missing session', async () => {
  const runtime = createSessionRuntime({
    deepagents: { model: 'openai:gpt-5.1' },
    snapshotStore: new InMemorySnapshotStore(),
    toolCatalog: new ToolRegistry(),
  })

  await expect(runtime.openSession(createSessionId('session-missing'))).rejects.toMatchObject({
    code: 'SESSION_NOT_FOUND',
  })
})

it('openSession returns existing snapshot without resetting messages', async () => {
  const sessionId = createSessionId('session-existing')
  const runtime = createSessionRuntime({
    deepagents: { model: 'openai:gpt-5.1' },
    snapshotStore: new InMemorySnapshotStore(),
    toolCatalog: new ToolRegistry(),
  })

  await runtime.createSession({
    sessionId,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  })

  const opened = await runtime.openSession(sessionId)
  expect(opened.messages).toHaveLength(1)
  expect(opened.messages[0]?.role).toBe('user')
})
```

- [ ] **Step 2: 运行 runtime 定向测试，确认现在失败**

Run: `pnpm --filter @tianji/runtime test -- --run src/__tests__/runtime.test.ts`
Expected: FAIL，报 `openSession is not a function` 或等价断言失败。

- [ ] **Step 3: 在 runtime 类型和实现里增加 `openSession`**

```ts
export interface SessionRuntime {
  createSession(options?: CreateSessionOptions): Promise<SessionSnapshot>
  openSession(sessionId: SessionId): Promise<SessionSnapshot>
}

readonly openSession = async (sessionId: SessionId): Promise<SessionSnapshot> => {
  const snapshot = await this.snapshotStore.loadSession(sessionId)
  if (snapshot === undefined) {
    throw new TianjiError('state', 'SESSION_NOT_FOUND', `Session "${sessionId}" was not found`)
  }
  ensureSessionEngineMatches(snapshot, this.engine)
  return snapshot
}
```

- [ ] **Step 4: 调整 graph runtime，明确继续使用 create 语义**

```ts
const existing = request.sessionId
  ? await deps.sessionRuntime.openSession(request.sessionId).catch(() => undefined)
  : undefined

const session =
  existing ??
  (await deps.sessionRuntime.createSession({
    sessionId: request.sessionId,
  }))
```

说明：图运行入口如果确实需要“有则开、无则建”，必须在调用层显式表达，不允许继续把这种双语义塞进 `openSession`。

- [ ] **Step 5: 写 multi-turn 回归测试，证明 open 后历史仍在**

```ts
it('preserves previous messages when reopening an existing session', async () => {
  const sessionId = createSessionId('session-multi-turn-open')
  const runtime = createSessionRuntime(createRuntimeOptions())

  await runtime.createSession({ sessionId })
  await runtime.runTurn({
    sessionId,
    message: createUserMessage('first turn'),
  })

  const reopened = await runtime.openSession(sessionId)
  expect(reopened.messages.length).toBeGreaterThan(0)
})
```

- [ ] **Step 6: 运行 runtime 测试，确认通过**

Run: `pnpm --filter @tianji/runtime test -- --run src/__tests__/runtime.test.ts src/__tests__/suite/multi-turn.test.ts`
Expected: PASS

### Task 2: 让 agent 层 `openAgentSession` 真正只打开已有 session

**Files:**
- Modify: `packages/agent/src/session.ts`
- Test: `packages/agent/src/__tests__/session.test.ts`

- [ ] **Step 1: 写 agent 层失败测试**

```ts
it('openAgentSession throws when the session snapshot does not exist', async () => {
  await expect(
    openAgentSession(createFakeContext(), { sessionId: 'session-missing' as SessionId })
  ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' })
})

it('openAgentSession does not emit SessionCreated for existing sessions', async () => {
  const emitted: DomainEvent[] = []
  const context = createFakeContext()
  const created = await createAgentSession(context, {
    emitEvent: (event) => {
      emitted.push(event)
    },
  })

  emitted.length = 0

  await openAgentSession(context, { sessionId: created.sessionId }, {
    emitEvent: (event) => {
      emitted.push(event)
    },
  })

  expect(emitted).toEqual([])
})
```

- [ ] **Step 2: 运行 agent 定向测试，确认现在失败**

Run: `pnpm --filter @tianji/agent test -- --run src/__tests__/session.test.ts`
Expected: FAIL，当前 `openAgentSession` 会错误调用 `createSession`。

- [ ] **Step 3: 最小实现修改**

```ts
export async function openAgentSession(
  context: LoadedAgentContext,
  openOptions: OpenAgentSessionOptions,
  runtimeOptions?: AgentRuntimeOptions
): Promise<AgentSession> {
  const { sessionId } = openOptions
  const runtime = await createAgentRuntime(context, runtimeOptions)
  await runtime.openSession(sessionId)
  return createSessionFacade(sessionId, runtime, runtimeOptions)
}
```

- [ ] **Step 4: 运行 agent 测试，确认通过**

Run: `pnpm --filter @tianji/agent test -- --run src/__tests__/session.test.ts`
Expected: PASS

### Task 3: 在 controlplane 边界绑定并校验 session owner

**Files:**
- Modify: `apps/controlplane/src/routes/copilot.ts`
- Modify: `apps/controlplane/src/agents/tianji-agent.ts`
- Modify: `apps/controlplane/src/web/routes/index.tsx`
- Modify: `apps/controlplane/src/web/stores/app-store.ts`
- Test: `apps/controlplane/src/routes/__tests__/copilot.test.ts`
- Test: `apps/controlplane/src/agents/__tests__/tianji-agent.test.ts`

- [ ] **Step 1: 写 owner 校验失败测试**

```ts
it('rejects when x-session-id belongs to a different node-agent owner', async () => {
  const app = createTestApp({
    existingSessionOwner: {
      sessionId: 'session-owned',
      nodeId: 'node-a',
      agentId: 'agent-a',
    },
  })

  const res = await app.request('/api/copilot', {
    method: 'POST',
    headers: {
      'x-node-id': 'node-b',
      'x-agent-id': 'agent-a',
      'x-session-id': 'session-owned',
    },
  })

  expect(res.status).toBe(409)
  await expect(res.json()).resolves.toMatchObject({
    error: 'session owner mismatch',
  })
})
```

- [ ] **Step 2: 写 owner 透传测试**

```ts
it('writes nodeId and agentId into command payload owner fields', async () => {
  await agent.run({
    forwardedProps: { sessionId: 'session-owner' },
    nodeId: 'node-1',
    agentId: 'agent-1',
  })

  expect(insertedCommand.payload).toMatchObject({
    sessionId: 'session-owner',
    owner: { nodeId: 'node-1', agentId: 'agent-1' },
  })
})
```

- [ ] **Step 3: 运行 controlplane 定向测试，确认现在失败**

Run: `pnpm --filter @tianji/controlplane test -- --run src/routes/__tests__/copilot.test.ts src/agents/__tests__/tianji-agent.test.ts`
Expected: FAIL，当前没有 owner 绑定和边界拒绝逻辑。

- [ ] **Step 4: 在边界层保存并校验 owner**

```ts
const owner = { nodeId, agentId }
const existing = sessionRegistry.get(sessionId)

if (existing === undefined) {
  sessionRegistry.set(sessionId, owner)
} else if (existing.nodeId !== nodeId || existing.agentId !== agentId) {
  return c.json({ error: 'session owner mismatch' }, 409)
}
```

说明：这里的 `sessionRegistry` 代表当前 controlplane 已有的 session owner 事实来源。实际实现可以落在当前已有服务或 task/session 映射存储中，但必须是边界层真实状态，而不是前端内存。

- [ ] **Step 5: 保留前端体验层 session 初始化，但删掉“它负责 correctness”的隐含语义**

```tsx
useEffect(() => {
  if (selectedNodeId === null || selectedAgentId === null) return
  if (sessionId !== null) return
  setSessionId(`session_${Date.now()}`)
}, [selectedAgentId, selectedNodeId, sessionId, setSessionId])
```

说明：前端代码可以不大改，但要确保注释、测试和调用边界都表明真正的一致性校验发生在后端请求边界。

- [ ] **Step 6: 运行 controlplane 测试，确认通过**

Run: `pnpm --filter @tianji/controlplane test -- --run src/routes/__tests__/copilot.test.ts src/agents/__tests__/tianji-agent.test.ts src/web/stores/__tests__/app-store.test.ts`
Expected: PASS

### Task 4: 调整 daemon busy 语义并为未来 session 级调度留口子

**Files:**
- Modify: `packages/agent/src/daemon-server.ts`
- Modify: `packages/agent/src/daemon-protocol.ts`
- Modify: `apps/node/src/daemon-entry.ts`
- Test: `packages/agent/src/__tests__/daemon-client.test.ts`
- Test: `apps/node/src/__tests__/daemon-entry.test.ts`

- [ ] **Step 1: 写 daemon busy 语义测试**

```ts
it('returns an explicit active-session concurrency error when another chat is running', async () => {
  const response = await makeSecondChatRequestWhileFirstIsRunning()

  expect(response.events).toContainEqual({
    type: 'chat.error',
    code: 'ACTIVE_SESSION_CONCURRENCY_UNSUPPORTED',
    message: 'The daemon currently supports only one active session at a time',
  })
})
```

- [ ] **Step 2: 运行 daemon/node 定向测试，确认现在失败**

Run: `pnpm --filter @tianji/agent test -- --run src/__tests__/daemon-client.test.ts && pnpm --filter @tianji/node test -- --run src/__tests__/daemon-entry.test.ts`
Expected: FAIL，当前仍返回 `BUSY` 和旧文案。

- [ ] **Step 3: 修改 daemon 错误语义和内部状态命名**

```ts
#activeSessionInProgress: boolean

if (this.#activeSessionInProgress) {
  this.#sendSse(res, DAEMON_SSE_ERROR_NAME, {
    type: 'chat.error',
    code: 'ACTIVE_SESSION_CONCURRENCY_UNSUPPORTED',
    message: 'The daemon currently supports only one active session at a time',
  })
  res.end()
  return
}
```

说明：本次不实现 session 级并发，只把语义改清楚，并把内部命名从永久性的“chat 全局锁”转向“active session 限制”。

- [ ] **Step 4: 在 node 入口把 session 不存在等错误映射清楚**

```ts
if (error.code === 'SESSION_NOT_FOUND') {
  return createChatError('SESSION_NOT_FOUND', error.message)
}
```

- [ ] **Step 5: 运行 daemon/node 测试，确认通过**

Run: `pnpm --filter @tianji/agent test -- --run src/__tests__/daemon-client.test.ts && pnpm --filter @tianji/node test -- --run src/__tests__/daemon-entry.test.ts`
Expected: PASS

### Task 5: 更新文档并做整体验证

**Files:**
- Modify: `packages/runtime/README.md`
- Modify: `README.md`

- [ ] **Step 1: 更新 runtime README 的 session 生命周期说明**

```md
- `createSession` 仅用于新建 session
- `openSession` 仅用于打开已有 session，不存在时直接报错
- 调用方如果需要“有则开、无则建”，必须在应用层显式判断
```

- [ ] **Step 2: 视需要更新仓库 README 的 daemon/controlplane 语义说明**

```md
- `sessionId` 绑定到创建它的 `nodeId + agentId`
- controlplane 在请求边界校验 owner，不允许跨 node/agent 复用 session
- daemon 当前仍只支持一个 active session
```

- [ ] **Step 3: 运行回归测试**

Run: `pnpm --filter @tianji/runtime test -- --run src/__tests__/runtime.test.ts src/__tests__/suite/multi-turn.test.ts`
Expected: PASS

Run: `pnpm --filter @tianji/agent test -- --run src/__tests__/session.test.ts src/__tests__/daemon-client.test.ts`
Expected: PASS

Run: `pnpm --filter @tianji/controlplane test -- --run src/routes/__tests__/copilot.test.ts src/agents/__tests__/tianji-agent.test.ts src/web/stores/__tests__/app-store.test.ts`
Expected: PASS

Run: `pnpm --filter @tianji/node test -- --run src/__tests__/daemon-entry.test.ts`
Expected: PASS

- [ ] **Step 4: 运行仓库级检查**

Run: `pnpm check`
Expected: PASS，无 error、warning、info 残留。

## Self-Review

- Spec coverage:
  - `create/open` 语义拆分：Task 1, Task 2
  - session owner 边界校验：Task 3
  - daemon 当前全局串行但面向 session 级演进：Task 4
  - 文档与验收：Task 5
- Placeholder scan:
  - 已检查，无 `TODO`、`TBD`、`implement later` 等占位词。
- Type consistency:
  - 计划统一使用 `openSession`、`SESSION_NOT_FOUND`、`ACTIVE_SESSION_CONCURRENCY_UNSUPPORTED`、`owner: { nodeId, agentId }` 这些命名；实现时必须保持一致。
