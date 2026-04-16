/**
 * POST /api/events 路由。
 *
 * 接收来自 node 进程的 DomainEventEnvelope NDJSON 流，
 * 经 createEventIngest 校验后 publish 到 cp EventBus。
 * 校验失败直接 throw（Let it crash）→ Hono 回 500 → node 侧断开连接。
 *
 * @module routes/events
 */

import type { ObserverLogger } from '@tianji/observer'
import type { DomainEventEnvelope, EventBus } from '@tianji/shared'
import { Hono } from 'hono'

import type { ControlPlaneDb } from '../db/index.js'
import { createEventIngest } from '../ingest/events.js'
import { createAuthMiddleware } from '../middleware/auth.js'

type AuthVariables = {
  Variables: {
    nodeId: string
  }
}

export interface EventsRouteDeps {
  readonly db: ControlPlaneDb
  readonly logger: ObserverLogger
  /** cp 进程内 EventBus，用于 publish 校验通过的 DomainEventEnvelope。 */
  readonly bus: EventBus
}

/**
 * 创建领域事件接收路由。
 *
 * 接收 NDJSON 格式的 DomainEventEnvelope 流，逐行 parse 后交给
 * createEventIngest 做 writer 归属校验，通过后 publish 到 cp bus。
 *
 * @param deps - 路由依赖：db、logger、bus
 */
export function createEventsRoute(deps: EventsRouteDeps): Hono<AuthVariables> {
  const { db, logger, bus } = deps
  const app = new Hono<AuthVariables>()
  const auth = createAuthMiddleware(db, logger)

  const ingest = createEventIngest({
    publish: (env) => bus.publish(env),
    logger,
  })

  app.post('/api/events', auth, async (c) => {
    const body = c.req.raw.body
    if (body === null) {
      return c.json({ accepted: 0 })
    }

    let accepted = 0

    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    /** 处理单行 NDJSON 数据，parse 为 DomainEventEnvelope 并 ingest。 */
    async function processLine(line: string): Promise<void> {
      const env = JSON.parse(line) as DomainEventEnvelope
      try {
        await ingest.ingest(env)
      } catch (err) {
        void logger.error(['cp', 'ingest'], 'ingest rejected envelope', {
          eventId: env.eventId,
          eventType: env.type,
          processKind: env.source.processKind,
          error: err instanceof Error ? err.message : String(err),
        })
        throw err
      }
      accepted++
    }

    for (;;) {
      const { done, value } = await reader.read()
      if (value !== undefined) {
        buffer += decoder.decode(value, { stream: !done })
      }

      // 逐行处理已到达的 NDJSON 数据。
      for (
        let newlineIdx = buffer.indexOf('\n');
        newlineIdx !== -1;
        newlineIdx = buffer.indexOf('\n')
      ) {
        const line = buffer.slice(0, newlineIdx).trim()
        buffer = buffer.slice(newlineIdx + 1)
        if (line.length > 0) {
          await processLine(line)
        }
      }

      if (done) {
        break
      }
    }

    // 处理末尾无换行的残留数据。
    const trailing = buffer.trim()
    if (trailing.length > 0) {
      await processLine(trailing)
    }

    return c.json({ accepted })
  })

  return app
}
