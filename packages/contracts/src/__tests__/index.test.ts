/**
 * Tests for @tianji/contracts package exports.
 *
 * This test verifies that the package can be imported and that the barrel export
 * structure is valid. As types are added to the package, tests should be added
 * to verify type definitions compile correctly.
 */
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

/** Minimal type for package.json dependency checking */
interface PackageJson {
  dependencies?: Record<string, string>
}

describe('@tianji/contracts', () => {
  describe('package exports', () => {
    it('should be importable', async () => {
      // Dynamic import to verify the package can be loaded
      const contracts = await import('../index.js')
      expect(contracts).toBeDefined()
    })

    it('should export identifier types and functions', async () => {
      // Package now exports identifier types (SessionId, ThreadId, RunId)
      // and their factory/guard functions
      const contracts = await import('../index.js')
      // Verify identifier exports exist
      expect(contracts.createSessionId).toBeDefined()
      expect(contracts.createThreadId).toBeDefined()
      expect(contracts.createRunId).toBeDefined()
      expect(contracts.isSessionId).toBeDefined()
      expect(contracts.isThreadId).toBeDefined()
      expect(contracts.isRunId).toBeDefined()
    })

    it('should export delta aggregation helpers', async () => {
      const contracts = await import('../index.js')
      expect(contracts.applyMessageDelta).toBeDefined()
      expect(contracts.isComplete).toBeDefined()
    })

    it('should expose the public contracts type surface from the barrel export', () => {
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
        toolCallId: 'tool-call-contracts-exports',
        result: { value: 'ok' },
      }
      const message: AppMessage = {
        id: 'msg-contracts-exports',
        role: 'assistant',
        content: [{ type: 'text', text: 'ready' }],
        createdAt: 1,
      }
      const delta: MessageDelta = {
        runId: createRunId('run-contracts-exports'),
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
        id: 'pending-contracts-exports',
        invocation: {
          toolCallId: toolResult.toolCallId,
          toolName: toolSpec.name,
          args: { value: 'ok' },
        },
        status: 'completed',
        timestamp: 1,
      }
      const sessionSnapshot: SessionSnapshot = {
        sessionId: createSessionId('session-contracts-exports'),
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
        id: 'artifact-contracts-exports',
        type: 'structured-result',
        name: 'contracts-exports-artifact',
        content: { status: 'ok' },
        mimeType: 'text/plain',
        createdAt: 1,
        metadata: { source: 'test' },
      }
      const executionPolicy: ExecutionPolicy = DEFAULT_EXECUTION_POLICY
      const errorPlainObject: ErrorPlainObject = new ProviderError(
        'PROVIDER_CONTRACTS_EXPORTS',
        'provider export works'
      ).toPlainObject()
      const combinedDelta: Delta = delta

      expect(toolSpec.name).toBe('echo')
      expect(toolResult.toolCallId).toBe('tool-call-contracts-exports')
      expect(message.role).toBe('assistant')
      expect(runtimeEvent.type).toBe('message.completed')
      expect(sessionSnapshot.messages).toHaveLength(1)
      expect(runSnapshot.pendingOperations).toHaveLength(1)
      expect(artifact.type).toBe('structured-result')
      expect(executionPolicy.tool.timeoutMs).toBeGreaterThan(0)
      expect(errorPlainObject.code).toBe('PROVIDER_CONTRACTS_EXPORTS')
      expect(combinedDelta).toEqual(delta)
    })
  })

  describe('zero dependency constraint', () => {
    it('should have no runtime dependencies', async () => {
      // Import package.json to verify dependencies constraint
      const pkg = (await import('../../package.json', {
        assert: { type: 'json' },
      })) as { default: PackageJson }
      const dependencies = pkg.default.dependencies || {}
      expect(Object.keys(dependencies)).toHaveLength(0)
    })
  })
})
