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
    it('should define running status', () => {
      const status: RunStatus = 'running'
      expect(status).toBe('running')
    })

    it('should define completed status', () => {
      const status: RunStatus = 'completed'
      expect(status).toBe('completed')
    })

    it('should define failed status', () => {
      const status: RunStatus = 'failed'
      expect(status).toBe('failed')
    })

    it('should define cancelled status', () => {
      const status: RunStatus = 'cancelled'
      expect(status).toBe('cancelled')
    })

    it('should be assignable to string', () => {
      const status: RunStatus = 'running'
      const str: string = status
      expect(str).toBe('running')
    })

    it('should allow type narrowing with switch', () => {
      const statuses: RunStatus[] = ['running', 'completed', 'failed', 'cancelled']

      for (const status of statuses) {
        let result: string
        switch (status) {
          case 'running':
            result = 'active'
            break
          case 'completed':
            result = 'done'
            break
          case 'failed':
            result = 'error'
            break
          case 'cancelled':
            result = 'stopped'
            break
        }
        expect(result).toBeDefined()
      }
    })
  })

  describe('PendingOperationStatus', () => {
    it('should define running status', () => {
      const status: PendingOperationStatus = 'running'
      expect(status).toBe('running')
    })

    it('should define completed status', () => {
      const status: PendingOperationStatus = 'completed'
      expect(status).toBe('completed')
    })

    it('should define aborted-clean status', () => {
      const status: PendingOperationStatus = 'aborted-clean'
      expect(status).toBe('aborted-clean')
    })

    it('should define aborted-with-side-effect status', () => {
      const status: PendingOperationStatus = 'aborted-with-side-effect'
      expect(status).toBe('aborted-with-side-effect')
    })

    it('should be assignable to string', () => {
      const status: PendingOperationStatus = 'running'
      const str: string = status
      expect(str).toBe('running')
    })
  })

  describe('ResumeHint', () => {
    it('should define replay hint', () => {
      const hint: ResumeHint = 'replay'
      expect(hint).toBe('replay')
    })

    it('should define skip hint', () => {
      const hint: ResumeHint = 'skip'
      expect(hint).toBe('skip')
    })

    it('should define require-user-confirmation hint', () => {
      const hint: ResumeHint = 'require-user-confirmation'
      expect(hint).toBe('require-user-confirmation')
    })

    it('should be assignable to string', () => {
      const hint: ResumeHint = 'replay'
      const str: string = hint
      expect(str).toBe('replay')
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
    it('should accept all status values', () => {
      const statuses: PendingOperationStatus[] = [
        'running',
        'completed',
        'aborted-clean',
        'aborted-with-side-effect',
      ]
      for (const status of statuses) {
        const op: PendingOperation = {
          id: `op_${status}`,
          invocation,
          status,
          timestamp,
        }
        expect(op.status).toBe(status)
      }
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
      expect(snapshot.createdAt).toBe(timestamp)
      expect(snapshot.updatedAt).toBe(timestamp)
    })
    it('should include optional metadata', () => {
      const snapshot: SessionSnapshot = {
        sessionId,
        messages: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        metadata: {
          source: 'test',
          version: '1.0',
        },
      }
      expect(snapshot.metadata).toBeDefined()
      expect(snapshot.metadata?.source).toBe('test')
    })
    it('should include optional policy', () => {
      const snapshot: SessionSnapshot = {
        sessionId,
        messages: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        policy: DEFAULT_EXECUTION_POLICY,
      }
      expect(snapshot.policy).toBeDefined()
      expect(snapshot.policy?.retry.maxAttempts).toBe(3)
    })
    it('should work without optional fields', () => {
      const snapshot: SessionSnapshot = {
        sessionId,
        messages: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      expect(snapshot.metadata).toBeUndefined()
      expect(snapshot.policy).toBeUndefined()
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
      expect(snapshot.sessionId).toBe(sessionId)
      expect(snapshot.status).toBe('running')
      expect(snapshot.messages).toEqual([])
      expect(snapshot.createdAt).toBe(timestamp)
      expect(snapshot.updatedAt).toBe(timestamp)
      expect(snapshot.pendingOperations).toEqual([])
    })
    it('should include optional cancelPoint', () => {
      const snapshot: RunSnapshot = {
        runId,
        sessionId,
        status: 'cancelled',
        messages: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        pendingOperations: [],
        cancelPoint: 'step-3',
      }
      expect(snapshot.cancelPoint).toBe('step-3')
    })
    it('should include optional resumeHint', () => {
      const snapshot: RunSnapshot = {
        runId,
        sessionId,
        status: 'cancelled',
        messages: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        pendingOperations: [],
        resumeHint: 'skip',
      }
      expect(snapshot.resumeHint).toBe('skip')
    })
    it('should include optional workflowState', () => {
      const snapshot: RunSnapshot = {
        runId,
        sessionId,
        status: 'running',
        messages: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        pendingOperations: [],
        workflowState: { currentNode: 'agent', step: 5 },
      }
      expect(snapshot.workflowState).toBeDefined()
      expect((snapshot.workflowState as { currentNode: string }).currentNode).toBe('agent')
    })
    it('should include optional policy', () => {
      const snapshot: RunSnapshot = {
        runId,
        sessionId,
        status: 'running',
        messages: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        pendingOperations: [],
        policy: DEFAULT_EXECUTION_POLICY,
      }
      expect(snapshot.policy).toBeDefined()
    })
    it('should include optional metadata', () => {
      const snapshot: RunSnapshot = {
        runId,
        sessionId,
        status: 'running',
        messages: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        pendingOperations: [],
        metadata: {
          attempt: 2,
          lastError: 'timeout',
        },
      }
      expect(snapshot.metadata).toBeDefined()
      expect(snapshot.metadata?.attempt).toBe(2)
    })
    it('should work without optional fields', () => {
      const snapshot: RunSnapshot = {
        runId,
        sessionId,
        status: 'completed',
        messages: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        pendingOperations: [],
      }
      expect(snapshot.cancelPoint).toBeUndefined()
      expect(snapshot.resumeHint).toBeUndefined()
      expect(snapshot.workflowState).toBeUndefined()
      expect(snapshot.policy).toBeUndefined()
      expect(snapshot.metadata).toBeUndefined()
    })
    it('should support cancelled run with pending operations', () => {
      const op: PendingOperation = {
        id: 'op_001',
        invocation: {
          toolCallId: 'call_001',
          toolName: 'read_file',
          args: { path: '/test.txt' },
        },
        status: 'aborted-clean',
        timestamp,
      }
      const snapshot: RunSnapshot = {
        runId,
        sessionId,
        status: 'cancelled',
        messages: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        pendingOperations: [op],
        cancelPoint: 'tool_execution',
        resumeHint: 'skip',
      }
      expect(snapshot.pendingOperations).toHaveLength(1)
      expect(snapshot.pendingOperations[0].status).toBe('aborted-clean')
    })
  })
})
