import { describe, expect, it } from 'vitest'

import { ControlPlaneClient } from '../client.js'

describe('ControlPlaneClient', () => {
  it('should be constructable with base URL', () => {
    const client = new ControlPlaneClient({
      baseUrl: 'http://localhost:3000',
      nodeId: 'node-001',
    })

    expect(client).toBeDefined()
  })

  it('should store access token after setAccessToken', () => {
    const client = new ControlPlaneClient({
      baseUrl: 'http://localhost:3000',
      nodeId: 'node-001',
    })

    client.setAccessToken('token-abc')

    expect(client.isAuthenticated).toBe(true)
  })

  it('should report not authenticated before registration', () => {
    const client = new ControlPlaneClient({
      baseUrl: 'http://localhost:3000',
      nodeId: 'node-001',
    })

    expect(client.isAuthenticated).toBe(false)
  })
})
