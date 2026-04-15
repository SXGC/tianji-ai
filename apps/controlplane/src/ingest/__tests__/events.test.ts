import type { DomainEventEnvelope } from '@tianji/shared'
// apps/controlplane/src/ingest/__tests__/events.test.ts
import { describe, expect, it, vi } from 'vitest'
import { createEventIngest } from '../events.js'

function env(overrides: Partial<DomainEventEnvelope>): DomainEventEnvelope {
  return {
    eventId: 'e1',
    type: 'RunStarted',
    occurredAt: 'T',
    correlationId: 'c1',
    causationId: null,
    sequence: 1,
    aggregateType: 'Run',
    aggregateId: 'r1',
    source: { processKind: 'node', processId: 'p1', nodeId: 'n1' },
    payload: {} as never,
    ...overrides,
  } as DomainEventEnvelope
}

describe('createEventIngest', () => {
  it('通过校验的事件 publish 到 cp bus', async () => {
    const publish = vi.fn()
    const ingest = createEventIngest({ publish })
    await ingest.ingest(env({}))
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'e1' }))
  })

  it('归属校验失败 throw（Let it crash）', async () => {
    const publish = vi.fn()
    const ingest = createEventIngest({ publish })
    await expect(
      ingest.ingest(
        env({ aggregateType: 'Node', source: { processKind: 'node', processId: 'p', nodeId: 'n' } })
      )
    ).rejects.toThrow()
    expect(publish).not.toHaveBeenCalled()
  })
})
