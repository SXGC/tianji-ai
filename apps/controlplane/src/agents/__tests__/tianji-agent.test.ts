import type { BaseEvent } from '@ag-ui/client'
import { createMemorySink, createObserverLogger } from '@tianji/observer'
import { createEventBus } from '@tianji/shared'
import { firstValueFrom, toArray } from 'rxjs'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type ControlPlaneDb, createDatabase } from '../../db/index.js'
import { CommandWaiterRegistry } from '../../services/command-waiter-registry.js'
import { TianjiAgent } from '../tianji-agent.js'

/** TianjiAgent 构造必传 logger；测试环境走内存 sink，避免噪声泄漏到 stdout。 */
function makeTestLogger() {
  return createObserverLogger({ sinks: [createMemorySink()] })
}

describe('TianjiAgent', () => {
  let db: ControlPlaneDb

  afterEach(() => {
    db?.close()
  })

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
   * 创建一个带 lagSink 的测试用 EventBus。
   * lagSink 仅记录日志，不影响测试流程。
   */
  function createTestBus() {
    return createEventBus({
      lagSink: (info: unknown) => {
        console.warn('[test-bus] subscriber lag', info)
      },
      errorSink: () => undefined,
    })
  }

  it('sessionId 来自构造函数，forwardedProps 不含 sessionId 时仍能正常启动', async () => {
    db = createDatabase(':memory:')
    setupOnlineNode('node-1')

    const bus = createTestBus()
    const agent = new TianjiAgent(
      db,
      'node-1',
      'agent-1',
      'session_from_ctor',
      bus,
      makeTestLogger()
    )

    const firstEvent = await firstValueFrom(
      agent.run({
        threadId: 'session_from_ctor',
        runId: 'run_from_ctor',
        messages: [{ id: 'msg-1', role: 'user', content: 'hello' }],
        tools: [],
        context: [],
        forwardedProps: {},
        state: {},
      })
    )

    expect(firstEvent).toMatchObject({ type: 'RUN_STARTED', threadId: 'session_from_ctor' })
  })

  it('clone 后仍保留运行所需的节点和代理信息', async () => {
    db = createDatabase(':memory:')
    setupOnlineNode('node-1')

    const bus = createTestBus()
    const agent = new TianjiAgent(db, 'node-1', 'agent-1', 'session_clone', bus, makeTestLogger())
    const clonedAgent = agent.clone()

    await expect(
      firstValueFrom(
        clonedAgent.run({
          threadId: 'session_clone',
          runId: 'run_clone',
          messages: [{ id: 'msg-1', role: 'user', content: 'hello' }],
          tools: [],
          context: [],
          forwardedProps: {},
          state: {},
        })
      )
    ).resolves.toMatchObject({
      type: 'RUN_STARTED',
    })
  })

  it('运行流的首个事件是 RUN_STARTED', async () => {
    db = createDatabase(':memory:')
    setupOnlineNode('node-1')

    const bus = createTestBus()
    const agent = new TianjiAgent(
      db,
      'node-1',
      'agent-1',
      'session_run_started',
      bus,
      makeTestLogger()
    )

    const firstEvent = await firstValueFrom(
      agent.run({
        threadId: 'session_run_started',
        runId: 'run_run_started',
        messages: [{ id: 'msg-1', role: 'user', content: 'hello' }],
        tools: [],
        context: [],
        forwardedProps: { sessionId: 'session_run_started' },
        state: {},
      })
    )

    expect(firstEvent).toMatchObject({
      type: 'RUN_STARTED',
      threadId: 'session_run_started',
    })
  })

  it('uses sessionId from constructor as AG-UI threadId', async () => {
    db = createDatabase(':memory:')
    setupOnlineNode('node-1')

    const bus = createTestBus()
    const agent = new TianjiAgent(db, 'node-1', 'agent-1', 'session_123', bus, makeTestLogger())

    const firstEvent = await firstValueFrom(
      agent.run({
        threadId: 'session_123',
        runId: 'run_session_123',
        messages: [{ id: 'msg-1', role: 'user', content: 'hello' }],
        tools: [],
        context: [],
        forwardedProps: { sessionId: 'session_123' },
        state: {},
      })
    )

    expect(firstEvent).toMatchObject({ type: 'RUN_STARTED', threadId: 'session_123' })
  })

  it('writes sessionIds into command payload', async () => {
    db = createDatabase(':memory:')
    setupOnlineNode('node-1')

    const bus = createTestBus()
    const agent = new TianjiAgent(db, 'node-1', 'agent-1', 'session_payload', bus, makeTestLogger())

    await firstValueFrom(
      agent.run({
        threadId: 'session_payload',
        runId: 'run_session_payload',
        messages: [{ id: 'msg-1', role: 'user', content: 'hello' }],
        tools: [],
        context: [],
        forwardedProps: { sessionId: 'session_payload' },
        state: {},
      })
    )

    const commandRow = db.raw
      .prepare('SELECT payload FROM commands ORDER BY created_at DESC LIMIT 1')
      .get() as { payload: string } | undefined

    expect(commandRow).toBeDefined()
    expect(JSON.parse(commandRow!.payload)).toMatchObject({
      sessionIds: ['session_payload'],
    })
  })

  it('writes nodeId and agentId into command payload owner fields', async () => {
    db = createDatabase(':memory:')
    setupOnlineNode('node-1')

    const bus = createTestBus()
    const agent = new TianjiAgent(db, 'node-1', 'agent-1', 'session_owner', bus, makeTestLogger())

    await firstValueFrom(
      agent.run({
        threadId: 'session_owner',
        runId: 'run_session_owner',
        messages: [{ id: 'msg-1', role: 'user', content: 'hello' }],
        tools: [],
        context: [],
        forwardedProps: {
          sessionId: 'session_owner',
          owner: { nodeId: 'node-1', agentId: 'agent-1' },
        },
        state: {},
      })
    )

    const commandRow = db.raw
      .prepare('SELECT payload FROM commands ORDER BY created_at DESC LIMIT 1')
      .get() as { payload: string } | undefined

    expect(commandRow).toBeDefined()
    expect(JSON.parse(commandRow!.payload)).toMatchObject({
      sessionIds: ['session_owner'],
      owner: { nodeId: 'node-1', agentId: 'agent-1' },
    })
  })

  it('run 在 notify waiter registry 时，对应 task 行已落库', async () => {
    db = createDatabase(':memory:')
    setupOnlineNode('node-1')

    const registry = new CommandWaiterRegistry()
    const notifySpy = vi.spyOn(registry, 'notify').mockImplementation((nodeId: string) => {
      const row = db.raw
        .prepare(
          `SELECT t.task_id
           FROM tasks t
           INNER JOIN commands c ON c.command_id = t.command_id
           WHERE c.node_id = ?
             AND c.type = 'task.run'
           LIMIT 1`
        )
        .get(nodeId) as { task_id: string } | undefined
      expect(row).toBeDefined()
    })
    const agent = new TianjiAgent(
      db,
      'node-1',
      'agent-1',
      createTestBus(),
      makeTestLogger(),
      registry
    )

    await firstValueFrom(
      agent.run({
        threadId: 'session_notify',
        runId: 'run_notify',
        messages: [{ id: 'msg-1', role: 'user', content: 'hello' }],
        tools: [],
        context: [],
        forwardedProps: { sessionId: 'session_notify' },
        state: {},
      })
    )

    expect(notifySpy).toHaveBeenCalledTimes(1)
    expect(notifySpy).toHaveBeenCalledWith('node-1')
  })

  it('任务终态后运行流中只出现一个 RUN_STARTED', async () => {
    db = createDatabase(':memory:')
    setupOnlineNode('node-1')

    const bus = createTestBus()
    const agent = new TianjiAgent(
      db,
      'node-1',
      'agent-1',
      'session_terminal',
      bus,
      makeTestLogger()
    )

    const completion = firstValueFrom(
      agent
        .run({
          threadId: 'session_terminal',
          runId: 'run_terminal',
          messages: [{ id: 'msg-1', role: 'user', content: 'hello' }],
          tools: [],
          context: [],
          forwardedProps: { sessionId: 'session_terminal' },
          state: {},
        })
        .pipe(toArray())
    )

    // 等待 task 记录写入
    await new Promise((resolve) => setTimeout(resolve, 50))

    const taskRow = db.raw
      .prepare('SELECT task_id FROM tasks ORDER BY created_at DESC LIMIT 1')
      .get() as { task_id: string } | undefined

    expect(taskRow).toBeDefined()
    const taskId = taskRow!.task_id

    // 通过 bus 发布 TaskCompleted 终态事件
    bus.publish({
      eventId: 'evt-1',
      type: 'TaskCompleted',
      occurredAt: new Date().toISOString(),
      correlationId: 'corr-1',
      causationId: null,
      sequence: 1,
      aggregateType: 'Task',
      aggregateId: taskId,
      source: { processKind: 'node', processId: 'node-proc-1', nodeId: 'node-1' },
      payload: { type: 'TaskCompleted', taskId, timestamp: Date.now() },
    })

    const events = await completion
    const startedEvents = events.filter((event) => event.type === 'RUN_STARTED')

    expect(startedEvents).toHaveLength(1)
  })

  it('节点不存在时首个运行事件仍然是 RUN_STARTED，随后才是 RUN_ERROR', async () => {
    db = createDatabase(':memory:')

    const agent = new TianjiAgent(
      db,
      'missing-node',
      'agent-1',
      'session_missing_node',
      undefined,
      makeTestLogger()
    )

    const events = await firstValueFrom(
      agent
        .run({
          threadId: 'session_missing_node',
          runId: 'run_missing_node',
          messages: [{ id: 'msg-1', role: 'user', content: 'hello' }],
          tools: [],
          context: [],
          forwardedProps: { sessionId: 'session_missing_node' },
          state: {},
        })
        .pipe(toArray())
    )

    const runEvents = events.filter((event) => event.type !== 'STATE_SNAPSHOT')

    expect(runEvents[0]).toMatchObject({ type: 'RUN_STARTED' })
    expect(runEvents[1]).toMatchObject({ type: 'RUN_ERROR', message: 'Node not found' })
  })

  it('节点离线时首个运行事件仍然是 RUN_STARTED，随后才是 RUN_ERROR', async () => {
    db = createDatabase(':memory:')
    setupOnlineNode('node-1')
    db.raw.prepare('UPDATE nodes SET status = ? WHERE node_id = ?').run('offline', 'node-1')

    const agent = new TianjiAgent(
      db,
      'node-1',
      'agent-1',
      'session_offline_node',
      undefined,
      makeTestLogger()
    )

    const events = await firstValueFrom(
      agent
        .run({
          threadId: 'session_offline_node',
          runId: 'run_offline_node',
          messages: [{ id: 'msg-1', role: 'user', content: 'hello' }],
          tools: [],
          context: [],
          forwardedProps: { sessionId: 'session_offline_node' },
          state: {},
        })
        .pipe(toArray())
    )

    const runEvents = events.filter((event) => event.type !== 'STATE_SNAPSHOT')

    expect(runEvents[0]).toMatchObject({ type: 'RUN_STARTED' })
    expect(runEvents[1]).toMatchObject({ type: 'RUN_ERROR', message: 'Node is offline' })
  })

  function setupRunningTask(nodeId: string, taskId: string, agentId = 'agent-1') {
    const now = Date.now()
    const commandId = `cmd-${taskId}`
    db.raw
      .prepare(
        `INSERT INTO commands (command_id, node_id, type, payload, state, created_at)
         VALUES (?, ?, 'task.run', '{}', 'leased', ?)`
      )
      .run(commandId, nodeId, now)
    db.raw
      .prepare(
        `INSERT INTO tasks (task_id, command_id, node_id, agent_id, goal, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'test', 'running', ?, ?)`
      )
      .run(taskId, commandId, nodeId, agentId, now, now)
  }

  it('结构化用户消息会被提取为发送给节点的纯文本 goal', async () => {
    db = createDatabase(':memory:')
    setupOnlineNode('node-1')

    const agent = new TianjiAgent(
      db,
      'node-1',
      'agent-1',
      'session_payload',
      undefined,
      makeTestLogger()
    )

    await firstValueFrom(
      agent.run({
        threadId: 'session_payload',
        runId: 'run_payload',
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            content: [
              { type: 'text', text: '第一段输入' },
              { type: 'text', text: '第二段输入' },
            ],
          },
        ],
        tools: [],
        context: [],
        forwardedProps: { sessionId: 'session_payload' },
        state: {},
      })
    )

    const commandRow = db.raw
      .prepare('SELECT payload FROM commands ORDER BY created_at DESC LIMIT 1')
      .get() as { payload: string } | undefined

    expect(commandRow).toBeDefined()
    expect(JSON.parse(commandRow!.payload)).toMatchObject({
      goal: '第一段输入\n第二段输入',
    })
  })
})

describe('TianjiAgent.cancelTask', () => {
  let db: ControlPlaneDb

  afterEach(() => {
    db?.close()
  })

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

  function setupRunningTask(nodeId: string, taskId: string, agentId = 'agent-1') {
    const now = Date.now()
    const commandId = `cmd-${taskId}`
    db.raw
      .prepare(
        `INSERT INTO commands (command_id, node_id, type, payload, state, created_at)
         VALUES (?, ?, 'task.run', '{}', 'leased', ?)`
      )
      .run(commandId, nodeId, now)
    db.raw
      .prepare(
        `INSERT INTO tasks (task_id, command_id, node_id, agent_id, goal, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'test', 'running', ?, ?)`
      )
      .run(taskId, commandId, nodeId, agentId, now, now)
  }

  it('插入 task.cancel 命令行，字段正确', async () => {
    db = createDatabase(':memory:')
    setupOnlineNode('node-1')
    setupRunningTask('node-1', 'task-1', 'agent-1')
    const agent = new TianjiAgent(db, 'node-1', 'agent-1', '', undefined, makeTestLogger())

    await agent.cancelTask('task-1')

    const rows = db.raw
      .prepare("SELECT * FROM commands WHERE type = 'task.cancel'")
      .all() as Array<{
      command_id: string
      node_id: string
      type: string
      payload: string
      state: string
      created_at: number
    }>
    expect(rows).toHaveLength(1)
    expect(rows[0].node_id).toBe('node-1')
    expect(rows[0].state).toBe('pending')
    expect(JSON.parse(rows[0].payload)).toEqual({ taskId: 'task-1', reason: 'user' })
  })

  it('从 tasks 表反查 nodeId，不依赖 agent 构造时的 nodeId', async () => {
    db = createDatabase(':memory:')
    setupOnlineNode('node-target')
    setupOnlineNode('node-other')
    setupRunningTask('node-target', 'task-x', 'agent-1')
    // 构造时故意传 'node-other'，验证 cancelTask 用 tasks.node_id 而非构造时的 #nodeId
    const agent = new TianjiAgent(db, 'node-other', 'agent-1', '', undefined, makeTestLogger())

    await agent.cancelTask('task-x')

    const row = db.raw.prepare("SELECT node_id FROM commands WHERE type = 'task.cancel'").get() as {
      node_id: string
    }
    expect(row.node_id).toBe('node-target')
  })

  it('插入 task.cancel 命令后通知 task 所在 node', async () => {
    db = createDatabase(':memory:')
    setupOnlineNode('node-target')
    setupOnlineNode('node-other')
    setupRunningTask('node-target', 'task-notify', 'agent-1')
    const registry = new CommandWaiterRegistry()
    const notifySpy = vi.spyOn(registry, 'notify')
    const agent = new TianjiAgent(
      db,
      'node-other',
      'agent-1',
      undefined,
      makeTestLogger(),
      registry
    )

    await agent.cancelTask('task-notify')

    expect(notifySpy).toHaveBeenCalledTimes(1)
    expect(notifySpy).toHaveBeenCalledWith('node-target')
  })

  it('不存在的 taskId 抛错', async () => {
    db = createDatabase(':memory:')
    setupOnlineNode('node-1')
    const agent = new TianjiAgent(db, 'node-1', 'agent-1', '', undefined, makeTestLogger())

    await expect(agent.cancelTask('ghost-task')).rejects.toThrow(/not found/i)
  })
})

describe('TianjiAgent cancel 终态', () => {
  let db: ControlPlaneDb

  afterEach(() => {
    db?.close()
  })

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

  function createTestBus() {
    return createEventBus({
      lagSink: (info: unknown) => {
        console.warn('[test-bus] subscriber lag', info)
      },
      errorSink: () => undefined,
    })
  }

  it('TaskCancelled envelope 到达后，订阅者收到 RUN_FINISHED（而非 RUN_ERROR）', async () => {
    db = createDatabase(':memory:')
    setupOnlineNode('node-1')
    const bus = createTestBus()
    const agent = new TianjiAgent(
      db,
      'node-1',
      'agent-1',
      'session_cancel_1',
      bus,
      makeTestLogger()
    )

    const events: BaseEvent[] = []
    const subscription = agent
      .run({
        threadId: 'session_cancel_1',
        runId: 'run-cancel-1',
        messages: [{ id: 'm-cancel', role: 'user', content: 'hi' }],
        tools: [],
        context: [],
        forwardedProps: { sessionId: 'session_cancel_1' },
        state: {},
      })
      .subscribe((e) => events.push(e))

    // 等待 task 记录写入 DB
    await new Promise((resolve) => setTimeout(resolve, 50))

    const taskRow = db.raw
      .prepare('SELECT task_id FROM tasks ORDER BY created_at DESC LIMIT 1')
      .get() as { task_id: string } | undefined

    expect(taskRow).toBeDefined()
    const taskId = taskRow!.task_id

    // 通过 bus 发 TaskCancelled envelope
    bus.publish({
      eventId: 'evt-cancel-1',
      type: 'TaskCancelled',
      occurredAt: new Date().toISOString(),
      correlationId: 'corr-cancel-1',
      causationId: null,
      sequence: 1,
      aggregateType: 'Task',
      aggregateId: taskId,
      source: { processKind: 'node', processId: 'node-proc-1', nodeId: 'node-1' },
      payload: { type: 'TaskCancelled', taskId, timestamp: Date.now() },
    })

    // 等待 Observable 完成
    await new Promise((resolve) => setTimeout(resolve, 50))
    subscription.unsubscribe()

    expect(events.some((e) => e.type === 'RUN_FINISHED')).toBe(true)
    expect(events.some((e) => e.type === 'RUN_ERROR')).toBe(false)
  })

  it('TaskCancelled 产出的 RUN_FINISHED 携带正确的 threadId 和 runId', async () => {
    db = createDatabase(':memory:')
    setupOnlineNode('node-1')
    const bus = createTestBus()
    const agent = new TianjiAgent(
      db,
      'node-1',
      'agent-1',
      'session_cancel_2',
      bus,
      makeTestLogger()
    )

    const events: BaseEvent[] = []
    const subscription = agent
      .run({
        threadId: 'session_cancel_2',
        runId: 'run-cancel-2',
        messages: [{ id: 'm-cancel-2', role: 'user', content: 'bye' }],
        tools: [],
        context: [],
        forwardedProps: { sessionId: 'session_cancel_2' },
        state: {},
      })
      .subscribe((e) => events.push(e))

    await new Promise((resolve) => setTimeout(resolve, 50))

    const taskRow = db.raw
      .prepare('SELECT task_id FROM tasks ORDER BY created_at DESC LIMIT 1')
      .get() as { task_id: string } | undefined

    expect(taskRow).toBeDefined()
    const taskId = taskRow!.task_id

    bus.publish({
      eventId: 'evt-cancel-2',
      type: 'TaskCancelled',
      occurredAt: new Date().toISOString(),
      correlationId: 'corr-cancel-2',
      causationId: null,
      sequence: 1,
      aggregateType: 'Task',
      aggregateId: taskId,
      source: { processKind: 'node', processId: 'node-proc-1', nodeId: 'node-1' },
      payload: { type: 'TaskCancelled', taskId, timestamp: Date.now() },
    })

    await new Promise((resolve) => setTimeout(resolve, 50))
    subscription.unsubscribe()

    const runFinished = events.find((e) => e.type === 'RUN_FINISHED') as
      | (BaseEvent & { threadId: string; runId: string; reason?: string })
      | undefined

    expect(runFinished).toBeDefined()
    expect(runFinished!.threadId).toBe('session_cancel_2')
    expect(runFinished!.runId).toBe('run-cancel-2')
    expect(runFinished!.reason).toBe('cancelled')
  })
})
