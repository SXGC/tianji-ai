import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { createApp } from '../../app.js'
import { SCHEMA_SQL } from '../../db/schema.js'

function makeDb() {
  const raw = new Database(':memory:')
  raw.exec(SCHEMA_SQL)
  return { raw } as unknown as Parameters<typeof createApp>[0]
}

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => noopLogger,
} as unknown as Parameters<typeof createApp>[1]

describe('TIANJI_DEBUG 条件挂载', () => {
  beforeEach(() => {
    vi.stubEnv('TIANJI_DEBUG', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test('未设置 TIANJI_DEBUG 时 /api/debug/* 返回 404', async () => {
    const { app } = createApp(makeDb(), noopLogger)
    const events = await app.request('/api/debug/events?mode=realtime')
    const nodes = await app.request('/api/debug/nodes')
    expect(events.status).toBe(404)
    expect(nodes.status).toBe(404)
  })

  test('TIANJI_DEBUG=true 时 /api/debug/* 可访问', async () => {
    vi.stubEnv('TIANJI_DEBUG', 'true')
    const { app } = createApp(makeDb(), noopLogger)
    const events = await app.request('/api/debug/events?mode=realtime')
    const nodes = await app.request('/api/debug/nodes')
    expect(events.status).toBe(200)
    expect(nodes.status).toBe(200)
  })
})
