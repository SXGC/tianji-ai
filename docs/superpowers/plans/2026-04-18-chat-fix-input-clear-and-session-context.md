# Chat Fix: Input Clear & Session Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复两个聊天面板问题：发送后输入框不清空、每次对话不带历史上下文。

**Architecture:**
- Fix 1：把 `layout.tsx` 里 `setValue('')` 的时机从 await 之后挪到 await 之前，让输入框在点击发送时立即清空，而不是等 AI 响应完成。
- Fix 2：在 `@tianji/agent` 新增 `ensureAgentSession`，封装"有则复用、无则新建"语义；在 `controlplane-runtime` 的 `run()` 中用它替换始终新建的 `createAgentSession`，让同一 session 的多轮对话共享历史。

**Tech Stack:** TypeScript, Vitest, CopilotKit (React), @tianji/agent, @tianji/runtime

---

### Task 1: 修复输入框清空时机

**Files:**
- Modify: `apps/controlplane/src/web/components/layout.tsx:42-47`

- [ ] **Step 1: 写失败测试**

  在 `apps/controlplane/src/web/components/__tests__/layout.test.tsx` 中（如不存在则创建）。

  > 注意：CopilotKit 的 `ChatInput` 是内部组件，直接渲染 `ChatInput` 即可，无需 CopilotKit Provider。

  ```typescript
  import { render, screen } from '@testing-library/react'
  import userEvent from '@testing-library/user-event'
  import { describe, expect, it, vi } from 'vitest'

  // 直接引入组件模块，绕过 CopilotKit 依赖
  // ChatInput 在 layout.tsx 里是 function ChatInput，需要从文件内 export 或提取出来才能单独测试。
  // 如果 ChatInput 未导出，本 Task 的测试放到集成层验证，改为手动核查（见 Step 4）。
  ```

  实际上 `ChatInput` 是文件内局部函数，不对外导出。**本 Task 改用手动核查（Step 4）取代单元测试。**

- [ ] **Step 2: 修改 layout.tsx**

  将 `apps/controlplane/src/web/components/layout.tsx:42-47` 改为：

  ```typescript
  const submit = async () => {
    const nextValue = value.trim()
    if (nextValue.length === 0 || inProgress) return
    setValue('')           // 立即清空，不等 AI 响应
    await onSend(nextValue)
  }
  ```

- [ ] **Step 3: 运行类型检查**

  从仓库根目录：
  ```bash
  pnpm check
  ```
  预期：无错误、无警告。

- [ ] **Step 4: 手动核查**

  启动开发环境后，在聊天框输入内容点击发送，确认输入框在发送瞬间清空（不等 AI 回复）。

  > 当前环境禁止运行 `pnpm dev`，验收由 code review 阶段人工确认。

- [ ] **Step 5: Commit**

  加载 git-commit skill 后提交：
  ```
  fix(controlplane): 发送消息后立即清空输入框
  ```

---

### Task 2: 新增 `ensureAgentSession` 并导出

**Files:**
- Modify: `packages/agent/src/session.ts`（在 `openAgentSession` 后追加函数，约第 229 行）
- Modify: `packages/agent/src/index.ts`（在 export 块追加 `ensureAgentSession`）
- Modify: `packages/agent/src/__tests__/session.test.ts`（追加两个测试用例）

- [ ] **Step 1: 写失败测试**

  在 `packages/agent/src/__tests__/session.test.ts` 末尾（`buildSingleNodeGraph` 函数之前），追加：

  ```typescript
  import { createAgentRuntime, createAgentSession, ensureAgentSession, openAgentSession } from '../session.js'

  // 在文件顶部 import 行修改（替换原有 import）：
  // import { createAgentRuntime, createAgentSession, openAgentSession } from '../session.js'
  // 改为：
  // import { createAgentRuntime, createAgentSession, ensureAgentSession, openAgentSession } from '../session.js'
  ```

  在 `describe('session')` 块内追加：

  ```typescript
  it('ensureAgentSession opens existing session when snapshot exists', async () => {
    const runtime = createStubRuntime()
    const createSessionRuntimeSpy = vi
      .spyOn(runtimeModule, 'createSessionRuntime')
      .mockReturnValue(runtime)
    const emitEvent = vi.fn()

    const session = await ensureAgentSession(
      createFakeContext(),
      'session_existing' as never,
      { emitEvent }
    )

    expect(runtime.openSession).toHaveBeenCalledWith('session_existing')
    expect(runtime.createSession).not.toHaveBeenCalled()
    expect(session.sessionId).toBe('session_existing')
    expect(emitEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SessionCreated' })
    )

    createSessionRuntimeSpy.mockRestore()
  })

  it('ensureAgentSession creates session with given sessionId when snapshot is missing', async () => {
    const runtime = createStubRuntime()
    vi.mocked(runtime.openSession).mockRejectedValueOnce(
      Object.assign(new Error('missing session'), { code: 'SESSION_NOT_FOUND' })
    )
    const createSessionRuntimeSpy = vi
      .spyOn(runtimeModule, 'createSessionRuntime')
      .mockReturnValue(runtime)
    const emitEvent = vi.fn()

    const session = await ensureAgentSession(
      createFakeContext(),
      'session_new' as never,
      { emitEvent }
    )

    expect(runtime.openSession).toHaveBeenCalledWith('session_new')
    expect(runtime.createSession).toHaveBeenCalledWith({ sessionId: 'session_new' })
    expect(session.sessionId).toBe('session_new')
    expect(emitEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SessionCreated', sessionId: 'session_new' })
    )

    createSessionRuntimeSpy.mockRestore()
  })
  ```

- [ ] **Step 2: 运行测试确认失败**

  从 `packages/agent` 目录：
  ```bash
  cd /workspaces/dev_docker/tianji-ai/packages/agent && pnpm test --reporter=verbose 2>&1 | tail -30
  ```
  预期：两个新测试报 `ensureAgentSession is not a function`（或类似导出错误）。

- [ ] **Step 3: 实现 `ensureAgentSession`**

  在 `packages/agent/src/session.ts` 的 `openAgentSession` 函数（约第 219 行）之后，`resumeAgentSession` 之前，插入：

  ```typescript
  /**
   * 确保会话存在：snapshot 存在则 open（保留历史），不存在则用指定 sessionId 新建。
   *
   * 封装"有则复用、无则新建"语义，供 controlplane 运行时在多轮对话中使用。
   *
   * @param context       - 已加载的 agent bootstrap 上下文
   * @param sessionId     - 要复用或新建的 session ID（由 controlplane 分配）
   * @param options       - 运行时选项（logger、emitEvent）
   * @returns 复用或新建后的 AgentSession 实例
   */
  export async function ensureAgentSession(
    context: LoadedAgentContext,
    sessionId: SessionId,
    options?: AgentRuntimeOptions
  ): Promise<AgentSession> {
    const runtime = await createAgentRuntime(context, options)
    let isNewSession = false
    await runtime.openSession(sessionId).catch(async () => {
      isNewSession = true
      await runtime.createSession({ sessionId })
    })
    if (isNewSession) {
      await options?.emitEvent?.({
        type: 'SessionCreated',
        sessionId,
        timestamp: Date.now(),
      })
    }
    return createSessionFacade(sessionId, runtime, options)
  }
  ```

- [ ] **Step 4: 导出 `ensureAgentSession`**

  在 `packages/agent/src/index.ts` 的 session export 块（第 28-37 行）里追加 `ensureAgentSession`：

  ```typescript
  export {
    createAgentRuntime,
    createAgentSession,
    ensureAgentSession,
    openAgentSession,
    resumeAgentSession,
    type AgentRuntimeOptions,
    type AgentSession,
    type OpenAgentSessionOptions,
    type ResumeAgentSessionOptions,
  } from './session.js'
  ```

- [ ] **Step 5: 运行测试确认通过**

  ```bash
  cd /workspaces/dev_docker/tianji-ai/packages/agent && pnpm test --reporter=verbose 2>&1 | tail -30
  ```
  预期：两个新测试 PASS。

- [ ] **Step 6: 运行类型检查**

  ```bash
  pnpm check
  ```
  预期：无错误。

- [ ] **Step 7: Commit**

  加载 git-commit skill 后提交：
  ```
  feat(agent): 新增 ensureAgentSession，有则复用、无则新建
  ```

---

### Task 3: 在 `controlplane-runtime` 中使用 `ensureAgentSession`

**Files:**
- Modify: `apps/node/src/node-runtime/controlplane-runtime.ts:132-145`（`run` 方法内的 session 创建逻辑）
- Modify: `apps/node/src/node-runtime/__tests__/controlplane-runtime.test.ts`（新增测试用例）

- [ ] **Step 1: 写失败测试**

  在 `apps/node/src/node-runtime/__tests__/controlplane-runtime.test.ts` 里，在现有 `it` 块之后追加新的 `describe` 块：

  ```typescript
  import * as agentModule from '@tianji/agent'

  describe('createControlPlaneUnifiedEntry session handling', () => {
    const baseConfig = {
      baseUrl: 'http://localhost:3000',
      nodeId: createNodeId('node-001'),
      enrollmentToken: 'token',
      hostname: 'host',
      platform: 'linux',
      version: '0.0.1',
      agentList: [],
      agentConfigs: { default: { agentName: 'default' } as never },
      emitTaskEvent: vi.fn(),
      enterCorrelation: async (_id: string, fn: () => Promise<void>) => fn(),
      nativeAgentContext: {} as never,
      defaultGraph: {} as never,
      executorFactory: {} as never,
      observerLogger: undefined,
    }

    it('uses ensureAgentSession when sessionIds is provided', async () => {
      const ensureAgentSessionSpy = vi
        .spyOn(agentModule, 'ensureAgentSession')
        .mockResolvedValue({
          sessionId: 'session_test' as never,
          queryWithGraph: vi.fn(async function* () {}),
          abort: vi.fn(),
          close: vi.fn(),
        } as never)
      vi.spyOn(agentModule, 'buildDefaultGraph').mockResolvedValue({
        graph: {} as never,
        executorFactory: {} as never,
      })

      const command = {
        commandId: 'cmd-001' as never,
        nodeId: createNodeId('node-001'),
        type: 'task.run' as const,
        state: 'pending' as const,
        createdAt: Date.now(),
        payload: {
          taskId: createTaskId('task-001'),
          agentId: 'default',
          goal: 'hello',
          sessionIds: ['session_existing' as never],
        },
      }

      const runtime = createControlPlaneRuntime(baseConfig, {
        createConnection: () => ({
          start: vi.fn(async () => undefined),
          stop: vi.fn(),
          setExecutionState: vi.fn(),
        }),
      })

      await runtime.onCommand(command)

      expect(ensureAgentSessionSpy).toHaveBeenCalledWith(
        baseConfig.nativeAgentContext,
        'session_existing',
        expect.anything()
      )

      ensureAgentSessionSpy.mockRestore()
    })

    it('uses createAgentSession when sessionIds is absent', async () => {
      const createAgentSessionSpy = vi
        .spyOn(agentModule, 'createAgentSession')
        .mockResolvedValue({
          sessionId: 'session_new' as never,
          queryWithGraph: vi.fn(async function* () {}),
          abort: vi.fn(),
          close: vi.fn(),
        } as never)
      vi.spyOn(agentModule, 'buildDefaultGraph').mockResolvedValue({
        graph: {} as never,
        executorFactory: {} as never,
      })

      const command = {
        commandId: 'cmd-002' as never,
        nodeId: createNodeId('node-001'),
        type: 'task.run' as const,
        state: 'pending' as const,
        createdAt: Date.now(),
        payload: {
          taskId: createTaskId('task-002'),
          agentId: 'default',
          goal: 'hello without session',
        },
      }

      const runtime = createControlPlaneRuntime(baseConfig, {
        createConnection: () => ({
          start: vi.fn(async () => undefined),
          stop: vi.fn(),
          setExecutionState: vi.fn(),
        }),
      })

      await runtime.onCommand(command)

      expect(createAgentSessionSpy).toHaveBeenCalled()

      createAgentSessionSpy.mockRestore()
    })
  })
  ```

- [ ] **Step 2: 运行测试确认失败**

  ```bash
  cd /workspaces/dev_docker/tianji-ai/apps/node && pnpm test --reporter=verbose 2>&1 | tail -30
  ```
  预期：新测试失败（`ensureAgentSession` 未被调用，或者 `createAgentSession` 被错误地调用）。

- [ ] **Step 3: 修改 `controlplane-runtime.ts`**

  将 `apps/node/src/node-runtime/controlplane-runtime.ts:132-145` 的 `run` 方法修改为：

  ```typescript
  return {
    run: async (request) => {
      const existingSessionId = command.payload.sessionIds?.[0]
      const session =
        existingSessionId !== undefined
          ? await sessionModule.ensureAgentSession(
              nativeAgentContext,
              existingSessionId,
              runtimeOptions
            )
          : await sessionModule.createAgentSession(nativeAgentContext, runtimeOptions)

      config.emitTaskEvent({
        type: 'TaskSessionAttached',
        taskId: String(command.payload.taskId),
        sessionId: session.sessionId,
        timestamp: Date.now(),
      })

      const events = session.queryWithGraph(built.graph, {
        initialState: { input: request.input },
        compileOptions: { agentExecutorFactory: built.executorFactory },
      })
      // ... 后续代码不变
  ```

  完整替换的块（旧代码第 132-145 行 → 新代码）：

  旧：
  ```typescript
  return {
    run: async (request) => {
      const session = await sessionModule.createAgentSession(nativeAgentContext, runtimeOptions)
      config.emitTaskEvent({
  ```

  新：
  ```typescript
  return {
    run: async (request) => {
      const existingSessionId = command.payload.sessionIds?.[0]
      const session =
        existingSessionId !== undefined
          ? await sessionModule.ensureAgentSession(
              nativeAgentContext,
              existingSessionId,
              runtimeOptions
            )
          : await sessionModule.createAgentSession(nativeAgentContext, runtimeOptions)
      config.emitTaskEvent({
  ```

- [ ] **Step 4: 运行测试确认通过**

  ```bash
  cd /workspaces/dev_docker/tianji-ai/apps/node && pnpm test --reporter=verbose 2>&1 | tail -30
  ```
  预期：所有测试 PASS。

- [ ] **Step 5: 运行类型检查**

  ```bash
  pnpm check
  ```
  预期：无错误。

- [ ] **Step 6: Commit**

  加载 git-commit skill 后提交：
  ```
  fix(node): controlplane-runtime 复用已有 session，修复多轮对话无上下文
  ```

---

## Self-Review

**Spec coverage:**
- [x] 发送后输入框清空 → Task 1
- [x] 多轮对话携带历史上下文 → Task 2 + Task 3

**Placeholder scan:**
- 所有代码步骤均含完整代码块，无 TBD/TODO。

**Type consistency:**
- `ensureAgentSession(context, sessionId, options?)` 签名在 Task 2 Step 3 定义，Task 3 Step 3 调用时参数完全对齐。
- `session.sessionId` 返回值在所有 mock 中统一为 `'session_*' as never`，与 `SessionId` branded type 兼容。
