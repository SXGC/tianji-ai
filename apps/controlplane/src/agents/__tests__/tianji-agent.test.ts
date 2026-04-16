import { createEventBus } from '@tianji/shared'
import { firstValueFrom, toArray } from 'rxjs'
import { afterEach, describe, expect, it } from 'vitest'

import { type ControlPlaneDb, createDatabase } from '../../db/index.js'
import { TianjiAgent } from '../tianji-agent.js'

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
      lagSink: (info) => {
        console.warn('[test-bus] subscriber lag', info)
      },
    })
  }

  it('clone 后仍保留运行所需的节点和代理信息', async () => {
    db = createDatabase(':memory:')
    setupOnlineNode('node-1')

    const agent = new TianjiAgent(db, 'node-1', 'agent-1')
    const clonedAgent = agent.clone()

    await expect(
      firstValueFrom(
        clonedAgent.run({
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

    const agent = new TianjiAgent(db, 'node-1', 'agent-1')

    const firstEvent = await firstValueFrom(
      agent.run({
        messages: [{ id: 'msg-1', role: 'user', content: 'hello' }],
        tools: [],
        context: [],
        forwardedProps: {},
        state: {},
      })
    )

    expect(firstEvent).toMatchObject({ type: 'RUN_STARTED' })
  })

  it('任务终态后运行流中只出现一个 RUN_STARTED', async () => {
    db = createDatabase(':memory:')
    setupOnlineNode('node-1')

    const bus = createTestBus()
    const agent = new TianjiAgent(db, 'node-1', 'agent-1', bus)

    const completion = firstValueFrom(
      agent
        .run({
          messages: [{ id: 'msg-1', role: 'user', content: 'hello' }],
          tools: [],
          context: [],
          forwardedProps: {},
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

    const agent = new TianjiAgent(db, 'missing-node', 'agent-1')

    const events = await firstValueFrom(
      agent
        .run({
          messages: [{ id: 'msg-1', role: 'user', content: 'hello' }],
          tools: [],
          context: [],
          forwardedProps: {},
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

    const agent = new TianjiAgent(db, 'node-1', 'agent-1')

    const events = await firstValueFrom(
      agent
        .run({
          messages: [{ id: 'msg-1', role: 'user', content: 'hello' }],
          tools: [],
          context: [],
          forwardedProps: {},
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

    const agent = new TianjiAgent(db, 'node-1', 'agent-1')

    await firstValueFrom(
      agent.run({
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
        forwardedProps: {},
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
    const agent = new TianjiAgent(db, 'node-1', 'agent-1')

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
    const agent = new TianjiAgent(db, 'node-other', 'agent-1')

    await agent.cancelTask('task-x')

    const row = db.raw.prepare("SELECT node_id FROM commands WHERE type = 'task.cancel'").get() as {
      node_id: string
    }
    expect(row.node_id).toBe('node-target')
  })

  it('不存在的 taskId 抛错', async () => {
    db = createDatabase(':memory:')
    setupOnlineNode('node-1')
    const agent = new TianjiAgent(db, 'node-1', 'agent-1')

    await expect(agent.cancelTask('ghost-task')).rejects.toThrow(/not found/i)
  })
})
