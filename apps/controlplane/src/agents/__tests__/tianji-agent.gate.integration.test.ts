/**
 * TianjiAgent × AgUiEventGate 集成测试
 *
 * 验证 gate 正确介入 run() 输出通道：终态事件之前活跃文本/推理消息必被 flush 闭合，
 * 避免 AG-UI 运行时前端报 "Cannot send 'RUN_FINISHED' while text messages are still active"。
 *
 * @module tianji-agent.gate.integration.test
 */
import { createMemorySink, createObserverLogger } from '@tianji/observer'
import type { ObserverMemorySink } from '@tianji/observer'
import type { DomainEvent, DomainEventEnvelope } from '@tianji/shared'
import { createEventBus } from '@tianji/shared'
import { lastValueFrom, toArray } from 'rxjs'
import { afterEach, describe, expect, it } from 'vitest'

import { type ControlPlaneDb, createDatabase } from '../../db/index.js'
import { TianjiAgent } from '../tianji-agent.js'

describe('TianjiAgent × AgUiEventGate 集成', () => {
  let db: ControlPlaneDb
  afterEach(() => db?.close())

  function setupOnlineNode(nodeId: string) {
    db.raw
      .prepare(
        `INSERT INTO enrollment_tokens (token, created_at) VALUES ('test-token', ${Date.now()})
         ON CONFLICT(token) DO NOTHING`
      )
      .run()
    db.raw
      .prepare(
        `INSERT INTO nodes
           (node_id, hostname, platform, version, status, access_token_hash, access_token_expires_at, enrollment_token, created_at, updated_at)
         VALUES (?, 'host', 'linux', '1.0.0', 'online', 'hash', ${Date.now() + 3600000}, 'test-token', ${Date.now()}, ${Date.now()})`
      )
      .run(nodeId)
  }

  /**
   * 构造完整的 DomainEventEnvelope。
   * 字段完整性对齐 event-mapper.test.ts 的风格；payload 走 DomainEvent 断言以免在测试里硬写全联合类型。
   */
  function envelope(
    aggregateId: string,
    sequence: number,
    payload: DomainEvent
  ): DomainEventEnvelope {
    return {
      eventId: `e-${sequence}`,
      type: payload.type,
      occurredAt: new Date(1_700_000_000_000 + sequence).toISOString(),
      correlationId: 'test-correlation',
      causationId: null,
      sequence,
      aggregateType: 'Task',
      aggregateId,
      source: { processKind: 'node', processId: 'node-proc-1', nodeId: 'node-1' },
      payload,
    }
  }

  /**
   * 启动一次 agent.run 并同步读取 DB 中刚插入的 taskId。
   * 返回 bus、sink、taskId、eventsPromise（订阅完成时 resolve 成完整事件数组）。
   */
  function bootstrapRun() {
    db = createDatabase(':memory:')
    setupOnlineNode('node-1')
    const bus = createEventBus({ lagSink: () => undefined, errorSink: () => undefined })
    const sink: ObserverMemorySink = createMemorySink()
    const logger = createObserverLogger({ sinks: [sink] })
    const agent = new TianjiAgent(db, 'node-1', 'agent-1', bus, logger)

    const stream$ = agent.run({
      messages: [{ id: 'u1', role: 'user', content: 'hi' }],
      tools: [],
      context: [],
      forwardedProps: {},
      state: {},
    })
    // lastValueFrom 立即订阅 Observable，Observable 工厂内的 DB INSERT 同步执行
    const eventsPromise = lastValueFrom(stream$.pipe(toArray()))
    const row = db.raw.prepare('SELECT task_id FROM tasks').get() as { task_id: string }

    return { bus, sink, taskId: row.task_id, eventsPromise }
  }

  it('I1 成功路径：最后一个事件是 RUN_FINISHED，TEXT_MESSAGE_END 在其之前，无 error 日志', async () => {
    const { bus, sink, taskId, eventsPromise } = bootstrapRun()
    let seq = 1
    bus.publish(
      envelope(taskId, seq++, {
        type: 'TaskStarted',
        taskId,
        timestamp: Date.now(),
      } as DomainEvent)
    )
    bus.publish(
      envelope(taskId, seq++, {
        type: 'TaskMessageStarted',
        taskId,
        timestamp: Date.now(),
        messageId: 'M1',
        role: 'assistant',
      } as DomainEvent)
    )
    bus.publish(
      envelope(taskId, seq++, {
        type: 'TaskMessageDelta',
        taskId,
        timestamp: Date.now(),
        messageId: 'M1',
        sequence: 1,
        channel: 'text',
        payload: { content: 'ok' },
      } as DomainEvent)
    )
    bus.publish(
      envelope(taskId, seq++, {
        type: 'TaskMessageCompleted',
        taskId,
        timestamp: Date.now(),
        messageId: 'M1',
        message: {
          id: 'M1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'ok' }],
        },
      } as unknown as DomainEvent)
    )
    bus.publish(
      envelope(taskId, seq++, {
        type: 'TaskCompleted',
        taskId,
        timestamp: Date.now(),
      } as DomainEvent)
    )

    const events = await eventsPromise
    const types = events.map((e) => e.type)
    expect(types[types.length - 1]).toBe('RUN_FINISHED')
    expect(types.lastIndexOf('TEXT_MESSAGE_END')).toBeLessThan(types.indexOf('RUN_FINISHED'))
    expect(sink.entries.some((e) => e.level === 'error')).toBe(false)
  })

  it('I2 失败路径：TEXT_MESSAGE_END 出现在 RUN_ERROR 之前，记录 error 日志', async () => {
    const { bus, sink, taskId, eventsPromise } = bootstrapRun()
    let seq = 1
    bus.publish(
      envelope(taskId, seq++, {
        type: 'TaskStarted',
        taskId,
        timestamp: Date.now(),
      } as DomainEvent)
    )
    bus.publish(
      envelope(taskId, seq++, {
        type: 'TaskMessageStarted',
        taskId,
        timestamp: Date.now(),
        messageId: 'M1',
        role: 'assistant',
      } as DomainEvent)
    )
    bus.publish(
      envelope(taskId, seq++, {
        type: 'TaskFailed',
        taskId,
        timestamp: Date.now(),
        error: { code: 'BOOM', message: 'boom' },
      } as unknown as DomainEvent)
    )

    const events = await eventsPromise
    const types = events.map((e) => e.type)
    expect(types).toContain('TEXT_MESSAGE_END')
    expect(types).toContain('RUN_ERROR')
    expect(types.indexOf('TEXT_MESSAGE_END')).toBeLessThan(types.indexOf('RUN_ERROR'))
    expect(sink.entries.some((e) => e.level === 'error')).toBe(true)
  })

  it('I3 取消路径含 thinking：REASONING_END 与 TEXT_MESSAGE_END 均在 RUN_FINISHED 之前', async () => {
    const { bus, sink, taskId, eventsPromise } = bootstrapRun()
    let seq = 1
    bus.publish(
      envelope(taskId, seq++, {
        type: 'TaskStarted',
        taskId,
        timestamp: Date.now(),
      } as DomainEvent)
    )
    bus.publish(
      envelope(taskId, seq++, {
        type: 'TaskMessageStarted',
        taskId,
        timestamp: Date.now(),
        messageId: 'M1',
        role: 'assistant',
      } as DomainEvent)
    )
    bus.publish(
      envelope(taskId, seq++, {
        type: 'TaskMessageDelta',
        taskId,
        timestamp: Date.now(),
        messageId: 'M1',
        sequence: 1,
        channel: 'thinking',
        payload: { content: '...' },
      } as DomainEvent)
    )
    bus.publish(
      envelope(taskId, seq++, {
        type: 'TaskCancelled',
        taskId,
        timestamp: Date.now(),
      } as DomainEvent)
    )

    const events = await eventsPromise
    const types = events.map((e) => e.type)
    const finishedIdx = types.indexOf('RUN_FINISHED')
    expect(finishedIdx).toBeGreaterThan(-1)
    expect(types.indexOf('REASONING_END')).toBeLessThan(finishedIdx)
    expect(types.indexOf('TEXT_MESSAGE_END')).toBeLessThan(finishedIdx)
    expect(sink.entries.some((e) => e.level === 'error')).toBe(true)
  })

  it('I4 空内容 TaskCompleted：兜底文本 START/CONTENT/END 齐全，gate 无泄漏', async () => {
    const { bus, sink, taskId, eventsPromise } = bootstrapRun()
    let seq = 1
    bus.publish(
      envelope(taskId, seq++, {
        type: 'TaskStarted',
        taskId,
        timestamp: Date.now(),
      } as DomainEvent)
    )
    bus.publish(
      envelope(taskId, seq++, {
        type: 'TaskCompleted',
        taskId,
        timestamp: Date.now(),
      } as DomainEvent)
    )

    const events = await eventsPromise
    const types = events.map((e) => e.type)
    expect(types).toContain('TEXT_MESSAGE_START')
    expect(types).toContain('TEXT_MESSAGE_CONTENT')
    expect(types).toContain('TEXT_MESSAGE_END')
    expect(types[types.length - 1]).toBe('RUN_FINISHED')
    expect(sink.entries.some((e) => e.level === 'error')).toBe(false)
  })
})
