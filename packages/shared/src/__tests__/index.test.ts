import { describe, expect, it } from 'vitest'
import type {
  AppMessage,
  Artifact,
  Delta,
  ErrorPlainObject,
  ExecutionPolicy,
  MessageDelta,
  PendingOperation,
  RunSnapshot,
  RuntimeEvent,
  SessionSnapshot,
  ToolResult,
  ToolSpec,
} from '../index.js'
import { DEFAULT_EXECUTION_POLICY, ProviderError, createRunId, createSessionId } from '../index.js'

interface PackageJson {
  dependencies?: Record<string, string>
}

describe('@tianji/shared barrel', () => {
  describe('contracts exports', () => {
    it('should be importable', async () => {
      const shared = await import('../index.js')
      expect(shared).toBeDefined()
    })

    it('should export identifier helpers', async () => {
      const shared = await import('../index.js')
      expect(shared.createSessionId).toBeDefined()
      expect(shared.createThreadId).toBeDefined()
      expect(shared.createRunId).toBeDefined()
      expect(shared.isSessionId).toBeDefined()
      expect(shared.isThreadId).toBeDefined()
      expect(shared.isRunId).toBeDefined()
    })

    it('should export delta aggregation helpers', async () => {
      const shared = await import('../index.js')
      expect(shared.applyMessageDelta).toBeDefined()
      expect(shared.isComplete).toBeDefined()
    })

    it('should expose the public contracts surface from the barrel export', () => {
      const toolSpec: ToolSpec = {
        name: 'echo',
        description: 'Return the provided value',
        parameters: {
          type: 'object',
          properties: {
            value: { type: 'string' },
          },
          required: ['value'],
        },
      }
      const toolResult: ToolResult = {
        toolCallId: 'tool-call-shared-exports',
        result: { value: 'ok' },
      }
      const message: AppMessage = {
        id: 'msg-shared-exports',
        role: 'assistant',
        content: [{ type: 'text', text: 'ready' }],
        createdAt: 1,
      }
      const delta: MessageDelta = {
        runId: createRunId('run-shared-exports'),
        messageId: message.id,
        sequence: 1,
        op: 'append',
        channel: 'text',
        payload: 'ready',
        timestamp: 1,
      }
      const runtimeEvent: RuntimeEvent = {
        type: 'message.completed',
        runId: delta.runId,
        messageId: message.id,
        message,
        timestamp: 1,
      }
      const pendingOperation: PendingOperation = {
        id: 'pending-shared-exports',
        invocation: {
          toolCallId: toolResult.toolCallId,
          toolName: toolSpec.name,
          args: { value: 'ok' },
        },
        status: 'completed',
        timestamp: 1,
      }
      const sessionSnapshot: SessionSnapshot = {
        sessionId: createSessionId('session-shared-exports'),
        messages: [message],
        createdAt: 1,
        updatedAt: 1,
        policy: DEFAULT_EXECUTION_POLICY,
      }
      const runSnapshot: RunSnapshot = {
        runId: delta.runId,
        sessionId: sessionSnapshot.sessionId,
        status: 'completed',
        messages: sessionSnapshot.messages,
        createdAt: 1,
        updatedAt: 1,
        pendingOperations: [pendingOperation],
        policy: DEFAULT_EXECUTION_POLICY,
      }
      const artifact: Artifact = {
        id: 'artifact-shared-exports',
        type: 'structured-result',
        name: 'shared-exports-artifact',
        content: { status: 'ok' },
        mimeType: 'text/plain',
        createdAt: 1,
        metadata: { source: 'test' },
      }
      const executionPolicy: ExecutionPolicy = DEFAULT_EXECUTION_POLICY
      const errorPlainObject: ErrorPlainObject = new ProviderError(
        'PROVIDER_SHARED_EXPORTS',
        'provider export works'
      ).toPlainObject()
      const combinedDelta: Delta = delta

      expect(toolSpec.name).toBe('echo')
      expect(toolResult.toolCallId).toBe('tool-call-shared-exports')
      expect(message.role).toBe('assistant')
      expect(runtimeEvent.type).toBe('message.completed')
      expect(sessionSnapshot.messages).toHaveLength(1)
      expect(runSnapshot.pendingOperations).toHaveLength(1)
      expect(artifact.type).toBe('structured-result')
      expect(executionPolicy.tool.timeoutMs).toBeGreaterThan(0)
      expect(errorPlainObject.code).toBe('PROVIDER_SHARED_EXPORTS')
      expect(combinedDelta).toEqual(delta)
    })
  })

  describe('package dependency boundary', () => {
    it('should not depend on internal packages', async () => {
      const pkg = (await import('../../package.json', {
        assert: { type: 'json' },
      })) as { default: PackageJson }
      const dependencies = pkg.default.dependencies || {}

      expect(Object.keys(dependencies).some((name) => name.startsWith('@tianji/'))).toBe(false)
    })
  })
})
