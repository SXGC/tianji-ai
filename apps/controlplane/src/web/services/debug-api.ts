export interface DebugEvent {
  eventId: string
  type: string
  occurredAt: string
  correlationId: string
  causationId: string | null
  sequence: number
  aggregateType: 'Session' | 'GraphRun' | 'Run' | 'Task' | 'Node'
  aggregateId: string
  source: { processKind: 'daemon' | 'node' | 'cp'; processId: string; nodeId?: string }
  payload: Record<string, unknown>
  cursor: number
}

export interface DebugEventsResponse {
  events: DebugEvent[]
  maxCursor: number
  minCursor: number
  hasMore: boolean
}

export interface DebugNodeDto {
  nodeId: string
  hostname: string
  platform: string
  version: string
  status: 'online' | 'offline'
  executionState: string
  lastHeartbeatAt: string | null
  registeredAt: string
  agents: Array<{ agentId: string; type: string; name: string; version: string }>
}

export interface FetchEventsParams {
  mode: 'realtime' | 'history'
  sinceCursor?: number
  beforeCursor?: number
  startTime?: string
  endTime?: string
  aggregateType?: 'Session' | 'GraphRun' | 'Run' | 'Task' | 'Node'
  aggregateId?: string
  limit?: number
}

function toQuery(params: FetchEventsParams): string {
  const u = new URLSearchParams()
  u.set('mode', params.mode)
  if (params.sinceCursor !== undefined) u.set('since_cursor', String(params.sinceCursor))
  if (params.beforeCursor !== undefined) u.set('before_cursor', String(params.beforeCursor))
  if (params.startTime !== undefined) u.set('start_time', params.startTime)
  if (params.endTime !== undefined) u.set('end_time', params.endTime)
  if (params.aggregateType !== undefined) u.set('aggregate_type', params.aggregateType)
  if (params.aggregateId !== undefined) u.set('aggregate_id', params.aggregateId)
  if (params.limit !== undefined) u.set('limit', String(params.limit))
  return u.toString()
}

export async function fetchDebugEvents(params: FetchEventsParams): Promise<DebugEventsResponse> {
  const res = await fetch(`/api/debug/events?${toQuery(params)}`)
  if (!res.ok) throw new Error(`debug events ${res.status}`)
  return (await res.json()) as DebugEventsResponse
}

export async function fetchDebugNodes(): Promise<DebugNodeDto[]> {
  const res = await fetch('/api/debug/nodes')
  if (!res.ok) throw new Error(`debug nodes ${res.status}`)
  const body = (await res.json()) as { nodes: DebugNodeDto[] }
  return body.nodes
}
