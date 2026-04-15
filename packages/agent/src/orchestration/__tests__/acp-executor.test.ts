// packages/agent/src/orchestration/__tests__/acp-executor.test.ts
import type { DomainEvent, RunId } from '@tianji/shared'
import { describe, expect, it, vi } from 'vitest'

import { type AcpRunnerLike, createAcpExecutorFactory } from '../executors/acp-executor.js'
import type { NodeExecutorContext } from '../executors/executor-types.js'
import type { AcpAgentNode } from '../graph-schema.js'

function makeCtx(overrides: Partial<NodeExecutorContext> = {}): NodeExecutorContext {
  return {
    runId: 'run_test' as RunId,
    graphId: 'g1',
    emitGraphEvent: vi.fn(),
    ...overrides,
  }
}

function makeAcpNode(overrides: Partial<AcpAgentNode> = {}): AcpAgentNode {
  return {
    id: 'acp1',
    type: 'acp-agent',
    acp: {},
    ...overrides,
  }
}

function makeFakeRunner(responses: string[]): AcpRunnerLike {
  let callIndex = 0
  return {
    connect: vi.fn(async () => {}),
    async *query(): AsyncIterable<DomainEvent> {
      const text = responses[callIndex] ?? ''
      callIndex += 1
      yield {
        type: 'RunStarted',
        runId: 'inner_run' as RunId,
        sessionId: 'inner_session' as never,
        triggerType: 'new',
        timestamp: Date.now(),
      }
      yield {
        type: 'MessageCompleted',
        runId: 'inner_run' as RunId,
        messageId: 'msg1',
        message: {
          id: 'msg1',
          role: 'assistant',
          content: [{ type: 'text', text }],
          createdAt: Date.now(),
        },
        timestamp: Date.now(),
      } as DomainEvent
      yield {
        type: 'RunCompleted',
        runId: 'inner_run' as RunId,
        sessionId: 'inner_session' as never,
        triggerType: 'new',
        timestamp: Date.now(),
      }
    },
    disconnect: vi.fn(async () => {}),
  }
}

describe('createAcpExecutorFactory', () => {
  it('透传内部 DomainEvent 到 emitRuntimeEvent 回调', async () => {
    const runtimeEvents: DomainEvent[] = []
    const runner = makeFakeRunner(['hello'])
    const factory = createAcpExecutorFactory({
      runnerProvider: () => runner,
    })
    const ctx = makeCtx({
      emitRuntimeEvent: (event) => runtimeEvents.push(event),
    })
    const node = makeAcpNode({ input: ['q'], output: ['a'] })
    const action = factory(node, ctx)
    await action({ q: 'test' }, {} as never)

    const types = runtimeEvents.map((e) => e.type)
    expect(types).toContain('RunStarted')
    expect(types).toContain('MessageCompleted')
    expect(types).toContain('RunCompleted')
  })

  it('emitRuntimeEvent 未提供时不报错', async () => {
    const runner = makeFakeRunner(['ok'])
    const factory = createAcpExecutorFactory({
      runnerProvider: () => runner,
    })
    const node = makeAcpNode({ input: ['q'], output: ['a'] })
    const action = factory(node, makeCtx())

    await expect(action({ q: 'x' }, {} as never)).resolves.toBeDefined()
  })
})
