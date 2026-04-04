import type { Context, Next } from 'hono'

import type { ControlPlaneDb } from '../db/index.js'
import { hashToken } from '../services/auth.js'

/**
 * 创建 Bearer token 认证中间件。
 */
export function createAuthMiddleware(db: ControlPlaneDb) {
  return async (c: Context, next: Next) => {
    const authHeader = c.req.header('Authorization')
    if (!authHeader?.startsWith('Bearer ')) {
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
      return c.json({ error: 'Invalid or expired token' }, 401)
    }

    c.set('nodeId', node.node_id)
    await next()
  }
}
