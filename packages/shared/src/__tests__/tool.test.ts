import { describe, expectTypeOf, it } from 'vitest'
import type { ToolInvocation, ToolResult, ToolSpec } from '../tool.js'

describe('tool type contracts', () => {
  it('ToolSpec requires name, description, parameters', () => {
    expectTypeOf<ToolSpec>().toHaveProperty('name')
    expectTypeOf<ToolSpec>().toHaveProperty('description')
    expectTypeOf<ToolSpec>().toHaveProperty('parameters')
  })

  it('ToolInvocation requires toolCallId, toolName, args', () => {
    expectTypeOf<ToolInvocation>().toHaveProperty('toolCallId')
    expectTypeOf<ToolInvocation>().toHaveProperty('toolName')
    expectTypeOf<ToolInvocation>().toHaveProperty('args')
  })

  it('ToolResult requires toolCallId', () => {
    expectTypeOf<ToolResult>().toHaveProperty('toolCallId')
  })
})
