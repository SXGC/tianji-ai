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

  it('收到 task.started 后，运行流中只会出现一个 RUN_STARTED', async () => {
    db = createDatabase(':memory:')
    setupOnlineNode('node-1')

    const agent = new TianjiAgent(db, 'node-1', 'agent-1')

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

    await new Promise((resolve) => setTimeout(resolve, 50))

    const taskRow = db.raw
      .prepare('SELECT task_id FROM tasks ORDER BY created_at DESC LIMIT 1')
      .get() as { task_id: string } | undefined

    expect(taskRow).toBeDefined()

    const taskId = taskRow!.task_id
    const now = Date.now()

    db.raw
      .prepare(
        'INSERT INTO task_events (task_id, sequence, kind, payload, received_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(
        taskId,
        1,
        'lifecycle',
        JSON.stringify({
          kind: 'lifecycle',
          taskId,
          type: 'task.started',
          sequence: 1,
          timestamp: now,
        }),
        now
      )

    db.raw
      .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?')
      .run('completed', now + 1, taskId)

    db.raw
      .prepare(
        'INSERT INTO task_events (task_id, sequence, kind, payload, received_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(
        taskId,
        2,
        'lifecycle',
        JSON.stringify({
          kind: 'lifecycle',
          taskId,
          type: 'task.completed',
          sequence: 2,
          timestamp: now + 1,
        }),
        now + 1
      )

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
