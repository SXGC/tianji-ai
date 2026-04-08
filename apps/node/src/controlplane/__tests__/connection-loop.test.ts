import { createNodeId, createTaskId } from '@tianji/shared'
import { describe, expect, it, vi } from 'vitest'

import { createCliLogger } from '../../logger.js'
import { ControlPlaneAuthError } from '../client.js'
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

  it('should trigger heartbeat_failed and re-register on auth error in heartbeat', async () => {
    const stateChanges: Array<{ status: string; error?: string }> = []

    const connection = new ControlPlaneConnection({
      baseUrl: 'http://localhost:3000',
      nodeId: createNodeId('node-001'),
      enrollmentToken: 'token-abc',
      hostname: 'dev-machine',
      platform: 'linux',
      version: '3.0.0',
      agentList: [],
      heartbeatIntervalMs: 10,
      emptyPollBackoffMs: 5,
      onCommand: vi.fn(),
      onConnectionStateChange: (event) => {
        stateChanges.push({ status: event.status, error: event.error })
      },
    })

    const register = vi.fn(async () => ({ accessToken: 'token', expiresAt: Date.now() + 60_000 }))
    const heartbeat = vi.fn(async () => {
      throw new ControlPlaneAuthError('token expired')
    })

    Object.assign(connection.client, {
      register,
      heartbeat,
      pollCommand: vi.fn<() => Promise<null>>().mockResolvedValue(null),
    })

    await connection.start()
    await new Promise((resolve) => setTimeout(resolve, 50))
    connection.stop()

    expect(stateChanges.some((s) => s.status === 'heartbeat_failed')).toBe(true)
    // 初始 register + 至少一次 re-register
    expect(register.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('should exit poll loop silently on AbortError', async () => {
    const connection = new ControlPlaneConnection({
      baseUrl: 'http://localhost:3000',
      nodeId: createNodeId('node-001'),
      enrollmentToken: 'token-abc',
      hostname: 'dev-machine',
      platform: 'linux',
      version: '3.0.0',
      agentList: [],
      heartbeatIntervalMs: 100_000,
      onCommand: vi.fn(),
    })

    const abortError = new Error('The operation was aborted')
    abortError.name = 'AbortError'
    const pollCommand = vi.fn<() => Promise<null>>().mockRejectedValue(abortError)

    Object.assign(connection.client, {
      register: vi.fn(async () => ({ accessToken: 'token', expiresAt: Date.now() + 60_000 })),
      heartbeat: vi.fn(async () => undefined),
      pollCommand,
    })

    await connection.start()
    await new Promise((resolve) => setTimeout(resolve, 50))
    connection.stop()

    // pollCommand 只被调用一次就因 AbortError 退出
    expect(pollCommand.mock.calls.length).toBe(1)
  })

  it('should emit register_failed when re-registration fails after poll auth error', async () => {
    const stateChanges: Array<{ status: string }> = []

    const connection = new ControlPlaneConnection({
      baseUrl: 'http://localhost:3000',
      nodeId: createNodeId('node-001'),
      enrollmentToken: 'token-abc',
      hostname: 'dev-machine',
      platform: 'linux',
      version: '3.0.0',
      agentList: [],
      heartbeatIntervalMs: 100_000,
      emptyPollBackoffMs: 5,
      onCommand: vi.fn(),
      onConnectionStateChange: (event) => {
        stateChanges.push({ status: event.status })
      },
    })

    let registerCallCount = 0
    const register = vi.fn(async () => {
      registerCallCount++
      if (registerCallCount > 1) {
        throw new Error('registration server down')
      }
      return { accessToken: 'token', expiresAt: Date.now() + 60_000 }
    })

    let pollCallCount = 0
    const pollCommand = vi.fn(async () => {
      pollCallCount++
      if (pollCallCount === 1) {
        throw new ControlPlaneAuthError('token expired')
      }
      return null
    })

    Object.assign(connection.client, {
      register,
      heartbeat: vi.fn(async () => undefined),
      pollCommand,
    })

    await connection.start()
    await new Promise((resolve) => setTimeout(resolve, 100))
    connection.stop()

    expect(stateChanges.some((s) => s.status === 'register_failed')).toBe(true)
  })
})
