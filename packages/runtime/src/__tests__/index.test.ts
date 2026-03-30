/**
 * runtime 包根入口回归测试。
 *
 * 业务职责：
 * - 校验 @tianji/runtime 的公共导出、类型边界与 package.json 对外声明保持一致。
 * - 防止后续重构破坏入口可导入性或引入未授权依赖。
 *
 * 对外触点：
 * - 直接校验 ../index.js 公共入口。
 * - 读取 ../../package.json 验证 exports 与 dependencies 边界。
 */
import { FakeListChatModel } from '@langchain/core/utils/testing'
import { createRunId, createSessionId } from '@tianji/contracts'
import { describe, expect, it } from 'vitest'

import {
  FileSnapshotStore,
  InMemorySnapshotStore,
  ReplayableEventStream,
  RuntimeConfigError,
  ToolRegistry,
  createSessionRuntime,
  createWorkspaceId,
  ensureToolAllowed,
  loadResolvedConfig,
  readDeepagentsRunWorkflowState,
  resolveConfigPaths,
  resolveWorkspaceConfig,
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

describe('@tianji/runtime', () => {
  it('should be importable and expose the public runtime surface', async () => {
    const runtimeModule = await import('../index.js')

    expect(runtimeModule.createSessionRuntime).toBeDefined()
    expect(runtimeModule.loadResolvedConfig).toBeDefined()
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
      deepagents: {
        model: new FakeListChatModel({ responses: ['hello from runtime'] }),
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
      resumeValue: { decisions: [{ type: 'approve' }] },
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
    expect(typeof createWorkspaceId('test-workspace')).toBe('string')
    expect(
      resolveWorkspaceConfig({ workspaceRoot: '/tmp/tianji-runtime-exports' }).id
    ).toBeDefined()
    expect(
      resolveConfigPaths({ workspaceRoot: '/tmp/tianji-runtime-exports' }).defaultConfigPath
    ).toBe('/workspaces/dev_docker/tianji-ai/tianji.config.json')
    expect(RuntimeConfigError).toBeDefined()
    expect(loadResolvedConfig).toBeDefined()
    expect(createSessionOptions.sessionId).toBe(executionContext.sessionId)
    expect(runTurnOptions.sessionId).toBe(executionContext.sessionId)
    expect(resumeRunOptions.runId).toBe(executionContext.runId)
    expect(readDeepagentsRunWorkflowState(undefined)).toBeUndefined()
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
      '@langchain/openai',
      '@tianji/contracts',
      '@tianji/llm',
      '@tianji/shared',
      'deepagents',
      'langchain',
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
