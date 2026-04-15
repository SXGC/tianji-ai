import { type Command, createNodeId, createTaskId } from '@tianji/shared'
import { describe, expect, it, vi } from 'vitest'

import type { ControlPlaneRuntimeDeps } from '../controlplane-runtime.js'
import { createControlPlaneRuntime } from '../controlplane-runtime.js'

describe('createControlPlaneRuntime', () => {
  it('should wire command polling to task execution', async () => {
    const command: Command = {
      commandId: 'command-001' as never,
      nodeId: createNodeId('node-001'),
      type: 'task.run',
      state: 'pending',
      createdAt: Date.now(),
      payload: {
        taskId: createTaskId('task-001'),
        agentId: 'default',
        goal: 'hello',
      },
    }

    const execute = vi.fn(async () => undefined)
    const start = vi.fn(async () => undefined)
    const stop = vi.fn(() => undefined)
    const setExecutionState = vi.fn(() => undefined)

    const deps: ControlPlaneRuntimeDeps = {
      createConnection: () => ({
        start,
        stop,
        setExecutionState,
      }),
      createTaskExecutor: (callbacks) => {
        callbacks.onExecutionStateChange('busy')
        return {
          executionState: 'idle',
          currentTaskId: null,
          execute,
        }
      },
    }

    const runtime = createControlPlaneRuntime(
      {
        baseUrl: 'http://localhost:3000',
        nodeId: createNodeId('node-001'),
        enrollmentToken: 'enroll-token',
        hostname: 'devbox',
        platform: 'linux',
        version: '0.0.1',
        agentList: [],
        agentConfigs: {},
        emitTaskEvent: vi.fn(),
        publishEnvelope: vi.fn(),
        enterCorrelation: async (_correlationId, fn) => fn(),
      },
      deps
    )

    await runtime.onCommand(command)

    expect(execute).toHaveBeenCalledWith(command)
  })
})
