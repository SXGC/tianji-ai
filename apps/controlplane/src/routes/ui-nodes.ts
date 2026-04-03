import { Hono } from 'hono'

import type { ControlPlaneDb } from '../db/index.js'
import { HEARTBEAT_TIMEOUT_MS } from './node-heartbeat.js'

type AgentRow = {
  agent_id: string
  type: string
  name: string
  version: string
}

type NodeRow = {
  node_id: string
  hostname: string
  platform: string
  version: string
  execution_state: string
  last_heartbeat_at: number | null
}

/**
 * 创建 UI 节点列表路由。
 */
export function createUiNodesRoute(db: ControlPlaneDb): Hono {
  const app = new Hono()

  app.get('/api/ui/nodes', (c) => {
    const now = Date.now()
    const nodes = db.raw.prepare('SELECT * FROM nodes').all() as NodeRow[]

    return c.json(
      nodes.map((node) => {
        const status =
          node.last_heartbeat_at !== null && now - node.last_heartbeat_at < HEARTBEAT_TIMEOUT_MS
            ? 'online'
            : 'offline'

        const agents = db.raw
          .prepare('SELECT agent_id, type, name, version FROM agents WHERE node_id = ?')
          .all(node.node_id) as AgentRow[]

        return {
          nodeId: node.node_id,
          hostname: node.hostname,
          platform: node.platform,
          version: node.version,
          status,
          executionState: node.execution_state,
          lastHeartbeatAt: node.last_heartbeat_at,
          agents: agents.map((agent) => ({
            agentId: agent.agent_id,
            type: agent.type,
            name: agent.name,
            version: agent.version,
          })),
        }
      })
    )
  })

  return app
}
