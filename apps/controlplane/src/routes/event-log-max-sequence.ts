import type { ObserverLogger } from '@tianji/observer'
import type { AggregateType, EventLogStore } from '@tianji/shared'
import { Hono } from 'hono'

import type { ControlPlaneDb } from '../db/index.js'
import { createAuthMiddleware } from '../middleware/auth.js'

type AuthVariables = {
  Variables: {
    nodeId: string
  }
}

const AGGREGATE_TYPES: readonly AggregateType[] = ['Session', 'GraphRun', 'Run', 'Task', 'Node']

export function createEventLogMaxSequenceRoute(
  db: ControlPlaneDb,
  logger: ObserverLogger,
  store: EventLogStore
): Hono<AuthVariables> {
  const app = new Hono<AuthVariables>()
  const auth = createAuthMiddleware(db, logger)

  app.get('/api/event-log/max-sequence', auth, async (c) => {
    const aggregateType = c.req.query('aggregateType')
    const aggregateId = c.req.query('aggregateId')

    if (
      aggregateType === undefined ||
      aggregateId === undefined ||
      !AGGREGATE_TYPES.includes(aggregateType as AggregateType)
    ) {
      return c.json({ error: 'Invalid aggregateType or aggregateId' }, 400)
    }

    const maxSequence = await store.maxSequence(aggregateType as AggregateType, aggregateId)
    return c.json({ maxSequence })
  })

  return app
}
