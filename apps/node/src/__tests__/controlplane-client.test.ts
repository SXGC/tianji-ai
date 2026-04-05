import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { NodeRegisterRequest, NodeRegisterResponse, PollCommandResponse } from '@tianji/shared'
import { ControlPlaneAuthError, ControlPlaneClient } from '../controlplane/client.js'

/**
 * 创建一个模拟 Response 对象。
 *
 * @param status - HTTP 状态码
 * @param body - 响应体（对象会被 JSON 序列化）
 */
function mockResponse(status: number, body?: unknown): Response {
  const isOk = status >= 200 && status < 300
  return {
    ok: isOk,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

describe('ControlPlaneClient', () => {
  let client: ControlPlaneClient
  const baseUrl = 'http://localhost:3000'
  const nodeId = 'node-test-001'

  beforeEach(() => {
    client = new ControlPlaneClient({ baseUrl, nodeId })
    vi.restoreAllMocks()
  })

  describe('constructor', () => {
    it('strips trailing slash from baseUrl', () => {
      const c = new ControlPlaneClient({ baseUrl: 'http://example.com/', nodeId: 'n1' })
      // 通过 register 调用验证 URL 拼接是否正确（无双斜杠）
      const spy = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(mockResponse(200, { accessToken: 'tok', expiresAt: Date.now() + 60000 }))
      void c.register({
        nodeId: 'n1',
        enrollmentToken: 'et',
        hostname: 'h',
        platform: 'linux',
        version: '1.0.0',
        agentList: [],
      })
      expect(spy).toHaveBeenCalledWith(
        'http://example.com/api/nodes/register',
        expect.objectContaining({ method: 'POST' })
      )
    })
  })

  describe('isAuthenticated', () => {
    it('returns false before authentication', () => {
      expect(client.isAuthenticated).toBe(false)
    })

    it('returns true after setAccessToken', () => {
      client.setAccessToken('some-token')
      expect(client.isAuthenticated).toBe(true)
    })

    it('returns true after successful register', async () => {
      const responseData: NodeRegisterResponse = {
        accessToken: 'new-token',
        expiresAt: Date.now() + 60000,
      }
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(200, responseData))

      await client.register({
        nodeId,
        enrollmentToken: 'enroll-token',
        hostname: 'test-host',
        platform: 'linux',
        version: '1.0.0',
        agentList: [],
      })

      expect(client.isAuthenticated).toBe(true)
    })
  })

  describe('register', () => {
    const request: NodeRegisterRequest = {
      nodeId,
      enrollmentToken: 'enroll-token',
      hostname: 'test-host',
      platform: 'linux',
      version: '1.0.0',
      agentList: [{ agentId: 'a1', type: 'native', name: 'Agent1', version: '0.1.0' }],
    }

    it('sends POST to /api/nodes/register with JSON body', async () => {
      const responseData: NodeRegisterResponse = {
        accessToken: 'access-tok',
        expiresAt: Date.now() + 60000,
      }
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(200, responseData))

      const result = await client.register(request)

      expect(spy).toHaveBeenCalledOnce()
      expect(spy).toHaveBeenCalledWith(`${baseUrl}/api/nodes/register`, {
        method: 'POST',
        body: JSON.stringify(request),
        headers: { 'Content-Type': 'application/json' },
      })
      expect(result).toEqual(responseData)
    })

    it('stores accessToken from response', async () => {
      const responseData: NodeRegisterResponse = {
        accessToken: 'stored-tok',
        expiresAt: Date.now() + 60000,
      }
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(200, responseData))

      await client.register(request)
      expect(client.isAuthenticated).toBe(true)
    })

    it('throws on non-ok response', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(409, 'Node already registered'))

      await expect(client.register(request)).rejects.toThrow(/Registration failed: 409/)
    })
  })

  describe('heartbeat', () => {
    beforeEach(() => {
      client.setAccessToken('valid-token')
    })

    it('sends POST with executionState and agentList', async () => {
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(200))

      await client.heartbeat('idle', [
        { agentId: 'a1', type: 'native', name: 'Agent1', version: '0.1.0' },
      ])

      expect(spy).toHaveBeenCalledOnce()
      expect(spy).toHaveBeenCalledWith(
        `${baseUrl}/api/nodes/${nodeId}/heartbeat`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer valid-token',
            'Content-Type': 'application/json',
          }),
        })
      )

      const callBody = JSON.parse(spy.mock.calls[0]![1]!.body as string)
      expect(callBody.executionState).toBe('idle')
      expect(callBody.agentList).toHaveLength(1)
    })

    it('sends heartbeat without agentList when not provided', async () => {
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(200))

      await client.heartbeat('busy')

      const callBody = JSON.parse(spy.mock.calls[0]![1]!.body as string)
      expect(callBody.executionState).toBe('busy')
      expect(callBody.agentList).toBeUndefined()
    })

    it('throws ControlPlaneAuthError on 401', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(401))

      await expect(client.heartbeat('idle')).rejects.toThrow(ControlPlaneAuthError)
      await expect(client.heartbeat('idle')).rejects.toThrow(/token expired or revoked/)
    })

    it('throws generic Error on other non-ok status', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(500))

      await expect(client.heartbeat('idle')).rejects.toThrow(/Heartbeat failed: 500/)
    })

    it('throws when not authenticated', async () => {
      const unauthClient = new ControlPlaneClient({ baseUrl, nodeId })

      await expect(unauthClient.heartbeat('idle')).rejects.toThrow(
        /Not authenticated\. Call register\(\) first\./
      )
    })
  })

  describe('pollCommand', () => {
    beforeEach(() => {
      client.setAccessToken('valid-token')
    })

    it('sends GET to poll endpoint with default timeout', async () => {
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(204))

      await client.pollCommand()

      expect(spy).toHaveBeenCalledWith(
        `${baseUrl}/api/nodes/${nodeId}/commands/poll?timeout=30000`,
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer valid-token',
          }),
        })
      )
    })

    it('uses custom timeout', async () => {
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(204))

      await client.pollCommand(5000)

      expect(spy).toHaveBeenCalledWith(
        `${baseUrl}/api/nodes/${nodeId}/commands/poll?timeout=5000`,
        expect.anything()
      )
    })

    it('returns null on 204 (no command)', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(204))

      const result = await client.pollCommand()
      expect(result).toBeNull()
    })

    it('returns PollCommandResponse on 200', async () => {
      const commandResponse: PollCommandResponse = {
        commandId: 'cmd-1' as PollCommandResponse['commandId'],
        type: 'task.run',
        payload: {
          taskId: 'task-1' as PollCommandResponse['payload']['taskId'],
          agentId: 'agent-1',
          goal: 'do something',
        },
      }
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(200, commandResponse))

      const result = await client.pollCommand()
      expect(result).toEqual(commandResponse)
    })

    it('throws ControlPlaneAuthError on 401', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(401))

      await expect(client.pollCommand()).rejects.toThrow(ControlPlaneAuthError)
    })

    it('throws generic Error on other non-ok status', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(503))

      await expect(client.pollCommand()).rejects.toThrow(/Poll failed: 503/)
    })

    it('passes custom AbortSignal', async () => {
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(204))
      const controller = new AbortController()

      await client.pollCommand(30000, controller.signal)

      expect(spy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ signal: controller.signal })
      )
    })

    it('throws when not authenticated', async () => {
      const unauthClient = new ControlPlaneClient({ baseUrl, nodeId })

      await expect(unauthClient.pollCommand()).rejects.toThrow(
        /Not authenticated\. Call register\(\) first\./
      )
    })
  })

  describe('openEventStream', () => {
    it('throws when not authenticated', async () => {
      const unauthClient = new ControlPlaneClient({ baseUrl, nodeId })

      await expect(unauthClient.openEventStream('task-1')).rejects.toThrow(
        /Not authenticated\. Call register\(\) first\./
      )
    })

    it('calls fetch with correct URL and headers', async () => {
      client.setAccessToken('stream-token')
      const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(200))

      await client.openEventStream('task-42')

      expect(spy).toHaveBeenCalledWith(
        `${baseUrl}/api/tasks/task-42/events`,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/x-ndjson',
            Authorization: 'Bearer stream-token',
          }),
          duplex: 'half',
        })
      )
    })

    it('returns NdjsonWriter with write, writeKeepalive, close, abort', async () => {
      client.setAccessToken('stream-token')
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockResponse(200))

      const writer = await client.openEventStream('task-1')

      expect(typeof writer.write).toBe('function')
      expect(typeof writer.writeKeepalive).toBe('function')
      expect(typeof writer.close).toBe('function')
      expect(typeof writer.abort).toBe('function')
    })
  })

  describe('ControlPlaneAuthError', () => {
    it('has correct name property', () => {
      const error = new ControlPlaneAuthError('test message')
      expect(error.name).toBe('ControlPlaneAuthError')
      expect(error.message).toBe('test message')
    })

    it('is instanceof Error', () => {
      const error = new ControlPlaneAuthError('test')
      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(ControlPlaneAuthError)
    })
  })
})
