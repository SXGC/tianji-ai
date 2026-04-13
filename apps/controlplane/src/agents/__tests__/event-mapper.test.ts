/**
 * 事件映射器测试 - 验证 StoredTaskEvent → AG-UI BaseEvent 的映射规则
 *
 * 测试业务行为，而非内部实现。
 * @module event-mapper.test
 */
import { EventType } from '@ag-ui/client'
import { describe, expect, it } from 'vitest'
import type { StoredTaskEvent } from '../../services/event-store.js'
import {
  type EventMapperContext,
  createInitialStateSnapshot,
  mapTaskEventToAgUiEvents,
} from '../event-mapper.js'

// ============================================================================
// 测试辅助函数
// ============================================================================

/** 构造一个 lifecycle StoredTaskEvent */
function makeLifecycleEvent(
  type: string,
  overrides: Partial<{
    taskId: string
    sequence: number
    sessionId: string
    runId: string
    error: string
    summary: string
  }> = {}
): StoredTaskEvent {
  const payload = JSON.stringify({
    kind: 'lifecycle',
    taskId: overrides.taskId ?? 'task-001',
    type,
    sequence: overrides.sequence ?? 1,
    timestamp: 1000,
    ...(overrides.sessionId !== undefined && { sessionId: overrides.sessionId }),
    ...(overrides.runId !== undefined && { runId: overrides.runId }),
    ...(overrides.error !== undefined && { error: overrides.error }),
    ...(overrides.summary !== undefined && { summary: overrides.summary }),
  })
  return {
    taskId: overrides.taskId ?? 'task-001',
    sequence: overrides.sequence ?? 1,
    kind: 'lifecycle',
    payload,
    receivedAt: 1000,
  }
}

/** 构造一个 agent StoredTaskEvent，event 为 RuntimeEvent */
function makeAgentEvent(
  runtimeEvent: Record<string, unknown>,
  taskId = 'task-001'
): StoredTaskEvent {
  const payload = JSON.stringify({
    kind: 'agent',
    taskId,
    sequence: 1,
    sessionId: 'session-001',
    runId: 'run-001',
    event: runtimeEvent,
  })
  return {
    taskId,
    sequence: 1,
    kind: 'agent',
    payload,
    receivedAt: 1000,
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
    const started = mapTaskEventToAgUiEvents(makeLifecycleEvent('task.started'), freshCtx())

    expect(initial.type).toBe(EventType.STATE_SNAPSHOT)
    expect(started[0]?.type).toBe(EventType.STATE_DELTA)
  })
})

// ============================================================================
// 生命周期事件映射
// ============================================================================

describe('lifecycle 事件映射', () => {
  describe('task.started → STATE_DELTA', () => {
    it('只产生一个 STATE_DELTA 事件', () => {
      const stored = makeLifecycleEvent('task.started')
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.STATE_DELTA)
    })

    it('STATE_DELTA 包含 /taskStatus=running 和 /taskId patch', () => {
      const stored = makeLifecycleEvent('task.started')
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      const delta = result[0] as { delta: unknown[] }
      expect(delta.delta).toEqual([
        { op: 'replace', path: '/taskStatus', value: 'running' },
        { op: 'replace', path: '/taskId', value: 'task-001' },
      ])
    })
  })

  describe('task.completed → RUN_FINISHED + STATE_DELTA', () => {
    it('产生两个事件：RUN_FINISHED 和 STATE_DELTA', () => {
      const stored = makeLifecycleEvent('task.completed')
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      expect(result).toHaveLength(2)
      expect(result[0].type).toBe(EventType.RUN_FINISHED)
      expect(result[1].type).toBe(EventType.STATE_DELTA)
    })

    it('RUN_FINISHED 的 threadId 和 runId 均为 taskId', () => {
      const stored = makeLifecycleEvent('task.completed')
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      const ev = result[0] as { threadId: string; runId: string }
      expect(ev.threadId).toBe('task-001')
      expect(ev.runId).toBe('task-001')
    })

    it('STATE_DELTA 包含 /taskStatus=completed patch', () => {
      const stored = makeLifecycleEvent('task.completed')
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      const delta = result[1] as { delta: unknown[] }
      expect(delta.delta).toEqual([{ op: 'replace', path: '/taskStatus', value: 'completed' }])
    })
  })

  describe('task.failed → STATE_DELTA + RUN_ERROR', () => {
    it('产生两个事件：先 STATE_DELTA，再 RUN_ERROR', () => {
      const stored = makeLifecycleEvent('task.failed', { error: '任务执行超时' })
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      expect(result).toHaveLength(2)
      expect(result[0].type).toBe(EventType.STATE_DELTA)
      expect(result[1].type).toBe(EventType.RUN_ERROR)
    })

    it('RUN_ERROR 的 message 为 error 字段内容', () => {
      const stored = makeLifecycleEvent('task.failed', { error: '任务执行超时' })
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      const ev = result[1] as { message: string }
      expect(ev.message).toBe('任务执行超时')
    })

    it('error 为空时 message 为空字符串', () => {
      const stored = makeLifecycleEvent('task.failed')
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      const ev = result[1] as { message: string }
      expect(ev.message).toBe('')
    })

    it('STATE_DELTA 包含 /taskStatus=failed patch', () => {
      const stored = makeLifecycleEvent('task.failed')
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      const delta = result[0] as { delta: unknown[] }
      expect(delta.delta).toEqual([{ op: 'replace', path: '/taskStatus', value: 'failed' }])
    })
  })

  describe('task.cancelled → STATE_DELTA + RUN_ERROR', () => {
    it('产生两个事件：先 STATE_DELTA，再 RUN_ERROR', () => {
      const stored = makeLifecycleEvent('task.cancelled')
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      expect(result).toHaveLength(2)
      expect(result[0].type).toBe(EventType.STATE_DELTA)
      expect(result[1].type).toBe(EventType.RUN_ERROR)
    })

    it('RUN_ERROR 的 message 固定为 "Task cancelled"', () => {
      const stored = makeLifecycleEvent('task.cancelled')
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      const ev = result[1] as { message: string }
      expect(ev.message).toBe('Task cancelled')
    })

    it('STATE_DELTA 包含 /taskStatus=cancelled patch', () => {
      const stored = makeLifecycleEvent('task.cancelled')
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      const delta = result[0] as { delta: unknown[] }
      expect(delta.delta).toEqual([{ op: 'replace', path: '/taskStatus', value: 'cancelled' }])
    })
  })

  describe('task.session.attached → STATE_DELTA', () => {
    it('产生 STATE_DELTA 携带 /sessionId replace patch', () => {
      const stored = makeLifecycleEvent('task.session.attached', { sessionId: 'sess-xyz' })
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.STATE_DELTA)
      const ev = result[0] as { delta: unknown[] }
      expect(ev.delta).toEqual([{ op: 'replace', path: '/sessionId', value: 'sess-xyz' }])
    })
  })

  describe('task.waiting → STATE_DELTA', () => {
    it('产生 STATE_DELTA 携带 /taskStatus replace patch', () => {
      const stored = makeLifecycleEvent('task.waiting')
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.STATE_DELTA)
      const ev = result[0] as { delta: unknown[] }
      expect(ev.delta).toEqual([{ op: 'replace', path: '/taskStatus', value: 'waiting' }])
    })
  })

  describe('未知 lifecycle 类型', () => {
    it('返回空数组（静默忽略未知类型）', () => {
      const stored = makeLifecycleEvent('task.unknown_future_type')
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      expect(result).toHaveLength(0)
    })
  })
})

// ============================================================================
// agent 事件映射 - 消息类
// ============================================================================

describe('agent 事件映射 - 消息', () => {
  describe('message.started → TEXT_MESSAGE_START', () => {
    it('映射为 TEXT_MESSAGE_START，role 为 assistant', () => {
      const stored = makeAgentEvent({
        type: 'message.started',
        runId: 'run-001',
        messageId: 'msg-001',
        message: {},
        timestamp: 1000,
      })
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.TEXT_MESSAGE_START)
      const ev = result[0] as { messageId: string; role: string }
      expect(ev.messageId).toBe('msg-001')
      expect(ev.role).toBe('assistant')
    })
  })

  describe('message.delta channel=text → TEXT_MESSAGE_CONTENT', () => {
    it('映射为 TEXT_MESSAGE_CONTENT，delta 为 payload.content', () => {
      const stored = makeAgentEvent({
        type: 'message.delta',
        runId: 'run-001',
        messageId: 'msg-001',
        sequence: 1,
        channel: 'text',
        payload: { content: 'Hello' },
        timestamp: 1000,
      })
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.TEXT_MESSAGE_CONTENT)
      const ev = result[0] as { messageId: string; delta: string }
      expect(ev.messageId).toBe('msg-001')
      expect(ev.delta).toBe('Hello')
    })
  })

  describe('message.delta channel=thinking - 首个 thinking delta', () => {
    it('ctx.inThinking=false 时，前置 REASONING_START + REASONING_MESSAGE_START', () => {
      const stored = makeAgentEvent({
        type: 'message.delta',
        runId: 'run-001',
        messageId: 'msg-001',
        sequence: 1,
        channel: 'thinking',
        payload: { content: '思考中...' },
        timestamp: 1000,
      })
      const ctx = freshCtx()
      const result = mapTaskEventToAgUiEvents(stored, ctx)
      expect(result).toHaveLength(3)
      expect(result[0].type).toBe(EventType.REASONING_START)
      expect(result[1].type).toBe(EventType.REASONING_MESSAGE_START)
      expect(result[2].type).toBe(EventType.REASONING_MESSAGE_CONTENT)
      const content = result[2] as { messageId: string; delta: string }
      expect(content.messageId).toBe('msg-001')
      expect(content.delta).toBe('思考中...')
    })

    it('处理首个 thinking delta 后，ctx.inThinking 变为 true', () => {
      const stored = makeAgentEvent({
        type: 'message.delta',
        runId: 'run-001',
        messageId: 'msg-001',
        sequence: 1,
        channel: 'thinking',
        payload: { content: '第一块' },
        timestamp: 1000,
      })
      const ctx = freshCtx()
      mapTaskEventToAgUiEvents(stored, ctx)
      expect(ctx.inThinking).toBe(true)
    })
  })

  describe('message.delta channel=thinking - 后续 thinking delta', () => {
    it('ctx.inThinking=true 时，只产生 REASONING_MESSAGE_CONTENT', () => {
      const stored = makeAgentEvent({
        type: 'message.delta',
        runId: 'run-001',
        messageId: 'msg-001',
        sequence: 2,
        channel: 'thinking',
        payload: { content: '继续思考' },
        timestamp: 1000,
      })
      const ctx: EventMapperContext = { inThinking: true, taskId: 'task-001' }
      const result = mapTaskEventToAgUiEvents(stored, ctx)
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.REASONING_MESSAGE_CONTENT)
    })
  })

  describe('message.completed → TEXT_MESSAGE_END', () => {
    it('非 thinking 状态时只产生 TEXT_MESSAGE_END', () => {
      const stored = makeAgentEvent({
        type: 'message.completed',
        runId: 'run-001',
        messageId: 'msg-001',
        message: {},
        timestamp: 1000,
      })
      const ctx = freshCtx()
      const result = mapTaskEventToAgUiEvents(stored, ctx)
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.TEXT_MESSAGE_END)
      const ev = result[0] as { messageId: string }
      expect(ev.messageId).toBe('msg-001')
    })

    it('thinking 状态时前置 REASONING_MESSAGE_END + REASONING_END，最后 TEXT_MESSAGE_END', () => {
      const stored = makeAgentEvent({
        type: 'message.completed',
        runId: 'run-001',
        messageId: 'msg-001',
        message: {},
        timestamp: 1000,
      })
      const ctx: EventMapperContext = { inThinking: true, taskId: 'task-001' }
      const result = mapTaskEventToAgUiEvents(stored, ctx)
      expect(result).toHaveLength(3)
      expect(result[0].type).toBe(EventType.REASONING_MESSAGE_END)
      expect(result[1].type).toBe(EventType.REASONING_END)
      expect(result[2].type).toBe(EventType.TEXT_MESSAGE_END)
    })

    it('thinking 状态结束后，ctx.inThinking 变为 false', () => {
      const stored = makeAgentEvent({
        type: 'message.completed',
        runId: 'run-001',
        messageId: 'msg-001',
        message: {},
        timestamp: 1000,
      })
      const ctx: EventMapperContext = { inThinking: true, taskId: 'task-001' }
      mapTaskEventToAgUiEvents(stored, ctx)
      expect(ctx.inThinking).toBe(false)
    })
  })
})

// ============================================================================
// agent 事件映射 - 工具调用
// ============================================================================

describe('agent 事件映射 - 工具调用', () => {
  describe('tool.started → TOOL_CALL_START（含 args，不发 TOOL_CALL_ARGS）', () => {
    it('只产生一个 TOOL_CALL_START 事件', () => {
      const stored = makeAgentEvent({
        type: 'tool.started',
        runId: 'run-001',
        toolCallId: 'call-001',
        invocation: { toolName: 'search', args: { query: 'hello' } },
        timestamp: 1000,
      })
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.TOOL_CALL_START)
    })

    it('TOOL_CALL_START 包含 toolCallId、toolCallName 和 args（JSON 字符串）', () => {
      const args = { query: 'hello', limit: 5 }
      const stored = makeAgentEvent({
        type: 'tool.started',
        runId: 'run-001',
        toolCallId: 'call-001',
        invocation: { toolName: 'search', args },
        timestamp: 1000,
      })
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      const start = result[0] as { toolCallId: string; toolCallName: string; args: string }
      expect(start.toolCallId).toBe('call-001')
      expect(start.toolCallName).toBe('search')
      expect(start.args).toBe(JSON.stringify(args))
    })
  })

  describe('tool.completed → TOOL_CALL_END + TOOL_CALL_RESULT', () => {
    it('产生两个事件：先 TOOL_CALL_END，再 TOOL_CALL_RESULT', () => {
      const stored = makeAgentEvent({
        type: 'tool.completed',
        runId: 'run-001',
        toolCallId: 'call-001',
        invocation: { toolName: 'search', args: {} },
        result: { value: '结果' },
        timestamp: 1000,
      })
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      expect(result).toHaveLength(2)
      expect(result[0].type).toBe(EventType.TOOL_CALL_END)
      expect(result[1].type).toBe(EventType.TOOL_CALL_RESULT)
    })

    it('TOOL_CALL_RESULT 包含 toolCallId 和 JSON 序列化的 content', () => {
      const toolResult = { value: '结果数据', status: 'ok' }
      const stored = makeAgentEvent({
        type: 'tool.completed',
        runId: 'run-001',
        toolCallId: 'call-002',
        invocation: { toolName: 'search', args: {} },
        result: toolResult,
        timestamp: 1000,
      })
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      const resultEv = result[1] as { toolCallId: string; content: string }
      expect(resultEv.toolCallId).toBe('call-002')
      expect(resultEv.content).toBe(JSON.stringify(toolResult))
    })
  })

  describe('tool.failed → TOOL_CALL_END', () => {
    it('只产生 TOOL_CALL_END，携带 toolCallId 和 error 信息', () => {
      const stored = makeAgentEvent({
        type: 'tool.failed',
        runId: 'run-001',
        toolCallId: 'call-003',
        invocation: { toolName: 'search', args: {} },
        error: { code: 'TIMEOUT', message: '超时' },
        timestamp: 1000,
      })
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.TOOL_CALL_END)
      const ev = result[0] as { toolCallId: string; error: string }
      expect(ev.toolCallId).toBe('call-003')
      expect(ev.error).toBe('超时')
    })
  })
})

// ============================================================================
// agent 事件映射 - run 生命周期
// ============================================================================

describe('agent 事件映射 - run 生命周期', () => {
  describe('run.started → STEP_STARTED', () => {
    it('映射为 STEP_STARTED，metadata 含 stepKind/runId/sessionId/triggerType', () => {
      const stored = makeAgentEvent({
        type: 'run.started',
        runId: 'run-001',
        sessionId: 'session-001',
        triggerType: 'fresh',
        timestamp: 1000,
      })
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.STEP_STARTED)
      const ev = result[0] as {
        metadata?: { stepKind: string; runId: string; sessionId: string; triggerType: string }
      }
      expect(ev.metadata?.stepKind).toBe('run')
      expect(ev.metadata?.runId).toBe('run-001')
      expect(ev.metadata?.sessionId).toBe('session-001')
      expect(ev.metadata?.triggerType).toBe('fresh')
    })
  })

  describe('run.completed → STEP_FINISHED', () => {
    it('映射为 STEP_FINISHED，metadata.stepKind 为 "run"', () => {
      const stored = makeAgentEvent({
        type: 'run.completed',
        runId: 'run-001',
        sessionId: 'session-001',
        triggerType: 'fresh',
        timestamp: 1000,
      })
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.STEP_FINISHED)
      const ev = result[0] as { stepName: string; metadata?: { stepKind: string } }
      expect(ev.metadata?.stepKind).toBe('run')
    })
  })
})

// ============================================================================
// agent 事件映射 - graph 生命周期
// ============================================================================

describe('agent 事件映射 - graph 生命周期', () => {
  describe('graph.started → STEP_STARTED', () => {
    it('映射为 STEP_STARTED，metadata 含 stepKind/graphId/graphVersion', () => {
      const stored = makeAgentEvent({
        type: 'graph.started',
        runId: 'run-001',
        graphId: 'graph-abc',
        graphVersion: 3,
        timestamp: 1000,
      })
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.STEP_STARTED)
      const ev = result[0] as {
        metadata?: { stepKind: string; graphId: string; graphVersion: number }
      }
      expect(ev.metadata?.stepKind).toBe('graph')
      expect(ev.metadata?.graphId).toBe('graph-abc')
      expect(ev.metadata?.graphVersion).toBe(3)
    })
  })

  describe('graph.node.started → STEP_STARTED', () => {
    it('映射为 STEP_STARTED，metadata 包含 stepKind="graph-node"、graphId、nodeId、nodeKind', () => {
      const stored = makeAgentEvent({
        type: 'graph.node.started',
        runId: 'run-001',
        graphId: 'graph-abc',
        nodeId: 'node-1',
        nodeKind: 'agent',
        timestamp: 1000,
      })
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.STEP_STARTED)
      const ev = result[0] as {
        metadata?: { stepKind: string; graphId: string; nodeId: string; nodeKind: string }
      }
      expect(ev.metadata?.stepKind).toBe('graph-node')
      expect(ev.metadata?.graphId).toBe('graph-abc')
      expect(ev.metadata?.nodeId).toBe('node-1')
      expect(ev.metadata?.nodeKind).toBe('agent')
    })
  })

  describe('graph.node.completed → STEP_FINISHED', () => {
    it('映射为 STEP_FINISHED，metadata 包含 stepKind="graph-node" 和 output', () => {
      const nodeOutput = { result: 'done' }
      const stored = makeAgentEvent({
        type: 'graph.node.completed',
        runId: 'run-001',
        graphId: 'graph-abc',
        nodeId: 'node-1',
        output: nodeOutput,
        timestamp: 1000,
      })
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.STEP_FINISHED)
      const ev = result[0] as {
        metadata?: { stepKind: string; graphId: string; nodeId: string; output: unknown }
      }
      expect(ev.metadata?.stepKind).toBe('graph-node')
      expect(ev.metadata?.graphId).toBe('graph-abc')
      expect(ev.metadata?.nodeId).toBe('node-1')
      expect(ev.metadata?.output).toEqual(nodeOutput)
    })
  })

  describe('run.failed → STEP_FINISHED', () => {
    it('映射为 STEP_FINISHED，metadata 含 stepKind="run" 和 error', () => {
      const stored = makeAgentEvent({
        type: 'run.failed',
        runId: 'run-001',
        error: { code: 'ERR', message: '运行失败' },
        timestamp: 1000,
      })
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.STEP_FINISHED)
      const ev = result[0] as {
        stepName: string
        metadata?: { stepKind: string; runId: string; error: unknown }
      }
      expect(ev.stepName).toBe('run:run-001')
      expect(ev.metadata?.stepKind).toBe('run')
      expect(ev.metadata?.runId).toBe('run-001')
      expect(ev.metadata?.error).toEqual({ code: 'ERR', message: '运行失败' })
    })
  })

  describe('run.cancelled → STEP_FINISHED', () => {
    it('映射为 STEP_FINISHED，metadata 含 stepKind="run" 和 cancelled=true', () => {
      const stored = makeAgentEvent({
        type: 'run.cancelled',
        runId: 'run-002',
        timestamp: 1000,
      })
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.STEP_FINISHED)
      const ev = result[0] as {
        stepName: string
        metadata?: { stepKind: string; runId: string; cancelled: boolean }
      }
      expect(ev.stepName).toBe('run:run-002')
      expect(ev.metadata?.stepKind).toBe('run')
      expect(ev.metadata?.cancelled).toBe(true)
    })
  })

  describe('graph.completed → STEP_FINISHED', () => {
    it('映射为 STEP_FINISHED，metadata 含 stepKind="graph" 和 finalState', () => {
      const finalState = { status: 'ok', output: 42 }
      const stored = makeAgentEvent({
        type: 'graph.completed',
        runId: 'run-001',
        graphId: 'graph-abc',
        finalState,
        timestamp: 1000,
      })
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.STEP_FINISHED)
      const ev = result[0] as {
        stepName: string
        metadata?: { stepKind: string; graphId: string; finalState: unknown }
      }
      expect(ev.stepName).toBe('graph:graph-abc')
      expect(ev.metadata?.stepKind).toBe('graph')
      expect(ev.metadata?.finalState).toEqual(finalState)
    })
  })

  describe('graph.node.failed → STEP_FINISHED', () => {
    it('映射为 STEP_FINISHED，metadata 含 stepKind="graph-node" 和 error', () => {
      const stored = makeAgentEvent({
        type: 'graph.node.failed',
        runId: 'run-001',
        graphId: 'graph-abc',
        nodeId: 'node-2',
        error: { code: 'NODE_ERR', message: '节点执行失败' },
        timestamp: 1000,
      })
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe(EventType.STEP_FINISHED)
      const ev = result[0] as {
        stepName: string
        metadata?: { stepKind: string; graphId: string; nodeId: string; error: unknown }
      }
      expect(ev.stepName).toBe('graph-node:graph-abc:node-2')
      expect(ev.metadata?.stepKind).toBe('graph-node')
      expect(ev.metadata?.graphId).toBe('graph-abc')
      expect(ev.metadata?.nodeId).toBe('node-2')
      expect(ev.metadata?.error).toEqual({ code: 'NODE_ERR', message: '节点执行失败' })
    })
  })

  describe('未知 agent 事件类型', () => {
    it('返回空数组（静默忽略）', () => {
      const stored = makeAgentEvent({
        type: 'completely.unknown.future.event',
        runId: 'run-001',
        timestamp: 1000,
      })
      const result = mapTaskEventToAgUiEvents(stored, freshCtx())
      expect(result).toHaveLength(0)
    })
  })
})
