import { describe, expectTypeOf, it } from 'vitest'
import type {
  Delta,
  DeltaOp,
  MessageDelta,
  ToolProgressChannel,
  ToolProgressDelta,
} from '../delta.js'
import type { MessageDeltaChannel } from '../events.js'

describe('delta type contracts', () => {
  it('DeltaOp is a string union', () => {
    expectTypeOf<DeltaOp>().toEqualTypeOf<'append' | 'replace' | 'complete'>()
  })

  it('MessageDeltaChannel is a string union', () => {
    expectTypeOf<MessageDeltaChannel>().toEqualTypeOf<'text' | 'thinking'>()
  })

  it('ToolProgressChannel is a string union', () => {
    expectTypeOf<ToolProgressChannel>().toEqualTypeOf<'stdout' | 'stderr' | 'progress' | 'result'>()
  })

  it('Delta is a union that includes MessageDelta and ToolProgressDelta', () => {
    expectTypeOf<MessageDelta>().toMatchTypeOf<Delta>()
    expectTypeOf<ToolProgressDelta>().toMatchTypeOf<Delta>()
  })

  it('MessageDelta has messageId, ToolProgressDelta has toolCallId', () => {
    expectTypeOf<MessageDelta>().toHaveProperty('messageId')
    expectTypeOf<ToolProgressDelta>().toHaveProperty('toolCallId')
  })
})
