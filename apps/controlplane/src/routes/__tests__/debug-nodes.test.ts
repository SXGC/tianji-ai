import Database from 'better-sqlite3'
import { describe, expect, test } from 'vitest'

import { SCHEMA_SQL } from '../../db/schema.js'
import { createDebugNodesRoute } from '../debug-nodes.js'

function setupDb() {
  const raw = new Database(':memory:')
  raw.exec(SCHEMA_SQL)
  raw.prepare('INSERT INTO enrollment_tokens (token, created_at) VALUES (?, ?)').run('tok-1', 0)
  return { raw, db: { raw } as unknown as { raw: Database.Database } }
}

function insertNode(raw: Database.Database, nodeId: string, lastHeartbeatAt: number | null): void {
  raw
    .prepare(
      `INSERT INTO nodes
       (node_id, hostname, platform, version, status, execution_state,
        access_token_hash, access_token_expires_at, enrollment_token, pid,
        last_heartbeat_at, created_at, updated_at)
       VALUES (@nid, 'h', 'linux', 'v1', 'offline', 'idle', 'x', 9999999999999, 'tok-1',
               NULL, @hb, 1000, 1000)`
    )
    .run({ nid: nodeId, hb: lastHeartbeatAt })
}

describe('GET /api/debug/nodes', () => {
  test('返回节点列表含 registeredAt / lastHeartbeatAt / status / agents', async () => {
    const { raw, db } = setupDb()
    insertNode(raw, 'n-online', Date.now())
    insertNode(raw, 'n-offline', null)
    raw
      .prepare(
        `INSERT INTO agents (node_id, agent_id, type, name, version, updated_at)
         VALUES ('n-online', 'a-1', 'native', 'Agent A', 'v1', 1000)`
      )
      .run()
    const app = createDebugNodesRoute(db as never)
    const res = await app.request('/api/debug/nodes')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      nodes: Array<{
        nodeId: string
        status: string
        registeredAt: string
        lastHeartbeatAt: string | null
        executionState: string
        agents: Array<{ agentId: string }>
      }>
    }
    const byId = Object.fromEntries(body.nodes.map((n) => [n.nodeId, n]))
    expect(byId['n-online']!.status).toBe('online')
    expect(byId['n-offline']!.status).toBe('offline')
    expect(byId['n-online']!.registeredAt).toBe(new Date(1000).toISOString())
    expect(byId['n-offline']!.lastHeartbeatAt).toBeNull()
    expect(byId['n-online']!.agents.map((a) => a.agentId)).toEqual(['a-1'])
  })
})
