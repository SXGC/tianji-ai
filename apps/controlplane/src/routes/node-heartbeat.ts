import type { ObserverLogger } from '@tianji/observer'
import type { NodeHeartbeatRequest } from '@tianji/shared'
import { Hono } from 'hono'

import type { ControlPlaneDb } from '../db/index.js'
import { createAuthMiddleware } from '../middleware/auth.js'
import { updateAgentList } from './node-register.js'

type AuthVariables = {
  Variables: {
    nodeId: string
  }
}

/** 心跳超时阈值（90s 无心跳标记 offline）。 */
export const HEARTBEAT_TIMEOUT_MS = 90_000

const SCOPE_HEARTBEAT = ['controlplane', 'heartbeat'] as const

/**
 * 创建 node 心跳路由。
 *
 * @param db - controlplane 数据库实例
 * @param logger - 结构化日志实例
 */
export function createNodeHeartbeatRoute(
  db: ControlPlaneDb,
  logger: ObserverLogger
): Hono<AuthVariables> {
  const app = new Hono<AuthVariables>()
  const auth = createAuthMiddleware(db, logger)

  app.post('/api/nodes/:nodeId/heartbeat', auth, async (c) => {
    const nodeId = c.req.param('nodeId')
    const authenticatedNodeId = c.get('nodeId') as string // NOSONAR

    if (nodeId !== authenticatedNodeId) {
      await logger.warn(SCOPE_HEARTBEAT, 'Node ID mismatch', { nodeId, authenticatedNodeId })
      return c.json({ error: 'Node ID mismatch' }, 403)
    }

    const body = (await c.req.json()) as NodeHeartbeatRequest // NOSONAR
    const now = Date.now()

    db.raw
      .prepare(
        `UPDATE nodes SET
          status = 'online',
          execution_state = ?,
          pid = ?,
          last_heartbeat_at = ?,
          updated_at = ?
        WHERE node_id = ?`
      )
      .run(body.executionState, body.pid ?? null, now, now, nodeId)

    if (body.agentList !== undefined) {
      updateAgentList(db, nodeId, body.agentList, now)
    }

    await logger.debug(SCOPE_HEARTBEAT, 'Heartbeat received', {
      nodeId,
      executionState: body.executionState,
      pid: body.pid ?? null,
    })

    return c.body(null, 204)
  })

  return app
}
