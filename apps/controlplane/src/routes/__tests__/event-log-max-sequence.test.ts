import { createMemorySink, createObserverLogger } from '@tianji/observer'
import type { DomainEventEnvelope } from '@tianji/shared'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'

import { type ControlPlaneDb, createDatabase } from '../../db/index.js'
import { generateAccessToken, hashToken } from '../../services/auth.js'
import { SqliteEventLogStore } from '../../storage/event-log-sqlite.js'
import { createEventLogMaxSequenceRoute } from '../event-log-max-sequence.js'

function makeEnvelope(sequence: number): DomainEventEnvelope {
  return {
    eventId: crypto.randomUUID(),
    type: 'TaskStarted',
    occurredAt: new Date().toISOString(),
    correlationId: crypto.randomUUID(),
    causationId: null,
    sequence,
    aggregateType: 'Task',
    aggregateId: 'task-1',
    source: { processKind: 'node', processId: 'p1', nodeId: 'n1' },
    payload: {} as never,
  }
}

describe('GET /api/event-log/max-sequence', () => {
  let db: ControlPlaneDb
  let token: string

  beforeEach(() => {
    db = createDatabase(':memory:')
    token = generateAccessToken()
    const tokenHash = hashToken(token)
    const now = Date.now()

    db.raw.prepare('INSERT INTO enrollment_tokens (token, created_at) VALUES (?, ?)').run('et', now)
    db.raw
      .prepare(
        `INSERT INTO nodes (
          node_id, hostname, platform, version, access_token_hash, access_token_expires_at, enrollment_token, created_at, updated_at
        ) VALUES ('n1', 'h', 'linux', '1', ?, ?, 'et', ?, ?)`
      )
      .run(tokenHash, now + 999999, now, now)
  })

  it('returns max sequence for an aggregate', async () => {
    const sink = createMemorySink()
    const logger = createObserverLogger({ sinks: [sink] })
    const store = new SqliteEventLogStore(db.raw)
    await store.append([makeEnvelope(1), makeEnvelope(2), makeEnvelope(3)])

    const app = new Hono()
    app.route('/', createEventLogMaxSequenceRoute(db, logger, store))

    const response = await app.request(
      'http://localhost/api/event-log/max-sequence?aggregateType=Task&aggregateId=task-1',
      {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      }
    )

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ maxSequence: 3 })
  })
})
