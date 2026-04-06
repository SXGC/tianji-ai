import { createNodeId, createTaskId } from '@tianji/shared'
import { describe, expect, it, vi } from 'vitest'

import { createCliLogger } from '../../logger.js'
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

  it('writes heartbeat and task receive logs', async () => {
    const written: Array<{ level: string; message: string; data?: Record<string, unknown> }> = []
    const logger = createCliLogger({
      sink: {
        async write(entry) {
          written.push({
            level: entry.level,
            message: entry.message,
            data: entry.data,
          })
        },
      },
    })

    const onCommand = vi.fn()
    const connection = new ControlPlaneConnection({
      baseUrl: 'http://localhost:3000',
      nodeId: createNodeId('node-001'),
      enrollmentToken: 'token-abc',
      hostname: 'dev-machine',
      platform: 'linux',
      version: '3.0.0',
      agentList: [],
      heartbeatIntervalMs: 10,
      onCommand,
      logger,
    })

    const pollCommand = vi
      .fn<
        () => Promise<
          ReturnType<ControlPlaneConnection['client']['pollCommand']> extends Promise<infer T>
            ? T
            : never
        >
      >()
      .mockResolvedValueOnce({
        commandId: 'command-001' as never,
        type: 'task.run',
        payload: {
          taskId: createTaskId('task-001'),
          agentId: 'default',
          goal: 'hello',
        },
      })
      .mockResolvedValue(null)

    Object.assign(connection.client, {
      register: vi.fn(async () => ({ accessToken: 'token', expiresAt: Date.now() + 60_000 })),
      heartbeat: vi.fn(async () => undefined),
      pollCommand,
    })

    await connection.start()
    await new Promise((resolve) => setTimeout(resolve, 30))
    connection.stop()

    expect(
      written.some(
        (entry) => entry.level === 'debug' && entry.message === 'Sending control plane heartbeat'
      )
    ).toBe(true)
    expect(
      written.some(
        (entry) => entry.level === 'info' && entry.message === 'Received control plane task'
      )
    ).toBe(true)
    expect(
      written.some(
        (entry) => entry.level === 'debug' && entry.message === 'Received control plane task detail'
      )
    ).toBe(true)
  })

  it('should not busy loop when poll returns null repeatedly', async () => {
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

    const pollCommand = vi.fn<() => Promise<null>>().mockResolvedValue(null)

    Object.assign(connection.client, {
      register: vi.fn(async () => ({ accessToken: 'token', expiresAt: Date.now() + 60_000 })),
      heartbeat: vi.fn(async () => undefined),
      pollCommand,
    })

    await connection.start()
    await new Promise((resolve) => setTimeout(resolve, 50))
    connection.stop()

    expect(pollCommand.mock.calls.length).toBeLessThanOrEqual(5)
  })
})
