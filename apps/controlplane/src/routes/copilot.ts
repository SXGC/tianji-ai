/**
 * CopilotKit runtime 路由
 *
 * 为每个请求创建独立的 CopilotRuntime 和 TianjiAgent 实例，
 * 验证请求头和节点状态后，将请求代理给 CopilotKit HTTP handler。
 *
 * @module routes/copilot
 */
import { CopilotRuntime, copilotRuntimeNodeHttpEndpoint } from '@copilotkit/runtime'
import type { ObserverLogger } from '@tianji/observer'
import type { EventBus } from '@tianji/shared'
import { createSessionId } from '@tianji/shared'
import { Hono } from 'hono'

import { TianjiAgent } from '../agents/tianji-agent.js'
import type { ControlPlaneDb } from '../db/index.js'

/**
 * 创建 CopilotKit runtime Hono 路由。
 *
 * 每个 POST /api/copilot 请求都需要携带：
 * - `x-node-id`：目标节点 ID（非空）
 * - `x-agent-id`：代理 ID（非空）
 * - `x-session-id`：当前会话 ID（非空，作为 AG-UI threadId）
 *
 * 节点必须存在且处于 online 状态，否则返回对应错误码。
 *
 * @remarks
 * 暴露两个端点：
 * - `POST /api/copilot` - CopilotKit runtime 消息流
 * - `POST /api/copilot/cancel` - 用户触发的任务取消请求
 *
 * @param db     - ControlPlane 数据库实例
 * @param logger - 结构化日志，透传给 TianjiAgent 内部的 AgUiEventGate（必传）
 * @param bus    - 进程内 EventBus 实例（未提供时 agent.run 会在订阅阶段 crash）
 * @returns 已配置 /api/copilot 端点的 Hono 应用实例
 */
export function createCopilotRoute(
  db: ControlPlaneDb,
  logger: ObserverLogger,
  bus?: EventBus
): Hono {
  const app = new Hono()

  function getSessionOwner(sessionId: string): { nodeId: string; agentId: string } | undefined {
    return db.raw
      .prepare('SELECT node_id as nodeId, agent_id as agentId FROM sessions WHERE session_id = ?')
      .get(sessionId) as { nodeId: string; agentId: string } | undefined
  }

  function bindSessionOwner(sessionId: string, nodeId: string, agentId: string): void {
    const now = Date.now()
    db.raw
      .prepare(
        `INSERT INTO sessions (session_id, node_id, agent_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'user', ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at`
      )
      .run(sessionId, nodeId, agentId, now, now)
  }

  app.get('/api/copilot/info', (c) => {
    return c.json({
      agents: [
        {
          id: 'default',
          name: 'default',
          description: 'Tianji controlplane agent',
        },
      ],
    })
  })

  app.post('/api/sessions', async (c) => {
    let body: unknown
    try {
      body = await c.req.json()
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400)
    }

    if (typeof body !== 'object' || body === null) {
      return c.json({ error: 'Missing nodeId or agentId' }, 400)
    }

    const { nodeId, agentId } = body as { nodeId?: unknown; agentId?: unknown }
    if (typeof nodeId !== 'string' || nodeId.length === 0) {
      return c.json({ error: 'nodeId must be a non-empty string' }, 400)
    }
    if (typeof agentId !== 'string' || agentId.length === 0) {
      return c.json({ error: 'agentId must be a non-empty string' }, 400)
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

    const sessionId = createSessionId(`session_${crypto.randomUUID()}`)
    bindSessionOwner(sessionId, nodeId, agentId)
    return c.json({ sessionId }, 201)
  })

  app.post('/api/copilot', async (c) => {
    const nodeId = c.req.header('x-node-id')
    const agentId = c.req.header('x-agent-id')
    const sessionId = c.req.header('x-session-id')

    if (!nodeId || !agentId || !sessionId) {
      return c.json({ error: 'Missing x-node-id, x-agent-id, or x-session-id header' }, 400)
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

    const existingOwner = getSessionOwner(sessionId)
    if (existingOwner === undefined) {
      bindSessionOwner(sessionId, nodeId, agentId)
    } else if (existingOwner.nodeId !== nodeId || existingOwner.agentId !== agentId) {
      return c.json({ error: 'session owner mismatch' }, 409)
    }

    const agent = new TianjiAgent(db, nodeId, agentId, sessionId, bus, logger)
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
    const agent = new TianjiAgent(db, '', '', '', bus, logger)
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
