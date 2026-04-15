/**
 * Control Plane HTTP client.
 *
 * @module controlplane/client
 */

import type {
  AgentInfo,
  NodeExecutionState,
  NodeHeartbeatRequest,
  NodeRegisterRequest,
  NodeRegisterResponse,
  PollCommandResponse,
} from '@tianji/shared'

export interface ControlPlaneClientConfig {
  readonly baseUrl: string
  readonly nodeId: string
}

export class ControlPlaneClient {
  readonly #baseUrl: string
  readonly #nodeId: string
  #accessToken: string | null = null

  constructor(config: ControlPlaneClientConfig) {
    this.#baseUrl = config.baseUrl.replace(/\/$/, '')
    this.#nodeId = config.nodeId
  }

  get isAuthenticated(): boolean {
    return this.#accessToken !== null
  }

  setAccessToken(token: string): void {
    this.#accessToken = token
  }

  async register(request: NodeRegisterRequest): Promise<NodeRegisterResponse> {
    const response = await this.#fetch('/api/nodes/register', {
      method: 'POST',
      body: JSON.stringify(request),
    })

    if (!response.ok) {
      throw new Error(`Registration failed: ${response.status} ${await response.text()}`)
    }

    const data = (await response.json()) as NodeRegisterResponse
    this.#accessToken = data.accessToken
    return data
  }

  async heartbeat(
    executionState: NodeExecutionState,
    agentList?: readonly AgentInfo[],
    pid?: number
  ): Promise<void> {
    const body: NodeHeartbeatRequest = { executionState, agentList, pid }
    const response = await this.#fetchAuth(`/api/nodes/${this.#nodeId}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify(body),
    })

    if (response.status === 401) {
      throw new ControlPlaneAuthError('Heartbeat rejected: token expired or revoked')
    }

    if (!response.ok) {
      throw new Error(`Heartbeat failed: ${response.status}`)
    }
  }

  async pollCommand(timeout = 30000, signal?: AbortSignal): Promise<PollCommandResponse | null> {
    const requestSignal = signal ?? AbortSignal.timeout(timeout + 5000)

    const response = await this.#fetchAuth(
      `/api/nodes/${this.#nodeId}/commands/poll?timeout=${timeout}`,
      {
        method: 'GET',
        signal: requestSignal,
      }
    )

    if (response.status === 204) {
      return null
    }
    if (response.status === 401) {
      throw new ControlPlaneAuthError('Poll rejected: token expired or revoked')
    }
    if (!response.ok) {
      throw new Error(`Poll failed: ${response.status}`)
    }

    return (await response.json()) as PollCommandResponse
  }

  /**
   * 批量 POST DomainEventEnvelope NDJSON 到 cp。
   * 供 forwarder 调用，每次 flush 触发一次请求。
   *
   * @param ndjson - 序列化后的 NDJSON 字符串（每行一个 JSON envelope）
   */
  async postDomainEvents(ndjson: string): Promise<void> {
    if (!this.#accessToken) {
      throw new Error('Not authenticated. Call register() first.')
    }

    const response = await fetch(`${this.#baseUrl}/api/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-ndjson',
        Authorization: `Bearer ${this.#accessToken}`,
      },
      body: ndjson,
    })

    if (response.status === 401) {
      throw new ControlPlaneAuthError('Post domain events rejected: token expired or revoked')
    }

    if (!response.ok) {
      throw new Error(`Post domain events failed: ${response.status}`)
    }
  }

  async openEventStream(): Promise<NdjsonWriter> {
    if (!this.#accessToken) {
      throw new Error('Not authenticated. Call register() first.')
    }

    const url = `${this.#baseUrl}/api/events`
    const controller = new AbortController()
    const encoder = new TextEncoder()

    const { readable, writable } = new TransformStream<string, Uint8Array>({
      transform(chunk, streamController) {
        streamController.enqueue(encoder.encode(chunk))
      },
    })

    const fetchPromise = fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-ndjson',
        Authorization: `Bearer ${this.#accessToken}`,
      },
      body: readable,
      signal: controller.signal,
      duplex: 'half',
    })

    const writer = writable.getWriter()

    return {
      async write(json: string): Promise<void> {
        await writer.write(`${json}\n`)
      },
      async writeKeepalive(): Promise<void> {
        await writer.write('\n')
      },
      async close(): Promise<void> {
        await writer.close()
        await fetchPromise
      },
      abort(): void {
        controller.abort()
      },
    }
  }

  #fetch(path: string, init: RequestInit): Promise<Response> {
    return fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init.headers,
      },
    })
  }

  #fetchAuth(path: string, init: RequestInit): Promise<Response> {
    if (!this.#accessToken) {
      throw new Error('Not authenticated. Call register() first.')
    }

    return fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.#accessToken}`,
        ...init.headers,
      },
    })
  }
}

export interface NdjsonWriter {
  write(json: string): Promise<void>
  writeKeepalive(): Promise<void>
  close(): Promise<void>
  abort(): void
}

export class ControlPlaneAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ControlPlaneAuthError'
  }
}
