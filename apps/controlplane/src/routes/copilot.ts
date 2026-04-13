/**
 * CopilotKit runtime 路由
 *
 * 为每个请求创建独立的 CopilotRuntime 和 TianjiAgent 实例，
 * 验证请求头和节点状态后，将请求代理给 CopilotKit HTTP handler。
 *
 * @module routes/copilot
 */
import { CopilotRuntime, copilotRuntimeNodeHttpEndpoint } from '@copilotkit/runtime'
import { Hono } from 'hono'

import { TianjiAgent } from '../agents/tianji-agent.js'
import type { ControlPlaneDb } from '../db/index.js'

/**
 * 创建 CopilotKit runtime Hono 路由。
 *
 * 每个 POST /api/copilot 请求都需要携带：
 * - `x-node-id`：目标节点 ID（非空）
 * - `x-agent-id`：代理 ID（非空）
 *
 * 节点必须存在且处于 online 状态，否则返回对应错误码。
 *
 * @param db - ControlPlane 数据库实例
 * @returns 已配置 /api/copilot 端点的 Hono 应用实例
 */
export function createCopilotRoute(db: ControlPlaneDb): Hono {
  const app = new Hono()

  app.post('/api/copilot', async (c) => {
    const nodeId = c.req.header('x-node-id')
    const agentId = c.req.header('x-agent-id')

    if (!nodeId || !agentId) {
      return c.json({ error: 'Missing x-node-id or x-agent-id header' }, 400)
    }

    const node = db.raw.prepare('SELECT status FROM nodes WHERE node_id = ?').get(nodeId) as
      | { status: string }
      | undefined

    if (node === undefined) {
      return c.json({ error: 'Node not found' }, 404)
    }
    if (node.status === 'offline') {
      return c.json({ error: 'Node is offline' }, 409)
    }

    const agent = new TianjiAgent(db, nodeId, agentId)
    const runtime = new CopilotRuntime({
      agents: { default: agent },
    })

    const handler = copilotRuntimeNodeHttpEndpoint({
      runtime,
      endpoint: '/api/copilot',
    })

    return handler(c.req.raw) as Promise<Response>
  })

  return app
}
