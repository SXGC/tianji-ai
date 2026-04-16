import type { ObserverLogger } from '@tianji/observer'
import type { PollCommandResponse } from '@tianji/shared'
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

    // task.cancel 命令在节点 busy 时也必须下发，不受 busy 限制；
    // task.run 命令在节点 busy 时跳过，等节点空闲后再取。
    const pendingCancel = tryLeasePendingCancelCommand(db, nodeId)
    if (pendingCancel !== null) {
      return c.json(pendingCancel)
    }

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

      const pendingCancelInLoop = tryLeasePendingCancelCommand(db, nodeId)
      if (pendingCancelInLoop !== null) {
        return c.json(pendingCancelInLoop)
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

function tryLeasePendingCommand(db: ControlPlaneDb, nodeId: string): PollCommandResponse | null {
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

  // task.run 命令在 commands 表插入时会伴随 tasks 行；task.cancel 没有 tasks 行（UPDATE 0 行 = 无副作用）。
  db.raw
    .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE command_id = ?')
    .run('running', now, row.command_id)

  return toPollCommandResponse(row.command_id, row.type, JSON.parse(row.payload))
}

/**
 * 专门取 task.cancel 类型的待处理命令，不受节点 busy 状态限制。
 *
 * 取消命令必须即时下发，即使节点正在执行任务（busy）也不能等待。
 * 其余类型命令（如 task.run）在节点 busy 时不下发，仍由调用方的 busy 检查守门。
 */
function tryLeasePendingCancelCommand(
  db: ControlPlaneDb,
  nodeId: string
): PollCommandResponse | null {
  const row = db.raw
    .prepare(
      `SELECT command_id, type, payload FROM commands
       WHERE node_id = ? AND type = 'task.cancel' AND state = 'pending'
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

  return toPollCommandResponse(row.command_id, row.type, JSON.parse(row.payload))
}

/**
 * 将 DB 行映射为强类型 PollCommandResponse。
 * 未知 type 立即抛错（Let it crash）：DB 侧应已由写入端约束有效 type，未知值意味着数据损坏或协议升级未同步。
 */
function toPollCommandResponse(
  commandId: string,
  type: string,
  payload: unknown
): PollCommandResponse {
  switch (type) {
    case 'task.run':
      return {
        commandId: commandId as PollCommandResponse['commandId'],
        type: 'task.run',
        payload: payload as Extract<PollCommandResponse, { type: 'task.run' }>['payload'],
      }
    case 'task.cancel':
      return {
        commandId: commandId as PollCommandResponse['commandId'],
        type: 'task.cancel',
        payload: payload as Extract<PollCommandResponse, { type: 'task.cancel' }>['payload'],
      }
    default:
      throw new Error(`Unknown command type in DB: ${type} (commandId=${commandId})`)
  }
}
