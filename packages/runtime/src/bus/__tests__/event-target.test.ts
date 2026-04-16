/**
 * resolveTarget 单元测试：覆盖全部五个聚合根的代表性事件。
 */

import type { DomainEvent } from '@tianji/shared'
import { describe, expect, it } from 'vitest'
import { resolveTarget } from '../event-target.js'

describe('resolveTarget', () => {
  it('Session 聚合：SessionCreated → aggregateType=Session, aggregateId=sessionId', () => {
    const event: DomainEvent = {
      type: 'SessionCreated',
      sessionId: 'sess_1',
      timestamp: 0,
    }
    const target = resolveTarget(event)
    expect(target.aggregateType).toBe('Session')
    expect(target.aggregateId).toBe('sess_1')
  })

  it('GraphRun 聚合：GraphRunStarted → aggregateType=GraphRun, aggregateId=runId', () => {
    const event: DomainEvent = {
      type: 'GraphRunStarted',
      runId: 'gr_1',
      graphId: 'g1',
      graphVersion: 1,
      timestamp: 0,
    }
    const target = resolveTarget(event)
    expect(target.aggregateType).toBe('GraphRun')
    expect(target.aggregateId).toBe('gr_1')
  })

  it('Run 聚合：RunStarted → aggregateType=Run, aggregateId=runId', () => {
    const event: DomainEvent = {
      type: 'RunStarted',
      runId: 'run_1',
      sessionId: 's1',
      triggerType: 'fresh',
      timestamp: 0,
    }
    const target = resolveTarget(event)
    expect(target.aggregateType).toBe('Run')
    expect(target.aggregateId).toBe('run_1')
  })

  it('Task 聚合：TaskStarted → aggregateType=Task, aggregateId=taskId', () => {
    const event: DomainEvent = {
      type: 'TaskStarted',
      taskId: 'task_1',
      timestamp: 0,
    }
    const target = resolveTarget(event)
    expect(target.aggregateType).toBe('Task')
    expect(target.aggregateId).toBe('task_1')
  })

  it('Node 聚合：NodeRegistered → aggregateType=Node, aggregateId=nodeId', () => {
    const event: DomainEvent = {
      type: 'NodeRegistered',
      nodeId: 'node_1',
      version: '1.0.0',
      timestamp: 0,
    }
    const target = resolveTarget(event)
    expect(target.aggregateType).toBe('Node')
    expect(target.aggregateId).toBe('node_1')
  })

  it('Task 聚合：TaskMessageStarted → aggregateType=Task, aggregateId=taskId', () => {
    const event: DomainEvent = {
      type: 'TaskMessageStarted',
      taskId: 'task_1',
      messageId: 'msg_1',
      role: 'assistant',
      timestamp: 0,
    }
    const target = resolveTarget(event)
    expect(target.aggregateType).toBe('Task')
    expect(target.aggregateId).toBe('task_1')
  })

  it('Task 聚合：TaskMessageDelta → aggregateType=Task, aggregateId=taskId', () => {
    const event: DomainEvent = {
      type: 'TaskMessageDelta',
      taskId: 'task_1',
      messageId: 'msg_1',
      sequence: 1,
      channel: 'text',
      payload: { content: 'hello' },
      timestamp: 0,
    }
    const target = resolveTarget(event)
    expect(target.aggregateType).toBe('Task')
    expect(target.aggregateId).toBe('task_1')
  })

  it('Task 聚合：TaskMessageCompleted → aggregateType=Task, aggregateId=taskId', () => {
    const event: DomainEvent = {
      type: 'TaskMessageCompleted',
      taskId: 'task_1',
      messageId: 'msg_1',
      message: {
        id: 'msg_1',
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        createdAt: 0,
      },
      timestamp: 0,
    }
    const target = resolveTarget(event)
    expect(target.aggregateType).toBe('Task')
    expect(target.aggregateId).toBe('task_1')
  })
})
