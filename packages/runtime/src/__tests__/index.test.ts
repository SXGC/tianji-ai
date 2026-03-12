import { createRunId, createSessionId } from '@tianji/contracts'
import type { LlmRequest, LlmResponse } from '@tianji/llm'
import { describe, expect, it } from 'vitest'

import {
  FileSnapshotStore,
  InMemorySnapshotStore,
  ReplayableEventStream,
  ToolRegistry,
  createSessionRuntime,
  ensureToolAllowed,
} from '../index.js'
import type {
  CreateSessionOptions,
  ResumeRunOptions,
  RunTurnOptions,
  RuntimeToolDefinition,
  RuntimeToolExecutionContext,
  RuntimeToolSideEffect,
  SessionRuntime,
  SessionRuntimeOptions,
  ToolCatalog,
} from '../index.js'

interface PackageJson {
  readonly dependencies?: Record<string, string>
  readonly exports?: {
    readonly '.': {
      readonly types: string
      readonly import: string
    }
  }
}

function createMockResponse(content: string): LlmResponse {
  return {
    content,
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      totalTokens: 2,
      cost: {
        currency: 'USD',
        inputCost: 0,
        outputCost: 0,
        totalCost: 0,
        pricingSource: 'unavailable',
      },
    },
    meta: { provider: 'openai', model: 'fake' },
    finishReason: 'stop',
    toolCalls: [],
    toolResults: [],
  }
}

describe('@tianji/runtime', () => {
  it('should be importable and expose the public runtime surface', async () => {
    const runtimeModule = await import('../index.js')

    expect(runtimeModule.createSessionRuntime).toBeDefined()
    expect(runtimeModule.InMemorySnapshotStore).toBeDefined()
    expect(runtimeModule.FileSnapshotStore).toBeDefined()
    expect(runtimeModule.ReplayableEventStream).toBeDefined()
    expect(runtimeModule.ToolRegistry).toBeDefined()
    expect(runtimeModule.ensureToolAllowed).toBeDefined()
  })

  it('should allow public runtime types to be consumed without deep imports', async () => {
    const sideEffect: RuntimeToolSideEffect = 'idempotent'
    const executionContext: RuntimeToolExecutionContext = {
      sessionId: createSessionId('session-runtime-exports'),
      runId: createRunId('run-runtime-exports'),
      toolCallId: 'tool-call-runtime-exports',
    }
    const toolDefinition: RuntimeToolDefinition = {
      spec: {
        name: 'noop',
        description: 'No-op tool',
        parameters: { type: 'object' },
      },
      execute: async (_args, context) => ({
        ok: true,
        runId: context.runId,
      }),
      sideEffect,
    }
    const toolCatalog: ToolCatalog = new ToolRegistry([toolDefinition]).createCatalog()
    const runtimeOptions: SessionRuntimeOptions = {
      llmGateway: {
        stream: async (_request: LlmRequest) => ({
          onEvent: () => {},
          abort: () => {},
          waitUntilComplete: async () => createMockResponse('hello from runtime'),
        }),
      },
      snapshotStore: new InMemorySnapshotStore(),
      toolCatalog: [toolDefinition],
    }
    const createSessionOptions: CreateSessionOptions = {
      sessionId: executionContext.sessionId,
      messages: [],
    }
    const runTurnOptions: RunTurnOptions = {
      sessionId: executionContext.sessionId,
      message: {
        id: 'msg-runtime-exports',
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
        createdAt: 1,
      },
    }
    const resumeRunOptions: ResumeRunOptions = {
      runId: executionContext.runId,
    }
    const runtime: SessionRuntime = createSessionRuntime(runtimeOptions)
    const eventStream = new ReplayableEventStream<number>()
    eventStream.push(1)
    eventStream.close()
    const replayedValues: number[] = []

    for await (const value of eventStream) {
      replayedValues.push(value)
    }

    ensureToolAllowed(toolDefinition, true)

    expect(toolCatalog.hasTool(toolDefinition.spec.name)).toBe(true)
    expect(runtime.createSession).toBeDefined()
    expect(createSessionOptions.sessionId).toBe(executionContext.sessionId)
    expect(runTurnOptions.sessionId).toBe(executionContext.sessionId)
    expect(resumeRunOptions.runId).toBe(executionContext.runId)
    expect(replayedValues).toEqual([1])
  })

  it('should declare only allowed runtime dependencies and public exports', async () => {
    const pkg = (await import('../../package.json', {
      assert: { type: 'json' },
    })) as { default: PackageJson }
    const dependencies = pkg.default.dependencies ?? {}
    const dependencyNames = Object.keys(dependencies)

    expect(pkg.default.exports?.['.']).toEqual({
      types: './dist/index.d.ts',
      import: './dist/index.js',
    })
    expect(dependencies['@tianji/contracts']).toBe('workspace:*')
    expect(dependencies['@tianji/llm']).toBe('workspace:*')
    expect(dependencies['@tianji/shared']).toBe('workspace:*')
    expect(dependencyNames).toEqual([
      '@langchain/core',
      '@langchain/langgraph',
      '@tianji/contracts',
      '@tianji/llm',
      '@tianji/shared',
    ])
    expect(dependencyNames).not.toContain('ai')
  })

  it('should expose both in-memory and file snapshot store implementations', async () => {
    const memoryStore = new InMemorySnapshotStore()
    const fileStore = new FileSnapshotStore('/tmp/tianji-runtime-test')

    expect(memoryStore.saveSession).toBeDefined()
    expect(fileStore.saveRun).toBeDefined()
  })
})
