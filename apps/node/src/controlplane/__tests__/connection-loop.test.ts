import { createNodeId } from '@tianji/shared'
import { describe, expect, it, vi } from 'vitest'

import type { ControlPlaneConnectionConfig } from '../connection-loop.js'
import { ControlPlaneConnection } from '../connection-loop.js'

describe('ControlPlaneConnectionConfig', () => {
  it('should define required fields', () => {
    const config: ControlPlaneConnectionConfig = {
      baseUrl: 'http://localhost:3000',
      nodeId: createNodeId('node-001'),
      enrollmentToken: 'token-abc',
      hostname: 'dev-machine',
      platform: 'linux',
      version: '3.0.0',
      agentList: [],
      heartbeatIntervalMs: 30000,
      onCommand: vi.fn(),
    }

    expect(config.heartbeatIntervalMs).toBe(30000)
  })

  it('should construct connection client', () => {
    const connection = new ControlPlaneConnection({
      baseUrl: 'http://localhost:3000',
      nodeId: createNodeId('node-001'),
      enrollmentToken: 'token-abc',
      hostname: 'dev-machine',
      platform: 'linux',
      version: '3.0.0',
      agentList: [],
      onCommand: vi.fn(),
    })

    expect(connection.client).toBeDefined()
  })
})
