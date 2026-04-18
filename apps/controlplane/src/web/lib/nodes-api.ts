export interface UiNodeAgent {
  readonly agentId: string
}

export interface UiNode {
  readonly nodeId: string
  readonly hostname: string
  readonly status: string
  readonly agents: readonly UiNodeAgent[]
}

export interface CreateSessionInput {
  readonly nodeId: string
  readonly agentId: string
}

export interface CreateSessionResponse {
  readonly sessionId: string
}

/**
 * 获取 controlplane UI 可见节点列表。
 */
export async function fetchNodes(): Promise<readonly UiNode[]> {
  const response = await fetch('/api/ui/nodes')
  if (!response.ok) {
    throw new Error(`Failed to fetch nodes: ${response.status}`)
  }
  return (await response.json()) as UiNode[]
}

/**
 * 请求后端创建并绑定一个新的 session。
 */
export async function createSession(input: CreateSessionInput): Promise<CreateSessionResponse> {
  const response = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!response.ok) {
    throw new Error(`Failed to create session: ${response.status}`)
  }
  return (await response.json()) as CreateSessionResponse
}
