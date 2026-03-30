import { describe, expect, it } from 'vitest'
import { createRunId, createSessionId } from '../identifiers.js'
import { DEFAULT_EXECUTION_POLICY } from '../policy.js'
import type {
  PendingOperation,
  PendingOperationStatus,
  ResumeHint,
  RunSnapshot,
  RunStatus,
  SessionSnapshot,
} from '../snapshot.js'
import type { ToolInvocation } from '../tool.js'

describe('snapshot types', () => {
  const sessionId = createSessionId('session_001')
  const runId = createRunId('run_001')
  const timestamp = Date.now()

  describe('RunStatus', () => {
    it('should define all supported statuses', () => {
      const statuses: RunStatus[] = ['running', 'completed', 'failed', 'cancelled']
      expect(statuses).toHaveLength(4)
    })
  })

  describe('PendingOperationStatus', () => {
    it('should define all supported statuses', () => {
      const statuses: PendingOperationStatus[] = [
        'running',
        'completed',
        'aborted-clean',
        'aborted-with-side-effect',
      ]
      expect(statuses).toHaveLength(4)
    })
  })

  describe('ResumeHint', () => {
    it('should define all supported hints', () => {
      const hints: ResumeHint[] = ['replay', 'skip', 'require-user-confirmation']
      expect(hints).toHaveLength(3)
    })
  })

  describe('PendingOperation', () => {
    const invocation: ToolInvocation = {
      toolCallId: 'call_001',
      toolName: 'test_tool',
      args: { input: 'test' },
    }

    it('should define required fields', () => {
      const op: PendingOperation = {
        id: 'op_001',
        invocation,
        status: 'running',
        timestamp,
      }
      expect(op.id).toBe('op_001')
      expect(op.invocation).toBe(invocation)
      expect(op.status).toBe('running')
      expect(op.timestamp).toBe(timestamp)
    })
  })

  describe('SessionSnapshot', () => {
    it('should define required fields', () => {
      const snapshot: SessionSnapshot = {
        sessionId,
        messages: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      expect(snapshot.sessionId).toBe(sessionId)
      expect(snapshot.messages).toEqual([])
    })

    it('should include optional policy', () => {
      const snapshot: SessionSnapshot = {
        sessionId,
        messages: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        policy: DEFAULT_EXECUTION_POLICY,
      }
      expect(snapshot.policy?.retry.maxAttempts).toBe(3)
    })
  })

  describe('RunSnapshot', () => {
    it('should define required fields', () => {
      const snapshot: RunSnapshot = {
        runId,
        sessionId,
        status: 'running',
        messages: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        pendingOperations: [],
      }
      expect(snapshot.runId).toBe(runId)
      expect(snapshot.pendingOperations).toEqual([])
    })

    it('should include optional workflowState and metadata', () => {
      const snapshot: RunSnapshot = {
        runId,
        sessionId,
        status: 'running',
        messages: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        pendingOperations: [],
        workflowState: { currentNode: 'agent', step: 5 },
        metadata: { attempt: 2 },
      }
      expect((snapshot.workflowState as { currentNode: string }).currentNode).toBe('agent')
      expect(snapshot.metadata?.attempt).toBe(2)
    })
  })
})
