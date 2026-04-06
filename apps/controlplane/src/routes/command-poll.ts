import type { ObserverLogger } from '@tianji/observer'
import { Hono } from 'hono'

import type { ControlPlaneDb } from '../db/index.js'
import { createAuthMiddleware } from '../middleware/auth.js'

type AuthVariables = {
  Variables: {
    nodeId: string
  }
}

/**
 * 创建长轮询取指令路由。
 *
 * @param db - controlplane 数据库实例
 * @param logger - 结构化日志实例
 */
export function createCommandPollRoute(
  db: ControlPlaneDb,
  logger: ObserverLogger
): Hono<AuthVariables> {
  const app = new Hono<AuthVariables>()
  const auth = createAuthMiddleware(db, logger)

  app.get('/api/nodes/:nodeId/commands/poll', auth, async (c) => {
    const nodeId = c.req.param('nodeId')
    const authenticatedNodeId = c.get('nodeId')

    if (nodeId !== authenticatedNodeId) {
      return c.json({ error: 'Node ID mismatch' }, 403)
    }

    const timeout = Math.min(Number(c.req.query('timeout') ?? 30000), 60000)

    if (!isNodeBusy(db, nodeId)) {
      const command = tryLeasePendingCommand(db, nodeId)
      if (command !== null) {
        return c.json(command)
      }
    }

    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      if (c.req.raw.signal.aborted) {
        return c.body(null, 204)
      }

      await new Promise((resolve) => setTimeout(resolve, 1000))

      if (c.req.raw.signal.aborted) {
        return c.body(null, 204)
      }

      if (!isNodeBusy(db, nodeId)) {
        const nextCommand = tryLeasePendingCommand(db, nodeId)
        if (nextCommand !== null) {
          return c.json(nextCommand)
        }
      }
    }

    return c.body(null, 204)
  })

  return app
}

function isNodeBusy(db: ControlPlaneDb, nodeId: string): boolean {
  const node = db.raw.prepare('SELECT execution_state FROM nodes WHERE node_id = ?').get(nodeId) as
    | { execution_state: string }
    | undefined
  return node?.execution_state === 'busy'
}

function tryLeasePendingCommand(
  db: ControlPlaneDb,
  nodeId: string
): { commandId: string; type: string; payload: unknown } | null {
  const row = db.raw
    .prepare(
      `SELECT command_id, type, payload FROM commands
       WHERE node_id = ? AND state = 'pending'
       ORDER BY created_at ASC
       LIMIT 1`
    )
    .get(nodeId) as { command_id: string; type: string; payload: string } | undefined

  if (row === undefined) {
    return null
  }

  const now = Date.now()
  const result = db.raw
    .prepare(
      `UPDATE commands SET state = 'leased', leased_at = ?
       WHERE command_id = ? AND state = 'pending'`
    )
    .run(now, row.command_id)

  if (result.changes === 0) {
    return null
  }

  db.raw
    .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE command_id = ?')
    .run('running', now, row.command_id)

  return {
    commandId: row.command_id,
    type: row.type,
    payload: JSON.parse(row.payload),
  }
}
