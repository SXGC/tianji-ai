import { ToolError, createRunId, createSessionId } from '@tianji/shared'
import { describe, expect, it } from 'vitest'

import { ToolRegistry, ensureToolAllowed } from '../tool-catalog.js'

describe('ToolRegistry', () => {
  it('registers and resolves tools', async () => {
    const registry = new ToolRegistry().registerTool({
      spec: {
        name: 'read_file',
        description: 'Read a file',
        parameters: { type: 'object' },
      },
      execute: async (args) => args,
    })

    const catalog = registry.createCatalog()

    expect(catalog.hasTool('read_file')).toBe(true)
    await expect(
      catalog.executeTool(
        {
          toolCallId: 'call-1',
          toolName: 'read_file',
          args: { path: 'a.txt' },
        },
        {
          sessionId: createSessionId('session-1'),
          runId: createRunId('run-1'),
          toolCallId: 'call-1',
        }
      )
    ).resolves.toEqual({ path: 'a.txt' })
  })

  it('rejects duplicate tool names', () => {
    const registry = new ToolRegistry().registerTool({
      spec: {
        name: 'duplicate',
        description: 'duplicate',
        parameters: { type: 'object' },
      },
      execute: async () => null,
    })

    expect(() =>
      registry.registerTool({
        spec: {
          name: 'duplicate',
          description: 'duplicate',
          parameters: { type: 'object' },
        },
        execute: async () => null,
      })
    ).toThrow(ToolError)
  })

  it('blocks destructive tools when policy forbids them', () => {
    expect(() =>
      ensureToolAllowed(
        {
          spec: {
            name: 'delete_file',
            description: 'Delete a file',
            parameters: { type: 'object' },
          },
          execute: async () => null,
          sideEffect: 'destructive',
        },
        false
      )
    ).toThrow()
  })
})
