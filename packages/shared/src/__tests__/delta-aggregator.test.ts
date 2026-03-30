import { describe, expect, it } from 'vitest'

import { applyMessageDelta, isComplete } from '../delta-aggregator.js'
import { createRunId } from '../identifiers.js'

describe('delta-aggregator', () => {
  const runId = createRunId('run-delta-aggregator')

  it('appends text payloads into a single assistant message', () => {
    const first = applyMessageDelta(undefined, {
      runId,
      messageId: 'msg-1',
      sequence: 1,
      op: 'append',
      channel: 'text',
      payload: 'Hello',
      timestamp: 1000,
    })

    const second = applyMessageDelta(first, {
      runId,
      messageId: 'msg-1',
      sequence: 2,
      op: 'append',
      channel: 'text',
      payload: ' world',
      timestamp: 1001,
    })

    expect(second.message.role).toBe('assistant')
    expect(second.message.content).toEqual([{ type: 'text', text: 'Hello world' }])
    expect(second.lastSequence).toBe(2)
  })

  it('replaces thinking channel content independently', () => {
    const initial = applyMessageDelta(undefined, {
      runId,
      messageId: 'msg-2',
      sequence: 1,
      op: 'append',
      channel: 'thinking',
      payload: 'draft',
      timestamp: 1000,
    })

    const replaced = applyMessageDelta(initial, {
      runId,
      messageId: 'msg-2',
      sequence: 2,
      op: 'replace',
      channel: 'thinking',
      payload: 'final reasoning',
      timestamp: 1001,
    })

    expect(replaced.message.content).toEqual([{ type: 'thinking', thinking: 'final reasoning' }])
  })

  it('marks state complete only after text channel completion', () => {
    const partial = applyMessageDelta(undefined, {
      runId,
      messageId: 'msg-3',
      sequence: 1,
      op: 'append',
      channel: 'text',
      payload: 'done soon',
      timestamp: 1000,
    })

    const completed = applyMessageDelta(partial, {
      runId,
      messageId: 'msg-3',
      sequence: 2,
      op: 'complete',
      channel: 'text',
      payload: null,
      timestamp: 1001,
    })

    expect(isComplete(partial)).toBe(false)
    expect(isComplete(completed)).toBe(true)
  })

  it('ignores duplicate or stale sequence numbers', () => {
    const current = applyMessageDelta(undefined, {
      runId,
      messageId: 'msg-4',
      sequence: 2,
      op: 'append',
      channel: 'text',
      payload: 'stable',
      timestamp: 1000,
    })

    const stale = applyMessageDelta(current, {
      runId,
      messageId: 'msg-4',
      sequence: 1,
      op: 'append',
      channel: 'text',
      payload: ' ignored',
      timestamp: 1001,
    })

    expect(stale).toBe(current)
    expect(stale.message.content).toEqual([{ type: 'text', text: 'stable' }])
  })

  it('throws when message ids do not match', () => {
    const current = applyMessageDelta(undefined, {
      runId,
      messageId: 'msg-5',
      sequence: 1,
      op: 'append',
      channel: 'text',
      payload: 'hello',
      timestamp: 1000,
    })

    expect(() =>
      applyMessageDelta(current, {
        runId,
        messageId: 'msg-other',
        sequence: 2,
        op: 'append',
        channel: 'text',
        payload: ' world',
        timestamp: 1001,
      })
    ).toThrow('Cannot apply delta for message msg-other to state for msg-5')
  })
})
