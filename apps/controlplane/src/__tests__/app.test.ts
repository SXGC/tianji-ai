import { createMemorySink, createObserverLogger } from '@tianji/observer'
import { describe, expect, it } from 'vitest'

import { createApp } from '../app.js'
import { createDatabase } from '../db/index.js'

describe('createApp', () => {
  it('returns a Hono app with a health endpoint', async () => {
    const db = createDatabase(':memory:')
    const sink = createMemorySink()
    const logger = createObserverLogger({ sinks: [sink] })
    const { app, monitor } = createApp(db, logger)

    const response = await app.request('http://localhost/health')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })

    monitor.stop()
    db.close()
  })

  it('returns the controlplane spa shell at root', async () => {
    const db = createDatabase(':memory:')
    const sink = createMemorySink()
    const logger = createObserverLogger({ sinks: [sink] })
    const { app, monitor } = createApp(db, logger)

    const response = await app.request('http://localhost/')
    const html = await response.text()

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(html).toContain('<div id="root"></div>')
    expect(html).toMatch(/(?:\/main\.tsx|\/assets\/.*\.js)/)

    monitor.stop()
    db.close()
  })

  it('does not intercept api routes when serving web ui', async () => {
    const db = createDatabase(':memory:')
    const sink = createMemorySink()
    const logger = createObserverLogger({ sinks: [sink] })
    const { app, monitor } = createApp(db, logger)

    const response = await app.request('http://localhost/api/ui/nodes')

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type') ?? '').toContain('application/json')

    monitor.stop()
    db.close()
  })
})
