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

  it('should stop polling after stop is called', async () => {
    const pollCommand = vi.fn<() => Promise<null>>().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50))
      return null
    })

    const register = vi.fn(async () => ({ accessToken: 'token', expiresAt: Date.now() + 60_000 }))
    const heartbeat = vi.fn(async () => undefined)

    const connection = new ControlPlaneConnection({
      baseUrl: 'http://localhost:3000',
      nodeId: createNodeId('node-001'),
      enrollmentToken: 'token-abc',
      hostname: 'dev-machine',
      platform: 'linux',
      version: '3.0.0',
      agentList: [],
      heartbeatIntervalMs: 10_000,
      onCommand: vi.fn(),
    })

    Object.assign(connection.client, {
      register,
      heartbeat,
      pollCommand,
    })

    await connection.start()
    await new Promise((resolve) => setTimeout(resolve, 20))
    connection.stop()

    const callsAtStop = pollCommand.mock.calls.length
    await new Promise((resolve) => setTimeout(resolve, 120))

    expect(pollCommand.mock.calls.length).toBe(callsAtStop)
  })
})
