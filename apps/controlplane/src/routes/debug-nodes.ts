import { Hono } from 'hono'

import type { ControlPlaneDb } from '../db/index.js'
import { HEARTBEAT_TIMEOUT_MS } from './node-heartbeat.js'

interface NodeRow {
  node_id: string
  hostname: string
  platform: string
  version: string
  execution_state: string
  last_heartbeat_at: number | null
  created_at: number
}

interface AgentRow {
  agent_id: string
  type: string
  name: string
  version: string
}

/**
 * Debug 专用的节点列表：相比 /api/ui/nodes，额外返回 registeredAt 与 ISO 化的 heartbeat 时间，
 * 方便运维人员在 UI 上直接读取。
 */
export function createDebugNodesRoute(db: ControlPlaneDb): Hono {
  const app = new Hono()

  app.get('/api/debug/nodes', (c) => {
    const now = Date.now()
    const rows = db.raw.prepare('SELECT * FROM nodes').all() as NodeRow[]
    const nodes = rows.map((n) => {
      const status =
        n.last_heartbeat_at !== null && now - n.last_heartbeat_at < HEARTBEAT_TIMEOUT_MS
          ? 'online'
          : 'offline'
      const agents = db.raw
        .prepare('SELECT agent_id, type, name, version FROM agents WHERE node_id = ?')
        .all(n.node_id) as AgentRow[]
      return {
        nodeId: n.node_id,
        hostname: n.hostname,
        platform: n.platform,
        version: n.version,
        status,
        executionState: n.execution_state,
        lastHeartbeatAt:
          n.last_heartbeat_at !== null ? new Date(n.last_heartbeat_at).toISOString() : null,
        registeredAt: new Date(n.created_at).toISOString(),
        agents: agents.map((a) => ({
          agentId: a.agent_id,
          type: a.type,
          name: a.name,
          version: a.version,
        })),
      }
    })
    return c.json({ nodes })
  })

  return app
}
