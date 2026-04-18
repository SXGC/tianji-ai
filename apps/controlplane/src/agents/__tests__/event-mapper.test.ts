/**
 * 事件映射器测试 - 验证 DomainEventEnvelope → AG-UI BaseEvent 的映射规则
 *
 * 测试业务行为，而非内部实现。
 * @module event-mapper.test
 */
import { EventType } from '@ag-ui/client'
import type { DomainEvent, DomainEventEnvelope } from '@tianji/shared'
import { describe, expect, it } from 'vitest'
import { type EventMapperContext, createInitialStateSnapshot, mapToAgUi } from '../event-mapper.js'

// ============================================================================
// 测试辅助函数
// ============================================================================

/** 将裸 DomainEvent payload 包裹成 DomainEventEnvelope */
function envelope(payload: DomainEvent): DomainEventEnvelope {
  return {
    eventId: 'test-event-id',
    type: payload.type,
    occurredAt: '2026-01-01T00:00:00.000Z',
    correlationId: 'test-correlation-id',
    causationId: null,
    sequence: 1,
    aggregateType: 'Task',
    aggregateId: 'task-001',
    source: { processKind: 'node', processId: 'node-proc-1', nodeId: 'node-001' },
    payload,
  }
}

/** 返回一个默认的非 thinking 上下文 */
function freshCtx(taskId = 'task-001'): EventMapperContext {
  return { inThinking: false, taskId }
}

// ============================================================================
// createInitialStateSnapshot
// ============================================================================

describe('createInitialStateSnapshot', () => {
  it('返回 STATE_SNAPSHOT 类型的事件', () => {
    const event = createInitialStateSnapshot()
    expect(event.type).toBe(EventType.STATE_SNAPSHOT)
  })

  it('snapshot 包含 sessionId=null、taskStatus=null、taskId=null', () => {
    const event = createInitialStateSnapshot() as { snapshot: unknown }
    expect(event.snapshot).toEqual({ sessionId: null, taskStatus: null, taskId: null })
  })

  it('不会作为运行流的首个事件，运行流首个事件由上层运行器负责发出 RUN_STARTED', () => {
    const initial = createInitialStateSnapshot()
    const started = mapToAgUi(
      envelope({ type: 'TaskStarted', taskId: 'task-001', timestamp: 1000 }),
      freshCtx()
    )

    expect(initial.type).toBe(EventType.STATE_SNAPSHOT)
    expect(started[0]?.type).toBe(EventType.STATE_DELTA)
  })
})

// ============================================================================
// Task 事件映射
// ============================================================================

describe('Task 事件映射', () => {
  describe('TaskStarted → STATE_DELTA', () => {
    it('只产生一个 STATE_DELTA 事件', () => {
      const result = mapToAgUi(
        envelope({ type: 'TaskStarted', taskId: 'task-001', timestamp: 1000 }),
        freshCtx()
      )
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.STATE_DELTA)
    })

    it('STATE_DELTA 包含 /taskStatus=running 和 /taskId patch', () => {
      const result = mapToAgUi(
        envelope({ type: 'TaskStarted', taskId: 'task-001', timestamp: 1000 }),
        freshCtx()
      )
      const delta = result[0] as { delta: unknown[] }
      expect(delta.delta).toEqual([
        { op: 'replace', path: '/taskStatus', value: 'running' },
        { op: 'replace', path: '/taskId', value: 'task-001' },
      ])
    })
  })

  describe('TaskCompleted → STATE_DELTA', () => {
    it('只产生一个 STATE_DELTA 事件，由上层运行器统一发送 RUN_FINISHED', () => {
      const result = mapToAgUi(
        envelope({ type: 'TaskCompleted', taskId: 'task-001', timestamp: 1000 }),
        freshCtx()
      )
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.STATE_DELTA)
    })

    it('不会直接产出 RUN_FINISHED，避免在终止事件后继续发送状态更新', () => {
      const result = mapToAgUi(
        envelope({ type: 'TaskCompleted', taskId: 'task-001', timestamp: 1000 }),
        freshCtx()
      )
      expect(result.some((event) => event.type === EventType.RUN_FINISHED)).toBe(false)
    })

    it('STATE_DELTA 包含 /taskStatus=completed patch', () => {
      const result = mapToAgUi(
        envelope({ type: 'TaskCompleted', taskId: 'task-001', timestamp: 1000 }),
        freshCtx()
      )
      const delta = result[0] as { delta: unknown[] }
      expect(delta.delta).toEqual([{ op: 'replace', path: '/taskStatus', value: 'completed' }])
    })
  })

  describe('TaskFailed → STATE_DELTA + RUN_ERROR', () => {
    it('产生两个事件：先 STATE_DELTA，再 RUN_ERROR', () => {
      const result = mapToAgUi(
        envelope({
          type: 'TaskFailed',
          taskId: 'task-001',
          timestamp: 1000,
          error: {
            name: 'TianjiError',
            category: 'internal',
            code: 'ERR',
            message: '任务执行超时',
          },
        }),
        freshCtx()
      )
      expect(result).toHaveLength(2)
      expect(result[0].type).toBe(EventType.STATE_DELTA)
      expect(result[1].type).toBe(EventType.RUN_ERROR)
    })

    it('RUN_ERROR 的 message 为 error.message 字段内容', () => {
      const result = mapToAgUi(
        envelope({
          type: 'TaskFailed',
          taskId: 'task-001',
          timestamp: 1000,
          error: {
            name: 'TianjiError',
            category: 'internal',
            code: 'ERR',
            message: '任务执行超时',
          },
        }),
        freshCtx()
      )
      const resultEv = result[1] as { message: string }
      expect(resultEv.message).toBe('任务执行超时')
    })

    it('STATE_DELTA 包含 /taskStatus=failed patch', () => {
      const result = mapToAgUi(
        envelope({
          type: 'TaskFailed',
          taskId: 'task-001',
          timestamp: 1000,
          error: { name: 'TianjiError', category: 'internal', code: 'ERR', message: 'fail' },
        }),
        freshCtx()
      )
      const delta = result[0] as { delta: unknown[] }
      expect(delta.delta).toEqual([{ op: 'replace', path: '/taskStatus', value: 'failed' }])
    })
  })

  describe('TaskCancelled → 只发 STATE_DELTA（取消不是错误）', () => {
    it('不产生 RUN_ERROR（cancel 是用户主动取消，非错误）', () => {
      const result = mapToAgUi(
        envelope({ type: 'TaskCancelled', taskId: 'task-001', timestamp: 1000 }),
        freshCtx()
      )
      expect(result.some((e) => e.type === EventType.RUN_ERROR)).toBe(false)
    })

    it('只产生一个 STATE_DELTA 事件，由上层运行器统一发送 RUN_FINISHED', () => {
      const result = mapToAgUi(
        envelope({ type: 'TaskCancelled', taskId: 'task-001', timestamp: 1000 }),
        freshCtx()
      )
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.STATE_DELTA)
    })

    it('STATE_DELTA 包含 /taskStatus=cancelled patch', () => {
      const result = mapToAgUi(
        envelope({ type: 'TaskCancelled', taskId: 'task-001', timestamp: 1000 }),
        freshCtx()
      )
      const delta = result[0] as { delta: unknown[] }
      expect(delta.delta).toEqual([{ op: 'replace', path: '/taskStatus', value: 'cancelled' }])
    })
  })

  describe('TaskSessionAttached → STATE_DELTA', () => {
    it('产生 STATE_DELTA 携带 /sessionId replace patch', () => {
      const result = mapToAgUi(
        envelope({
          type: 'TaskSessionAttached',
          taskId: 'task-001',
          timestamp: 1000,
          sessionId: 'sess-xyz',
        }),
        freshCtx()
      )
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.STATE_DELTA)
      const resultEv = result[0] as { delta: unknown[] }
      expect(resultEv.delta).toEqual([{ op: 'replace', path: '/sessionId', value: 'sess-xyz' }])
    })
  })

  describe('TaskWaiting → STATE_DELTA', () => {
    it('产生 STATE_DELTA 携带 /taskStatus replace patch', () => {
      const result = mapToAgUi(
        envelope({
          type: 'TaskWaiting',
          taskId: 'task-001',
          timestamp: 1000,
          reason: 'hitl',
        }),
        freshCtx()
      )
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.STATE_DELTA)
      const resultEv = result[0] as { delta: unknown[] }
      expect(resultEv.delta).toEqual([{ op: 'replace', path: '/taskStatus', value: 'waiting' }])
    })
  })

  describe('未知 / 不映射事件类型', () => {
    it('TaskObservationLost 返回空数组（无 AG-UI 映射）', () => {
      const result = mapToAgUi(
        envelope({
          type: 'TaskObservationLost',
          taskId: 'task-001',
          timestamp: 1000,
          lastObservedAt: '2026-01-01T00:00:00.000Z',
        }),
        freshCtx()
      )
      expect(result).toHaveLength(0)
    })
  })
})

// ============================================================================
// Run 事件映射 - 消息类
// ============================================================================

describe('Run 事件映射 - 消息', () => {
  describe('MessageStarted → TEXT_MESSAGE_START', () => {
    it('映射为 TEXT_MESSAGE_START，role 为 assistant', () => {
      const result = mapToAgUi(
        envelope({
          type: 'MessageStarted',
          runId: 'run-001',
          messageId: 'msg-001',
          message: { role: 'assistant', content: [] },
          timestamp: 1000,
        }),
        freshCtx()
      )
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.TEXT_MESSAGE_START)
      const resultEv = result[0] as { messageId: string; role: string }
      expect(resultEv.messageId).toBe('msg-001')
      expect(resultEv.role).toBe('assistant')
    })
  })

  describe('MessageDelta channel=text → TEXT_MESSAGE_CONTENT', () => {
    it('映射为 TEXT_MESSAGE_CONTENT，delta 为 payload.content', () => {
      const result = mapToAgUi(
        envelope({
          type: 'MessageDelta',
          runId: 'run-001',
          messageId: 'msg-001',
          sequence: 1,
          channel: 'text',
          payload: { content: 'Hello' },
          timestamp: 1000,
        }),
        freshCtx()
      )
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.TEXT_MESSAGE_CONTENT)
      const resultEv = result[0] as { messageId: string; delta: string }
      expect(resultEv.messageId).toBe('msg-001')
      expect(resultEv.delta).toBe('Hello')
    })
  })

  describe('MessageDelta channel=thinking - 首个 thinking delta', () => {
    it('ctx.inThinking=false 时，前置 REASONING_START + REASONING_MESSAGE_START', () => {
      const ctx = freshCtx()
      const result = mapToAgUi(
        envelope({
          type: 'MessageDelta',
          runId: 'run-001',
          messageId: 'msg-001',
          sequence: 1,
          channel: 'thinking',
          payload: { content: '思考中...' },
          timestamp: 1000,
        }),
        ctx
      )
      expect(result).toHaveLength(3)
      expect(result[0].type).toBe(EventType.REASONING_START)
      expect(result[1].type).toBe(EventType.REASONING_MESSAGE_START)
      expect(result[2].type).toBe(EventType.REASONING_MESSAGE_CONTENT)
      const content = result[2] as { messageId: string; delta: string }
      expect(content.messageId).toBe('msg-001')
      expect(content.delta).toBe('思考中...')
    })

    it('处理首个 thinking delta 后，ctx.inThinking 变为 true', () => {
      const ctx = freshCtx()
      mapToAgUi(
        envelope({
          type: 'MessageDelta',
          runId: 'run-001',
          messageId: 'msg-001',
          sequence: 1,
          channel: 'thinking',
          payload: { content: '第一块' },
          timestamp: 1000,
        }),
        ctx
      )
      expect(ctx.inThinking).toBe(true)
    })
  })

  describe('MessageDelta channel=thinking - 后续 thinking delta', () => {
    it('ctx.inThinking=true 时，只产生 REASONING_MESSAGE_CONTENT', () => {
      const ctx: EventMapperContext = { inThinking: true, taskId: 'task-001' }
      const result = mapToAgUi(
        envelope({
          type: 'MessageDelta',
          runId: 'run-001',
          messageId: 'msg-001',
          sequence: 2,
          channel: 'thinking',
          payload: { content: '继续思考' },
          timestamp: 1000,
        }),
        ctx
      )
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.REASONING_MESSAGE_CONTENT)
    })
  })

  describe('MessageCompleted → TEXT_MESSAGE_END', () => {
    it('非 thinking 状态时只产生 TEXT_MESSAGE_END', () => {
      const ctx = freshCtx()
      const result = mapToAgUi(
        envelope({
          type: 'MessageCompleted',
          runId: 'run-001',
          messageId: 'msg-001',
          message: { role: 'assistant', content: [] },
          timestamp: 1000,
        }),
        ctx
      )
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.TEXT_MESSAGE_END)
      const resultEv = result[0] as { messageId: string }
      expect(resultEv.messageId).toBe('msg-001')
    })

    it('thinking 状态时前置 REASONING_MESSAGE_END + REASONING_END，最后 TEXT_MESSAGE_END', () => {
      const ctx: EventMapperContext = { inThinking: true, taskId: 'task-001' }
      const result = mapToAgUi(
        envelope({
          type: 'MessageCompleted',
          runId: 'run-001',
          messageId: 'msg-001',
          message: { role: 'assistant', content: [] },
          timestamp: 1000,
        }),
        ctx
      )
      expect(result).toHaveLength(3)
      expect(result[0].type).toBe(EventType.REASONING_MESSAGE_END)
      expect(result[1].type).toBe(EventType.REASONING_END)
      expect(result[2].type).toBe(EventType.TEXT_MESSAGE_END)
    })

    it('thinking 状态结束后，ctx.inThinking 变为 false', () => {
      const ctx: EventMapperContext = { inThinking: true, taskId: 'task-001' }
      mapToAgUi(
        envelope({
          type: 'MessageCompleted',
          runId: 'run-001',
          messageId: 'msg-001',
          message: { role: 'assistant', content: [] },
          timestamp: 1000,
        }),
        ctx
      )
      expect(ctx.inThinking).toBe(false)
    })
  })
})

// ============================================================================
// Run 事件映射 - 工具调用
// ============================================================================

describe('Run 事件映射 - 工具调用', () => {
  describe('ToolStarted → TOOL_CALL_START（含 args，不发 TOOL_CALL_ARGS）', () => {
    it('只产生一个 TOOL_CALL_START 事件', () => {
      const result = mapToAgUi(
        envelope({
          type: 'ToolStarted',
          runId: 'run-001',
          toolCallId: 'call-001',
          invocation: { toolCallId: 'call-001', toolName: 'search', args: { query: 'hello' } },
          timestamp: 1000,
        }),
        freshCtx()
      )
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.TOOL_CALL_START)
    })

    it('TOOL_CALL_START 包含 toolCallId、toolCallName 和 args（JSON 字符串）', () => {
      const args = { query: 'hello', limit: 5 }
      const result = mapToAgUi(
        envelope({
          type: 'ToolStarted',
          runId: 'run-001',
          toolCallId: 'call-001',
          invocation: { toolCallId: 'call-001', toolName: 'search', args },
          timestamp: 1000,
        }),
        freshCtx()
      )
      const start = result[0] as { toolCallId: string; toolCallName: string; args: string }
      expect(start.toolCallId).toBe('call-001')
      expect(start.toolCallName).toBe('search')
      expect(start.args).toBe(JSON.stringify(args))
    })
  })

  describe('ToolCompleted → TOOL_CALL_END + TOOL_CALL_RESULT', () => {
    it('产生两个事件：先 TOOL_CALL_END，再 TOOL_CALL_RESULT', () => {
      const result = mapToAgUi(
        envelope({
          type: 'ToolCompleted',
          runId: 'run-001',
          toolCallId: 'call-001',
          invocation: { toolCallId: 'call-001', toolName: 'search', args: {} },
          result: { toolCallId: 'call-001', result: { value: '结果' } },
          timestamp: 1000,
        }),
        freshCtx()
      )
      expect(result).toHaveLength(2)
      expect(result[0].type).toBe(EventType.TOOL_CALL_END)
      expect(result[1].type).toBe(EventType.TOOL_CALL_RESULT)
    })

    it('TOOL_CALL_RESULT 包含 toolCallId 和 JSON 序列化的 result.result', () => {
      const innerResult = { value: '结果数据', status: 'ok' }
      const result = mapToAgUi(
        envelope({
          type: 'ToolCompleted',
          runId: 'run-001',
          toolCallId: 'call-002',
          invocation: { toolCallId: 'call-002', toolName: 'search', args: {} },
          result: { toolCallId: 'call-002', result: innerResult },
          timestamp: 1000,
        }),
        freshCtx()
      )
      const resultEv = result[1] as { toolCallId: string; content: string }
      expect(resultEv.toolCallId).toBe('call-002')
      expect(resultEv.content).toBe(JSON.stringify(innerResult))
    })
  })

  describe('ToolFailed → TOOL_CALL_END', () => {
    it('只产生 TOOL_CALL_END，携带 toolCallId 和 error 信息', () => {
      const result = mapToAgUi(
        envelope({
          type: 'ToolFailed',
          runId: 'run-001',
          toolCallId: 'call-003',
          invocation: { toolCallId: 'call-003', toolName: 'search', args: {} },
          error: { name: 'ToolError', category: 'tool', code: 'TIMEOUT', message: '超时' },
          timestamp: 1000,
        }),
        freshCtx()
      )
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.TOOL_CALL_END)
      const resultEv = result[0] as { toolCallId: string; error: string }
      expect(resultEv.toolCallId).toBe('call-003')
      expect(resultEv.error).toBe('超时')
    })
  })
})

// ============================================================================
// Run 事件映射 - run 生命周期
// ============================================================================

describe('Run 事件映射 - run 生命周期', () => {
  describe('RunStarted → STEP_STARTED', () => {
    it('映射为 STEP_STARTED，metadata 含 stepKind/runId/sessionId/triggerType', () => {
      const result = mapToAgUi(
        envelope({
          type: 'RunStarted',
          runId: 'run-001',
          sessionId: 'session-001',
          triggerType: 'fresh',
          timestamp: 1000,
        }),
        freshCtx()
      )
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.STEP_STARTED)
      const resultEv = result[0] as {
        metadata?: { stepKind: string; runId: string; sessionId: string; triggerType: string }
      }
      expect(resultEv.metadata?.stepKind).toBe('run')
      expect(resultEv.metadata?.runId).toBe('run-001')
      expect(resultEv.metadata?.sessionId).toBe('session-001')
      expect(resultEv.metadata?.triggerType).toBe('fresh')
    })
  })

  describe('RunCompleted → STEP_FINISHED', () => {
    it('映射为 STEP_FINISHED，metadata.stepKind 为 "run"', () => {
      const result = mapToAgUi(
        envelope({
          type: 'RunCompleted',
          runId: 'run-001',
          sessionId: 'session-001',
          triggerType: 'fresh',
          timestamp: 1000,
        }),
        freshCtx()
      )
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.STEP_FINISHED)
      const resultEv = result[0] as { stepName: string; metadata?: { stepKind: string } }
      expect(resultEv.metadata?.stepKind).toBe('run')
    })
  })

  describe('RunFailed → STEP_FINISHED', () => {
    it('映射为 STEP_FINISHED，metadata 含 stepKind="run" 和 error', () => {
      const error = {
        name: 'TianjiError',
        category: 'internal' as const,
        code: 'ERR',
        message: '运行失败',
      }
      const result = mapToAgUi(
        envelope({
          type: 'RunFailed',
          runId: 'run-001',
          sessionId: 'session-001',
          triggerType: 'fresh',
          error,
          timestamp: 1000,
        }),
        freshCtx()
      )
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.STEP_FINISHED)
      const resultEv = result[0] as {
        stepName: string
        metadata?: { stepKind: string; runId: string; error: unknown }
      }
      expect(resultEv.stepName).toBe('run:run-001')
      expect(resultEv.metadata?.stepKind).toBe('run')
      expect(resultEv.metadata?.runId).toBe('run-001')
      expect(resultEv.metadata?.error).toEqual(error)
    })
  })

  describe('RunCancelled → STEP_FINISHED', () => {
    it('映射为 STEP_FINISHED，metadata 含 stepKind="run" 和 cancelled=true', () => {
      const result = mapToAgUi(
        envelope({
          type: 'RunCancelled',
          runId: 'run-002',
          sessionId: 'session-001',
          triggerType: 'fresh',
          reason: 'abort',
          timestamp: 1000,
        }),
        freshCtx()
      )
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.STEP_FINISHED)
      const resultEv = result[0] as {
        stepName: string
        metadata?: { stepKind: string; runId: string; cancelled: boolean }
      }
      expect(resultEv.stepName).toBe('run:run-002')
      expect(resultEv.metadata?.stepKind).toBe('run')
      expect(resultEv.metadata?.cancelled).toBe(true)
    })
  })
})

// ============================================================================
// GraphRun 事件映射
// ============================================================================

describe('GraphRun 事件映射', () => {
  describe('GraphRunStarted → STEP_STARTED', () => {
    it('映射为 STEP_STARTED，metadata 含 stepKind/graphId/graphVersion', () => {
      const result = mapToAgUi(
        envelope({
          type: 'GraphRunStarted',
          runId: 'run-001',
          graphId: 'graph-abc',
          graphVersion: 3,
          mermaidDiagram: '',
          timestamp: 1000,
        }),
        freshCtx()
      )
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.STEP_STARTED)
      const resultEv = result[0] as {
        metadata?: { stepKind: string; graphId: string; graphVersion: number }
      }
      expect(resultEv.metadata?.stepKind).toBe('graph')
      expect(resultEv.metadata?.graphId).toBe('graph-abc')
      expect(resultEv.metadata?.graphVersion).toBe(3)
    })
  })

  describe('GraphNodeStarted → STEP_STARTED', () => {
    it('映射为 STEP_STARTED，metadata 包含 stepKind="graph-node"、graphId、nodeId、nodeKind', () => {
      const result = mapToAgUi(
        envelope({
          type: 'GraphNodeStarted',
          runId: 'run-001',
          graphId: 'graph-abc',
          nodeId: 'node-1',
          nodeKind: 'agent',
          timestamp: 1000,
        }),
        freshCtx()
      )
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.STEP_STARTED)
      const resultEv = result[0] as {
        metadata?: { stepKind: string; graphId: string; nodeId: string; nodeKind: string }
      }
      expect(resultEv.metadata?.stepKind).toBe('graph-node')
      expect(resultEv.metadata?.graphId).toBe('graph-abc')
      expect(resultEv.metadata?.nodeId).toBe('node-1')
      expect(resultEv.metadata?.nodeKind).toBe('agent')
    })
  })

  describe('GraphNodeCompleted → STEP_FINISHED', () => {
    it('映射为 STEP_FINISHED，metadata 包含 stepKind="graph-node"、output 和 usage', () => {
      const nodeOutput = { result: 'done' }
      const usage = {
        inputTokens: 12,
        outputTokens: 8,
        totalTokens: 20,
        cacheReadTokens: 5,
        cacheCreationTokens: 3,
      }
      const result = mapToAgUi(
        envelope({
          type: 'GraphNodeCompleted',
          runId: 'run-001',
          graphId: 'graph-abc',
          nodeId: 'node-1',
          nodeKind: 'agent',
          output: nodeOutput,
          usage,
          timestamp: 1000,
        }),
        freshCtx()
      )
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.STEP_FINISHED)
      const resultEv = result[0] as {
        metadata?: {
          stepKind: string
          graphId: string
          nodeId: string
          output: unknown
          usage: unknown
        }
      }
      expect(resultEv.metadata?.stepKind).toBe('graph-node')
      expect(resultEv.metadata?.graphId).toBe('graph-abc')
      expect(resultEv.metadata?.nodeId).toBe('node-1')
      expect(resultEv.metadata?.output).toEqual(nodeOutput)
      expect(resultEv.metadata?.usage).toEqual(usage)
    })

    it('usage 缺失时，metadata 里根本没有 usage key', () => {
      const result = mapToAgUi(
        envelope({
          type: 'GraphNodeCompleted',
          runId: 'run-001',
          graphId: 'graph-abc',
          nodeId: 'node-1',
          nodeKind: 'agent',
          output: { result: 'done' },
          timestamp: 1000,
        }),
        freshCtx()
      )

      const resultEv = result[0] as {
        metadata?: Record<string, unknown>
      }
      expect(resultEv.metadata).toBeDefined()
      expect('usage' in (resultEv.metadata as Record<string, unknown>)).toBe(false)
    })
  })

  describe('GraphRunCompleted → STEP_FINISHED', () => {
    it('映射为 STEP_FINISHED，metadata 含 stepKind="graph"、finalState 和 usage', () => {
      const finalState = { status: 'ok', output: 42 }
      const usage = {
        inputTokens: 20,
        outputTokens: 15,
        totalTokens: 35,
        cacheReadTokens: 7,
        cacheCreationTokens: 4,
      }
      const result = mapToAgUi(
        envelope({
          type: 'GraphRunCompleted',
          runId: 'run-001',
          graphId: 'graph-abc',
          graphVersion: 1,
          finalState,
          usage,
          timestamp: 1000,
        }),
        freshCtx()
      )
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.STEP_FINISHED)
      const resultEv = result[0] as {
        stepName: string
        metadata?: { stepKind: string; graphId: string; finalState: unknown; usage: unknown }
      }
      expect(resultEv.stepName).toBe('graph:graph-abc')
      expect(resultEv.metadata?.stepKind).toBe('graph')
      expect(resultEv.metadata?.finalState).toEqual(finalState)
      expect(resultEv.metadata?.usage).toEqual(usage)
    })

    it('usage 缺失时，metadata 里根本没有 usage key', () => {
      const result = mapToAgUi(
        envelope({
          type: 'GraphRunCompleted',
          runId: 'run-001',
          graphId: 'graph-abc',
          graphVersion: 1,
          finalState: { status: 'ok' },
          timestamp: 1000,
        }),
        freshCtx()
      )

      const resultEv = result[0] as {
        metadata?: Record<string, unknown>
      }
      expect(resultEv.metadata).toBeDefined()
      expect('usage' in (resultEv.metadata as Record<string, unknown>)).toBe(false)
    })
  })

  describe('GraphNodeFailed → STEP_FINISHED', () => {
    it('映射为 STEP_FINISHED，metadata 含 stepKind="graph-node"、error 和 usage', () => {
      const error = {
        name: 'TianjiError',
        category: 'internal' as const,
        code: 'NODE_ERR',
        message: '节点执行失败',
      }
      const usage = {
        inputTokens: 9,
        outputTokens: 2,
        totalTokens: 11,
        cacheReadTokens: 1,
        cacheCreationTokens: 0,
      }
      const result = mapToAgUi(
        envelope({
          type: 'GraphNodeFailed',
          runId: 'run-001',
          graphId: 'graph-abc',
          nodeId: 'node-2',
          nodeKind: 'agent',
          error,
          usage,
          timestamp: 1000,
        }),
        freshCtx()
      )
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.STEP_FINISHED)
      const resultEv = result[0] as {
        stepName: string
        metadata?: {
          stepKind: string
          graphId: string
          nodeId: string
          error: unknown
          usage: unknown
        }
      }
      expect(resultEv.stepName).toBe('graph-node:graph-abc:node-2')
      expect(resultEv.metadata?.stepKind).toBe('graph-node')
      expect(resultEv.metadata?.graphId).toBe('graph-abc')
      expect(resultEv.metadata?.nodeId).toBe('node-2')
      expect(resultEv.metadata?.error).toEqual(error)
      expect(resultEv.metadata?.usage).toEqual(usage)
    })

    it('usage 缺失时，metadata 里根本没有 usage key', () => {
      const result = mapToAgUi(
        envelope({
          type: 'GraphNodeFailed',
          runId: 'run-001',
          graphId: 'graph-abc',
          nodeId: 'node-2',
          nodeKind: 'agent',
          error: {
            name: 'TianjiError',
            category: 'internal',
            code: 'NODE_ERR',
            message: '节点执行失败',
          },
          timestamp: 1000,
        }),
        freshCtx()
      )

      const resultEv = result[0] as {
        metadata?: Record<string, unknown>
      }
      expect(resultEv.metadata).toBeDefined()
      expect('usage' in (resultEv.metadata as Record<string, unknown>)).toBe(false)
    })
  })

  describe('不映射的 GraphRun 事件', () => {
    it('GraphRunFailed 返回空数组（无 AG-UI 映射）', () => {
      const result = mapToAgUi(
        envelope({
          type: 'GraphRunFailed',
          runId: 'run-001',
          graphId: 'graph-abc',
          graphVersion: 1,
          error: { name: 'TianjiError', category: 'internal', code: 'ERR', message: 'fail' },
          timestamp: 1000,
        }),
        freshCtx()
      )
      expect(result).toHaveLength(0)
    })

    it('GraphRunCancelled 返回空数组（无 AG-UI 映射）', () => {
      const result = mapToAgUi(
        envelope({
          type: 'GraphRunCancelled',
          runId: 'run-001',
          graphId: 'graph-abc',
          graphVersion: 1,
          reason: 'abort',
          timestamp: 1000,
        }),
        freshCtx()
      )
      expect(result).toHaveLength(0)
    })
  })
})

// ============================================================================
// TaskMessage* 事件映射
// ============================================================================

describe('TaskMessage* 事件映射', () => {
  it('TaskMessageStarted → TEXT_MESSAGE_START，role=assistant', () => {
    const result = mapToAgUi(
      envelope({
        type: 'TaskMessageStarted',
        taskId: 'task-001',
        messageId: 'msg-1',
        role: 'assistant',
        timestamp: 1000,
      }),
      freshCtx()
    )
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe(EventType.TEXT_MESSAGE_START)
    expect((result[0] as { messageId: string }).messageId).toBe('msg-1')
    expect((result[0] as { role: string }).role).toBe('assistant')
  })

  it('TaskMessageDelta 在 text 通道下 → TEXT_MESSAGE_CONTENT', () => {
    const result = mapToAgUi(
      envelope({
        type: 'TaskMessageDelta',
        taskId: 'task-001',
        messageId: 'msg-1',
        sequence: 1,
        channel: 'text',
        payload: { content: 'hello' },
        timestamp: 1000,
      }),
      freshCtx()
    )
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe(EventType.TEXT_MESSAGE_CONTENT)
    expect((result[0] as { delta: string }).delta).toBe('hello')
  })

  it('TaskMessageDelta 在 thinking 通道下首次触发 REASONING_START/REASONING_MESSAGE_START/REASONING_MESSAGE_CONTENT', () => {
    const ctx = freshCtx()
    const result = mapToAgUi(
      envelope({
        type: 'TaskMessageDelta',
        taskId: 'task-001',
        messageId: 'msg-1',
        sequence: 1,
        channel: 'thinking',
        payload: { content: 'step-1' },
        timestamp: 1000,
      }),
      ctx
    )
    expect(result.map((e) => e.type)).toEqual([
      EventType.REASONING_START,
      EventType.REASONING_MESSAGE_START,
      EventType.REASONING_MESSAGE_CONTENT,
    ])
    expect(ctx.inThinking).toBe(true)
  })

  it('TaskMessageCompleted 在 thinking 中先发 REASONING_MESSAGE_END+REASONING_END，再发 TEXT_MESSAGE_END', () => {
    const ctx: EventMapperContext = { inThinking: true, taskId: 'task-001' }
    const result = mapToAgUi(
      envelope({
        type: 'TaskMessageCompleted',
        taskId: 'task-001',
        messageId: 'msg-1',
        message: {
          id: 'msg-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          createdAt: 1000,
        },
        timestamp: 1000,
      }),
      ctx
    )
    expect(result.map((e) => e.type)).toEqual([
      EventType.REASONING_MESSAGE_END,
      EventType.REASONING_END,
      EventType.TEXT_MESSAGE_END,
    ])
    expect(ctx.inThinking).toBe(false)
  })

  it('TaskMessageCompleted 非 thinking 状态下只发 TEXT_MESSAGE_END', () => {
    const result = mapToAgUi(
      envelope({
        type: 'TaskMessageCompleted',
        taskId: 'task-001',
        messageId: 'msg-1',
        message: {
          id: 'msg-1',
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
          createdAt: 1000,
        },
        timestamp: 1000,
      }),
      freshCtx()
    )
    expect(result).toHaveLength(1)
    expect(result[0].type).toBe(EventType.TEXT_MESSAGE_END)
  })
})
