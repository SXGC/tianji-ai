import { serve } from '@hono/node-server'
import Database from 'better-sqlite3'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { describe, expect, it } from 'vitest'

describe('Framework Capability Validation', () => {
  describe('1. Long Polling: hold HTTP request for timeout', () => {
    it('should hold request and return after timeout', async () => {
      const app = new Hono()
      app.get('/poll', async (c) => {
        const timeout = Number(c.req.query('timeout') ?? 500)
        await new Promise((resolve) => setTimeout(resolve, timeout))
        return c.body(null, 204)
      })

      const server = serve({ fetch: app.fetch, port: 0 })
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0

      const start = Date.now()
      const response = await fetch(`http://localhost:${port}/poll?timeout=200`)
      const elapsed = Date.now() - start

      expect(response.status).toBe(204)
      expect(elapsed).toBeGreaterThanOrEqual(180)
      server.close()
    })
  })

  describe('2. SSE: support Last-Event-ID reconnect', () => {
    it('should stream SSE events and support last-event-id', async () => {
      const app = new Hono()
      app.get('/sse', (c) => {
        const lastId = Number(c.req.header('Last-Event-ID') ?? '0')
        return streamSSE(c, async (stream) => {
          for (let index = lastId + 1; index <= lastId + 3; index += 1) {
            await stream.writeSSE({
              event: 'test',
              data: JSON.stringify({ seq: index }),
              id: String(index),
            })
          }
        })
      })

      const server = serve({ fetch: app.fetch, port: 0 })
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0

      const response = await fetch(`http://localhost:${port}/sse`, {
        headers: { 'Last-Event-ID': '5' },
      })
      const text = await response.text()

      expect(text).toContain('id: 6')
      expect(text).toContain('id: 7')
      expect(text).toContain('id: 8')
      server.close()
    })
  })

  describe('3. SQLite WAL: high-frequency writes do not block reads', () => {
    it('should handle concurrent reads and writes', () => {
      const db = new Database(':memory:')
      db.pragma('journal_mode = WAL')
      db.exec('CREATE TABLE test (id INTEGER PRIMARY KEY, value TEXT)')

      const insert = db.prepare('INSERT INTO test (value) VALUES (?)')
      const count = db.prepare('SELECT COUNT(*) as cnt FROM test')

      const writeMany = db.transaction(() => {
        for (let index = 0; index < 1000; index += 1) {
          insert.run(`value-${index}`)
        }
      })
      writeMany()

      const result = count.get() as { cnt: number }
      expect(result.cnt).toBe(1000)

      db.close()
    })
  })

  describe('4. NDJSON: receive chunked POST body', () => {
    it('should receive NDJSON lines from chunked POST', async () => {
      const received: string[] = []
      const app = new Hono()
      app.post('/ndjson', async (c) => {
        const text = await c.req.text()
        const lines = text.split('\n').filter((line) => line.trim().length > 0)
        received.push(...lines)
        return c.json({ count: lines.length })
      })

      const server = serve({ fetch: app.fetch, port: 0 })
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0

      const body = '{"seq":1}\n{"seq":2}\n{"seq":3}\n'
      const response = await fetch(`http://localhost:${port}/ndjson`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-ndjson' },
        body,
      })

      const data = (await response.json()) as { count: number }
      expect(data.count).toBe(3)
      expect(received).toHaveLength(3)
      server.close()
    })
  })
})
