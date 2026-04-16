/**
 * CopilotKit runtime 路由
 *
 * 为每个请求创建独立的 CopilotRuntime 和 TianjiAgent 实例，
 * 验证请求头和节点状态后，将请求代理给 CopilotKit HTTP handler。
 *
 * @module routes/copilot
 */
import { CopilotRuntime, copilotRuntimeNodeHttpEndpoint } from '@copilotkit/runtime'
import type { EventBus } from '@tianji/shared'
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
 * @remarks
 * 暴露两个端点：
 * - `POST /api/copilot` - CopilotKit runtime 消息流
 * - `POST /api/copilot/cancel` - 用户触发的任务取消请求
 *
 * @param db  - ControlPlane 数据库实例
 * @param bus - 进程内 EventBus 实例（未提供时 agent.run 会在订阅阶段 crash）
 * @returns 已配置 /api/copilot 端点的 Hono 应用实例
 */
export function createCopilotRoute(db: ControlPlaneDb, bus?: EventBus): Hono {
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

    const agent = new TianjiAgent(db, nodeId, agentId, bus)
    const runtime = new CopilotRuntime({
      agents: { default: agent },
    })

    const handler = copilotRuntimeNodeHttpEndpoint({
      runtime,
      endpoint: '/api/copilot',
    })

    return handler(c.req.raw) as Promise<Response>
  })

  /**
   * 接收用户发起的任务取消请求，异步写入 task.cancel 命令行。
   *
   * 真正的取消动作发生在 daemon 下一轮 poll 时读取该命令并执行。
   * 不需要 x-node-id / x-agent-id，因为 cancelTask 从 tasks 表反查 node_id。
   *
   * @returns 202 Accepted（已接受，异步处理）
   * @throws 400 body 缺失或 taskId 非字符串
   * @throws 404 taskId 不存在
   * @throws 500 其他未预期错误（由 Hono 默认错误处理接管）
   */
  app.post('/api/copilot/cancel', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    if (typeof body !== 'object' || body === null || !('taskId' in body)) {
      return c.json({ error: 'Missing taskId' }, 400)
    }
    const taskId = (body as { taskId: unknown }).taskId
    if (typeof taskId !== 'string' || taskId.length === 0) {
      return c.json({ error: 'taskId must be a non-empty string' }, 400)
    }

    // cancelTask 内部从 tasks 表反查 node_id，不依赖构造时的 nodeId / agentId，此处用占位。
    // TODO: 引入 TaskNotFoundError 替代消息匹配，使错误分类更严谨。
    const agent = new TianjiAgent(db, '', '', bus)
    try {
      await agent.cancelTask(taskId)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (/not found/i.test(message)) {
        return c.json({ error: message }, 404)
      }
      throw error
    }

    return c.body(null, 202)
  })

  return app
}
