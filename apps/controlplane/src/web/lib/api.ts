export interface UiNodeAgent {
  readonly agentId: string
}

export interface UiNode {
  readonly nodeId: string
  readonly hostname: string
  readonly status: string
  readonly agents: readonly UiNodeAgent[]
}

export interface CreatedTask {
  readonly taskId: string
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
 * 创建一个新的 UI task。
 */
export async function createTask(input: {
  readonly nodeId: string
  readonly agentId: string
  readonly goal: string
  readonly sessionId: string | null
}): Promise<CreatedTask> {
  const response = await fetch('/api/ui/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      nodeId: input.nodeId,
      agentId: input.agentId,
      goal: input.goal,
      sessionIds: input.sessionId === null ? undefined : [input.sessionId],
    }),
  })

  if (!response.ok) {
    throw new Error(await response.text())
  }

  return (await response.json()) as CreatedTask
}
