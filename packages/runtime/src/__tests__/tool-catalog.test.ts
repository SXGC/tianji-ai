import { PolicyError, ToolError, createRunId, createSessionId } from '@tianji/shared'
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

  it('executeTool throws TOOL_NOT_FOUND for unregistered tool', async () => {
    const registry = new ToolRegistry()
    const catalog = registry.createCatalog()
    const context = {
      sessionId: createSessionId('s-1'),
      runId: createRunId('r-1'),
      toolCallId: 'call-1',
    }

    await expect(
      catalog.executeTool({ toolCallId: 'call-1', toolName: 'ghost', args: {} }, context)
    ).rejects.toThrow(ToolError)

    await expect(
      catalog.executeTool({ toolCallId: 'call-1', toolName: 'ghost', args: {} }, context)
    ).rejects.toThrow('ghost')
  })

  it('hasTool returns false for unregistered tool', () => {
    const registry = new ToolRegistry()
    expect(registry.hasTool('nonexistent')).toBe(false)
  })

  it('getTool returns undefined for unregistered tool', () => {
    const registry = new ToolRegistry()
    expect(registry.getTool('nonexistent')).toBeUndefined()
  })

  it('createCatalog with toolNames filters to specified tools', () => {
    const registry = new ToolRegistry()
      .registerTool({
        spec: { name: 'tool_a', description: 'A', parameters: { type: 'object' } },
        execute: async () => null,
      })
      .registerTool({
        spec: { name: 'tool_b', description: 'B', parameters: { type: 'object' } },
        execute: async () => null,
      })

    const catalog = registry.createCatalog(['tool_a'])

    expect(catalog.hasTool('tool_a')).toBe(true)
    expect(catalog.hasTool('tool_b')).toBe(false)
  })

  it('createCatalog with unknown toolName throws TOOL_NOT_FOUND', () => {
    const registry = new ToolRegistry()
    expect(() => registry.createCatalog(['ghost'])).toThrow(ToolError)
  })

  it('listTools returns all registered tools in order', () => {
    const registry = new ToolRegistry()
      .registerTool({
        spec: { name: 'tool_x', description: 'X', parameters: { type: 'object' } },
        execute: async () => null,
      })
      .registerTool({
        spec: { name: 'tool_y', description: 'Y', parameters: { type: 'object' } },
        execute: async () => null,
      })

    const names = registry.listTools().map((t) => t.spec.name)
    expect(names).toEqual(['tool_x', 'tool_y'])
  })

  it('getToolSpecs returns specs for all registered tools', () => {
    const registry = new ToolRegistry().registerTool({
      spec: { name: 'tool_z', description: 'Z', parameters: { type: 'object' } },
      execute: async () => null,
    })

    expect(registry.getToolSpecs()).toEqual([
      { name: 'tool_z', description: 'Z', parameters: { type: 'object' } },
    ])
  })

  describe('ensureToolAllowed', () => {
    const makeDef = (sideEffect?: 'none' | 'idempotent' | 'destructive') => ({
      spec: { name: 'test-tool', description: 'Test', parameters: { type: 'object' as const } },
      execute: async () => null,
      sideEffect,
    })

    it('allows destructive tool when allowDestructive is true', () => {
      expect(() => ensureToolAllowed(makeDef('destructive'), true)).not.toThrow()
    })

    it('blocks destructive tool and throws PolicyError when allowDestructive is false', () => {
      expect(() => ensureToolAllowed(makeDef('destructive'), false)).toThrow(PolicyError)
    })

    it('allows idempotent tool regardless of allowDestructive', () => {
      expect(() => ensureToolAllowed(makeDef('idempotent'), false)).not.toThrow()
      expect(() => ensureToolAllowed(makeDef('idempotent'), true)).not.toThrow()
    })

    it('allows none sideEffect tool regardless of allowDestructive', () => {
      expect(() => ensureToolAllowed(makeDef('none'), false)).not.toThrow()
      expect(() => ensureToolAllowed(makeDef('none'), true)).not.toThrow()
    })

    it('allows undefined sideEffect tool regardless of allowDestructive', () => {
      expect(() => ensureToolAllowed(makeDef(undefined), false)).not.toThrow()
      expect(() => ensureToolAllowed(makeDef(undefined), true)).not.toThrow()
    })
  })
})
