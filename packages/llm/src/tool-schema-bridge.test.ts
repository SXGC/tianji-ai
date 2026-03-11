import type { ToolSpec } from '@tianji/contracts'
import { describe, expect, test } from 'vitest'
import { toolSpecToAiSdkTool } from './tool-schema-bridge.js'

describe('toolSpecToAiSdkTool', () => {
  test('preserves description', () => {
    const spec: ToolSpec = {
      name: 'get_weather',
      description: 'Get the current weather for a location',
      parameters: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description: 'City or location name',
          },
        },
        required: ['location'],
      },
    }

    const tool = toolSpecToAiSdkTool(spec)

    expect(tool.description).toBe('Get the current weather for a location')
  })

  test('preserves parameters as JSON Schema', () => {
    const spec: ToolSpec = {
      name: 'search',
      description: 'Search for items',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'number', default: 10 },
        },
        required: ['query'],
      },
    }

    const tool = toolSpecToAiSdkTool(spec)

    expect(tool.parameters).toBeDefined()
    expect(tool.parameters.jsonSchema).toEqual(spec.parameters)
  })

  test('does not include permissions in output', () => {
    const spec: ToolSpec = {
      name: 'admin_action',
      description: 'Perform an admin action',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string' },
        },
        required: ['action'],
      },
      permissions: ['admin', 'write'],
    }

    const tool = toolSpecToAiSdkTool(spec)

    // Tool output should not have a permissions field
    expect(tool).not.toHaveProperty('permissions')
    expect(tool.description).toBe('Perform an admin action')
  })

  test('handles spec without optional permissions', () => {
    const spec: ToolSpec = {
      name: 'simple_tool',
      description: 'A simple tool without permissions',
      parameters: {
        type: 'object',
        properties: {},
      },
    }

    const tool = toolSpecToAiSdkTool(spec)

    expect(tool.description).toBe('A simple tool without permissions')
    expect(tool.parameters).toBeDefined()
  })
})
