import { afterEach, describe, expect, it } from 'vitest'

import { type ControlPlaneDb, createDatabase } from '../../db/index.js'
import { EventStore } from '../event-store.js'

describe('EventStore', () => {
  let db: ControlPlaneDb

  afterEach(() => {
    db?.close()
  })

  function setup() {
    db = createDatabase(':memory:')
    db.raw
      .prepare('INSERT INTO enrollment_tokens (token, created_at) VALUES (?, ?)')
      .run('t', Date.now())
    db.raw
      .prepare(
        `INSERT INTO nodes (
          node_id, hostname, platform, version, access_token_hash, access_token_expires_at, enrollment_token, created_at, updated_at
        ) VALUES ('n', 'h', 'linux', '1', 'hash', 999999999999999, 't', 0, 0)`
      )
      .run()
    db.raw
      .prepare(
        `INSERT INTO commands (command_id, node_id, type, payload, state, created_at)
         VALUES ('cmd-1', 'n', 'task.run', '{}', 'leased', 0)`
      )
      .run()
    db.raw
      .prepare(
        `INSERT INTO tasks (task_id, command_id, node_id, agent_id, goal, status, created_at, updated_at)
         VALUES ('task-1', 'cmd-1', 'n', 'a', 'g', 'running', 0, 0)`
      )
      .run()

    return new EventStore(db)
  }

  it('should insert events', () => {
    const store = setup()

    store.insertEvent('task-1', 1, 'lifecycle', '{"type":"task.started"}')
    store.insertEvent('task-1', 2, 'agent', '{"type":"message.delta"}')

    const events = store.getEvents('task-1', 0, 100)
    expect(events).toHaveLength(2)
  })

  it('should deduplicate by taskId + sequence', () => {
    const store = setup()

    store.insertEvent('task-1', 1, 'lifecycle', '{"type":"task.started"}')
    store.insertEvent('task-1', 1, 'lifecycle', '{"type":"task.started"}')

    const events = store.getEvents('task-1', 0, 100)
    expect(events).toHaveLength(1)
  })

  it('should return events after a given sequence', () => {
    const store = setup()

    store.insertEvent('task-1', 1, 'lifecycle', '{}')
    store.insertEvent('task-1', 2, 'agent', '{}')
    store.insertEvent('task-1', 3, 'agent', '{}')

    const events = store.getEvents('task-1', 1, 100)
    expect(events).toHaveLength(2)
    expect(events[0]!.sequence).toBe(2)
  })

  describe('truncation', () => {
    it('should truncate oldest agent events when total payload exceeds limit', () => {
      setup()
      const smallLimitStore = new EventStore(db, { maxPayloadBytes: 100 })

      smallLimitStore.insertEvent(
        'task-1',
        1,
        'lifecycle',
        JSON.stringify({ type: 'task.started' })
      )

      for (let index = 2; index <= 10; index += 1) {
        smallLimitStore.insertEvent('task-1', index, 'agent', 'x'.repeat(20))
      }

      smallLimitStore.truncateIfNeeded('task-1')

      const events = smallLimitStore.getEvents('task-1', 0, 100)
      const lifecycleEvents = events.filter(
        (event: (typeof events)[number]) => event.kind === 'lifecycle'
      )

      expect(lifecycleEvents).toHaveLength(1)
      expect(lifecycleEvents[0]!.sequence).toBe(1)
    })
  })
})
