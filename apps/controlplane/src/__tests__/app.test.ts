import { describe, expect, it } from 'vitest'

import { createApp } from '../app.js'
import { createDatabase } from '../db/index.js'

describe('createApp', () => {
  it('returns a Hono app with a health endpoint', async () => {
    const db = createDatabase(':memory:')
    const { app, monitor } = createApp(db)

    const response = await app.request('http://localhost/health')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ status: 'ok' })

    monitor.stop()
    db.close()
  })
})
