import type { SessionRuntime } from '@tianji/runtime'
import * as runtimeModule from '@tianji/runtime'
import { FileSnapshotStore } from '@tianji/runtime'
import type { ObserverLogger } from '@tianji/runtime'
import type { GraphRunDomainEvent } from '@tianji/shared'
import { describe, expect, it, vi } from 'vitest'

import type { LoadedAgentContext } from '../context.js'
import type {
  AgentExecutorFactory,
  NodeAction,
  NodeExecutorContext,
  OrchestrationGraph,
} from '../orchestration/index.js'
import { createAgentRuntime, createAgentSession } from '../session.js'

vi.mock('@tianji/runtime', async () => {
  const actual = await vi.importActual<typeof import('@tianji/runtime')>('@tianji/runtime')

  return {
    ...actual,
    createSessionRuntime: vi.fn(actual.createSessionRuntime),
  }
})

/**
 * 构造一个最小可用的 SessionRuntime stub：
 * queryWithGraph 的 session 外壳会调用 createAgentRuntime，
 * 这里返回的 stub 只需满足方法签名即可。
 */
function createStubRuntime(): SessionRuntime {
  return {
    createSession: vi.fn(async (options) => ({
      sessionId: options?.sessionId ?? ('session_test' as never),
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    })),
    closeSession: vi.fn(async () => ({
      sessionId: 'session_test' as never,
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    })),
    getSessionSnapshot: vi.fn(async () => undefined),
    getRunSnapshot: vi.fn(async () => undefined),
    runTurn: vi.fn(async () => 'run_test' as never),
    resumeRun: vi.fn(async () => 'run_test' as never),
    streamEvents: vi.fn(async function* () {}),
    cancelRun: vi.fn(() => false),
  }
}

function createFakeContext(): LoadedAgentContext {
  return {
    paths: {
      configDir: '/tmp/tianji-test/config',
      agentsDir: '/tmp/tianji-test/config/agents',
      logsDir: '/tmp/tianji-test/config/logs',
      configFilePath: '/tmp/tianji-test/config/tianji.json',
      cliLogFilePath: '/tmp/tianji-test/config/logs/tianji.log',
      daemonPortPath: '/tmp/tianji-test/config/daemon.port',
      daemonPidPath: '/tmp/tianji-test/config/daemon.pid',
    },
    config: {},
    agent: {
      agentName: 'default',
      modelRef: 'openai/gpt-4.1',
      provider: 'openai',
      modelName: 'gpt-4.1',
      providerConfig: {
        apiKey: 'test-key',
        baseUrl: 'http://example.test/v1',
        headers: {
          'x-test-header': 'enabled',
        },
      },
      soulPath: '/tmp/tianji-test/config/agents/default/SOUL.md',
      soul: '# Test Agent\n\nYou are a test agent.\n',
      workspace: undefined,
    },
    resolvedEnvVars: [],
    snapshotStore: new FileSnapshotStore('/tmp/tianji-test/runtime-snapshots'),
  }
}

describe('agent session', () => {
  it('creates runtime from loaded agent context', async () => {
    const runtime = await createAgentRuntime(createFakeContext())

    expect(runtime.createSession).toBeDefined()
    expect(runtime.runTurn).toBeDefined()
  })

  it('registers fetch_url tool in the runtime tool catalog', async () => {
    const createSessionRuntimeSpy = vi.spyOn(runtimeModule, 'createSessionRuntime')

    await createAgentRuntime(createFakeContext())

    const callArgs = createSessionRuntimeSpy.mock.calls.at(-1)?.[0]
    expect(callArgs?.toolCatalog).toBeDefined()
    expect(callArgs?.toolCatalog?.hasTool('fetch_url')).toBe(true)

    createSessionRuntimeSpy.mockRestore()
  })

  it('normalizes openai runtime model into a configured model instance', async () => {
    const runtime = (await createAgentRuntime(createFakeContext())) as SessionRuntime & {
      readonly options?: {
        readonly deepagents?: {
          readonly model?: {
            readonly model?: string
          }
          readonly providerConfig?: Record<string, unknown>
        }
      }
    }

    expect(runtime.options?.deepagents?.model?.model).toBe('gpt-4.1')
    expect(runtime.options?.deepagents?.providerConfig).toEqual({
      provider: 'openai',
      model: 'gpt-4.1',
      apiKey: 'test-key',
      baseUrl: 'http://example.test/v1',
      headers: {
        'x-test-header': 'enabled',
      },
    })
  })
})

/**
 * 构造一个最小可用的单节点 OrchestrationGraph：
 * START → worker → END，worker 是一个 agent 节点，执行细节由测试注入的工厂决定。
 */
function buildSingleNodeGraph(): OrchestrationGraph {
  return {
    id: 'test-graph',
    name: 'single-node',
    version: 1,
    source: 'static',
    locked: false,
    state: {
      result: { type: 'string' },
    },
    nodes: [
      {
        id: 'worker',
        type: 'agent',
        agent: { model: 'stub', systemPrompt: 'stub prompt' },
        output: ['result'],
      },
    ],
    edges: [
      { from: '__start__', to: 'worker' },
      { from: 'worker', to: '__end__' },
    ],
  }
}

describe('agent session queryWithGraph', () => {
  /**
   * 准备一个已经 mock 过 createSessionRuntime 的 session 实例。
   * queryWithGraph 不会真正用到 runtime 的方法（执行链路通过 AgentExecutorFactory 绕开 runtime），
   * 只需要 createAgentRuntime 能顺利返回一个形状正确的 SessionRuntime 即可。
   */
  async function prepareSession() {
    const runtime = createStubRuntime()
    const createSessionRuntimeSpy = vi
      .spyOn(runtimeModule, 'createSessionRuntime')
      .mockReturnValue(runtime)
    const session = await createAgentSession(createFakeContext())
    return { session, runtime, createSessionRuntimeSpy }
  }

  function createLoggerSpy(): ObserverLogger {
    return {
      log: vi.fn(async () => undefined),
      trace: vi.fn(async () => undefined),
      debug: vi.fn(async () => undefined),
      info: vi.fn(async () => undefined),
      warn: vi.fn(async () => undefined),
      error: vi.fn(async () => undefined),
      fatal: vi.fn(async () => undefined),
      child: vi.fn(function (this: ObserverLogger) {
        return this
      }),
    }
  }

  it('正常路径：转发 graph.started / 节点事件 / graph.completed', async () => {
    const { session, createSessionRuntimeSpy } = await prepareSession()

    // 事件发射型 stub 工厂：模拟真实 executor 广播 started/completed 节点事件
    const happyPathFactory: AgentExecutorFactory =
      (node, ctx: NodeExecutorContext): NodeAction =>
      async () => {
        ctx.emitGraphEvent({
          type: 'GraphNodeStarted',
          runId: ctx.runId,
          graphId: ctx.graphId,
          nodeId: node.id,
          nodeKind: 'agent',
          timestamp: Date.now(),
        })
        const output = { result: `ran-${node.id}` }
        ctx.emitGraphEvent({
          type: 'GraphNodeCompleted',
          runId: ctx.runId,
          graphId: ctx.graphId,
          nodeId: node.id,
          nodeKind: 'agent',
          output,
          timestamp: Date.now(),
        })
        return output
      }

    const events: GraphRunDomainEvent[] = []
    for await (const event of session.queryWithGraph(buildSingleNodeGraph(), {
      compileOptions: { agentExecutorFactory: happyPathFactory },
    })) {
      events.push(event as GraphRunDomainEvent)
    }

    const eventTypes = events.map((event) => event.type)
    // GraphRunStarted 来自 graph-runner；GraphNode* 来自 stub 工厂；GraphRunCompleted 来自 graph-runner
    expect(eventTypes).toEqual([
      'GraphRunStarted',
      'GraphNodeStarted',
      'GraphNodeCompleted',
      'GraphRunCompleted',
    ])

    const completed = events.find((event) => event.type === 'GraphRunCompleted')
    expect(completed).toBeDefined()
    // 最终状态里 stub 工厂写入的 result 字段应该被保留
    expect((completed as { finalState: Record<string, unknown> }).finalState.result).toBe(
      'ran-worker'
    )

    createSessionRuntimeSpy.mockRestore()
  })

  it('会把 orchestration mermaid 写入 logger', async () => {
    const runtime = createStubRuntime()
    const createSessionRuntimeSpy = vi
      .spyOn(runtimeModule, 'createSessionRuntime')
      .mockReturnValue(runtime)
    const logger = createLoggerSpy()
    const session = await createAgentSession(createFakeContext(), { logger })

    const happyPathFactory: AgentExecutorFactory = () => async () => ({ result: 'ran-worker' })

    for await (const _event of session.queryWithGraph(buildSingleNodeGraph(), {
      compileOptions: { agentExecutorFactory: happyPathFactory },
    })) {
      // 消费完整事件流，等待执行结束
    }

    expect(logger.info).toHaveBeenCalledWith(
      ['agent', 'orchestration'],
      'graph.mermaid',
      expect.objectContaining({
        sessionId: expect.stringMatching(/^session_/),
        runId: expect.stringMatching(/^run_graph_/),
        graphId: 'test-graph',
        graphVersion: 1,
        diagram: expect.stringContaining('flowchart TD'),
      })
    )

    createSessionRuntimeSpy.mockRestore()
  })

  it('错误路径：节点执行抛错时 for-await 消费完事件后 finished reject 向上抛出', async () => {
    const { session, createSessionRuntimeSpy } = await prepareSession()

    const throwingFactory: AgentExecutorFactory = () => async () => {
      throw new Error('intentional test failure')
    }

    const collectAll = async (): Promise<GraphRunDomainEvent[]> => {
      const events: GraphRunDomainEvent[] = []
      for await (const event of session.queryWithGraph(buildSingleNodeGraph(), {
        compileOptions: { agentExecutorFactory: throwingFactory },
      })) {
        events.push(event as GraphRunDomainEvent)
      }
      return events
    }

    // LangGraph 把内部异常再抛到 invoke；graph-runner 的 finished 会 reject，
    // 从而让 session 里的 `await result.finished` 在 async generator 中透传为 throw。
    await expect(collectAll()).rejects.toThrow(/intentional test failure/)

    createSessionRuntimeSpy.mockRestore()
  })

  it('消费者提前 break 不会产生悬挂的 unhandled rejection', async () => {
    const { session, createSessionRuntimeSpy } = await prepareSession()

    // stub 工厂同步发射 started 事件后 await 一个永不 resolve 的 promise，
    // 让 break 时节点 action 仍在挂起，验证 finally 能正确释放 controller。
    const slowFactory: AgentExecutorFactory =
      (node, ctx: NodeExecutorContext): NodeAction =>
      async () => {
        ctx.emitGraphEvent({
          type: 'GraphNodeStarted',
          runId: ctx.runId,
          graphId: ctx.graphId,
          nodeId: node.id,
          nodeKind: 'agent',
          timestamp: Date.now(),
        })
        // 永远挂起；测试会通过 break 结束 for-await
        return new Promise(() => undefined)
      }

    const events: GraphRunDomainEvent[] = []
    for await (const event of session.queryWithGraph(buildSingleNodeGraph(), {
      compileOptions: { agentExecutorFactory: slowFactory },
    })) {
      events.push(event as GraphRunDomainEvent)
      // 收到 GraphRunStarted 后立刻 break，模拟消费者提前退出
      if (event.type === 'GraphRunStarted') {
        break
      }
    }

    // 至少收到 GraphRunStarted；break 后 session 内的 finally 应当清理 controller
    expect(events.length).toBeGreaterThan(0)
    expect(events[0]?.type).toBe('GraphRunStarted')
    // 再次调用 abort 不应抛错（此时已没有活跃 controller，但代码路径必须静默）
    expect(() => session.abort()).not.toThrow()

    createSessionRuntimeSpy.mockRestore()
  })

  it('session.abort() 会终止进行中的 queryWithGraph，并让 finished reject', async () => {
    const { session, createSessionRuntimeSpy } = await prepareSession()

    // stub 工厂监听 ctx.abortSignal；一旦被 abort 立刻 reject。
    // 这确保我们直接验证 session → controller → NodeExecutorContext.abortSignal 的链路。
    const abortableFactory: AgentExecutorFactory =
      (node, ctx: NodeExecutorContext): NodeAction =>
      async () => {
        ctx.emitGraphEvent({
          type: 'GraphNodeStarted',
          runId: ctx.runId,
          graphId: ctx.graphId,
          nodeId: node.id,
          nodeKind: 'agent',
          timestamp: Date.now(),
        })
        return new Promise((_resolve, reject) => {
          if (!ctx.abortSignal) {
            reject(new Error('abortSignal should be wired through from session'))
            return
          }
          ctx.abortSignal.addEventListener('abort', () => {
            reject(new Error('aborted by session'))
          })
        })
      }

    const collectUntilFinish = async (): Promise<GraphRunDomainEvent[]> => {
      const events: GraphRunDomainEvent[] = []
      for await (const event of session.queryWithGraph(buildSingleNodeGraph(), {
        compileOptions: { agentExecutorFactory: abortableFactory },
      })) {
        events.push(event as GraphRunDomainEvent)
        // 收到 GraphNodeStarted 之后调用 abort()，确保执行器进入等待 signal 状态
        if (event.type === 'GraphNodeStarted') {
          session.abort()
        }
      }
      return events
    }

    await expect(collectUntilFinish()).rejects.toThrow()

    createSessionRuntimeSpy.mockRestore()
  })
})
