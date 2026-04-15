import type { ObserverLogger } from '@tianji/observer'
import type {
  AgentInfo,
  DomainEvent,
  NodeRegisterRequest,
  NodeRegisterResponse,
} from '@tianji/shared'
import { Hono } from 'hono'

import type { ControlPlaneDb } from '../db/index.js'
import { ACCESS_TOKEN_TTL_MS, generateAccessToken, hashToken } from '../services/auth.js'

const SCOPE_REGISTER = ['controlplane', 'register'] as const

/**
 * 创建 node 注册路由。
 *
 * @param db - controlplane 数据库实例
 * @param logger - 结构化日志实例
 * @param emitEvent - 可选：DomainEvent 发射回调，用于发射 Node 生命周期事件
 */
export function createNodeRegisterRoute(
  db: ControlPlaneDb,
  logger: ObserverLogger,
  emitEvent?: (ev: DomainEvent) => void | Promise<void>
): Hono {
  const app = new Hono()

  app.post('/api/nodes/register', async (c) => {
    const body = (await c.req.json()) as NodeRegisterRequest // NOSONAR
    const tokenRow = db.raw
      .prepare('SELECT token FROM enrollment_tokens WHERE token = ?')
      .get(body.enrollmentToken)

    if (tokenRow === undefined) {
      await logger.error(SCOPE_REGISTER, 'Registration rejected: invalid enrollment token')
      return c.json({ error: 'Invalid enrollment token' }, 403)
    }

    const accessToken = generateAccessToken()
    const accessTokenHash = hashToken(accessToken)
    const now = Date.now()
    const expiresAt = now + ACCESS_TOKEN_TTL_MS
    const existingNode = db.raw
      .prepare('SELECT node_id FROM nodes WHERE node_id = ?')
      .get(body.nodeId)

    if (existingNode === undefined) {
      db.raw
        .prepare(
          `INSERT INTO nodes (
            node_id, hostname, platform, version, status,
            execution_state, access_token_hash, access_token_expires_at,
            enrollment_token, pid, last_heartbeat_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'online', 'idle', ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          body.nodeId,
          body.hostname,
          body.platform,
          body.version,
          accessTokenHash,
          expiresAt,
          body.enrollmentToken,
          body.pid ?? null,
          now,
          now,
          now
        )
      await logger.info(SCOPE_REGISTER, 'New node registered', {
        nodeId: body.nodeId,
        hostname: body.hostname,
        platform: body.platform,
        pid: body.pid ?? null,
        agentCount: body.agentList.length,
      })
      await emitEvent?.({
        type: 'NodeRegistered',
        nodeId: body.nodeId,
        version: body.version,
        timestamp: now,
      })
    } else {
      db.raw
        .prepare(
          `UPDATE nodes SET
            hostname = ?,
            platform = ?,
            version = ?,
            status = 'online',
            access_token_hash = ?,
            access_token_expires_at = ?,
            pid = ?,
            last_heartbeat_at = ?,
            updated_at = ?
          WHERE node_id = ?`
        )
        .run(
          body.hostname,
          body.platform,
          body.version,
          accessTokenHash,
          expiresAt,
          body.pid ?? null,
          now,
          now,
          body.nodeId
        )
      await logger.info(SCOPE_REGISTER, 'Node re-registered', {
        nodeId: body.nodeId,
        hostname: body.hostname,
        platform: body.platform,
        pid: body.pid ?? null,
        agentCount: body.agentList.length,
      })
      await emitEvent?.({
        type: 'NodeReRegistered',
        nodeId: body.nodeId,
        version: body.version,
        timestamp: now,
      })
    }

    updateAgentList(db, body.nodeId, body.agentList, now)

    const response: NodeRegisterResponse = {
      accessToken,
      expiresAt,
    }

    return c.json(response)
  })

  return app
}

/**
 * 使用全量快照覆盖 node 的 agent 列表。
 */
export function updateAgentList(
  db: ControlPlaneDb,
  nodeId: string,
  agentList: readonly AgentInfo[],
  now: number
): void {
  db.raw.prepare('DELETE FROM agents WHERE node_id = ?').run(nodeId)

  const insert = db.raw.prepare(
    'INSERT INTO agents (node_id, agent_id, type, name, version, updated_at) VALUES (?, ?, ?, ?, ?, ?)'
  )

  for (const agent of agentList) {
    insert.run(nodeId, agent.agentId, agent.type, agent.name, agent.version, now)
  }
}
