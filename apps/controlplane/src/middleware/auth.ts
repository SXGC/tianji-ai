import type { ObserverLogger } from '@tianji/observer'
import type { Context, Next } from 'hono'

import type { ControlPlaneDb } from '../db/index.js'
import { hashToken } from '../services/auth.js'

const SCOPE_AUTH = ['controlplane', 'auth'] as const

/**
 * 创建 Bearer token 认证中间件。
 *
 * @param db - controlplane 数据库实例
 * @param logger - 结构化日志实例
 */
export function createAuthMiddleware(db: ControlPlaneDb, logger: ObserverLogger) {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
      await logger.warn(SCOPE_AUTH, 'Missing authorization header', { path: c.req.path })
      return c.json({ error: 'Missing authorization' }, 401)
    }

    const token = authHeader.slice(7)
    const tokenHash = hashToken(token)
    const now = Date.now()
    const node = db.raw
      .prepare(
        `SELECT node_id FROM nodes
         WHERE access_token_hash = ? AND access_token_expires_at > ?`
      )
      .get(tokenHash, now) as { node_id: string } | undefined

    if (node === undefined) {
      await logger.warn(SCOPE_AUTH, 'Invalid or expired token', { path: c.req.path })
      return c.json({ error: 'Invalid or expired token' }, 401)
    }

    await logger.debug(SCOPE_AUTH, 'Authentication succeeded', { nodeId: node.node_id })
    c.set('nodeId', node.node_id)
    await next()
  }
}
