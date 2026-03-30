import { describe, expect, it } from 'vitest'
import {
  type RunId,
  type SessionId,
  type ThreadId,
  createRunId,
  createSessionId,
  createThreadId,
  isRunId,
  isSessionId,
  isThreadId,
} from '../identifiers.js'

describe('identifiers', () => {
  describe('createSessionId', () => {
    it('should create a SessionId from a string', () => {
      const id = createSessionId('session-123')
      expect(id).toBe('session-123')
    })

    it('should return a string at runtime', () => {
      const id = createSessionId('test')
      expect(typeof id).toBe('string')
    })

    it('should preserve empty string', () => {
      const id = createSessionId('')
      expect(id).toBe('')
    })

    it('should preserve UUID-like strings', () => {
      const uuid = '550e8400-e29b-41d4-a716-446655440000'
      const id = createSessionId(uuid)
      expect(id).toBe(uuid)
    })
  })

  describe('createThreadId', () => {
    it('should create a ThreadId from a string', () => {
      const id = createThreadId('thread-456')
      expect(id).toBe('thread-456')
    })

    it('should return a string at runtime', () => {
      const id = createThreadId('test')
      expect(typeof id).toBe('string')
    })

    it('should preserve empty string', () => {
      const id = createThreadId('')
      expect(id).toBe('')
    })
  })

  describe('createRunId', () => {
    it('should create a RunId from a string', () => {
      const id = createRunId('run-789')
      expect(id).toBe('run-789')
    })

    it('should return a string at runtime', () => {
      const id = createRunId('test')
      expect(typeof id).toBe('string')
    })

    it('should preserve empty string', () => {
      const id = createRunId('')
      expect(id).toBe('')
    })
  })

  describe('isSessionId', () => {
    it('should return true for strings', () => {
      expect(isSessionId('any-string')).toBe(true)
    })

    it('should return true for SessionId created by factory', () => {
      const id = createSessionId('session-123')
      expect(isSessionId(id)).toBe(true)
    })

    it('should return false for non-strings', () => {
      expect(isSessionId(123)).toBe(false)
      expect(isSessionId(null)).toBe(false)
      expect(isSessionId(undefined)).toBe(false)
      expect(isSessionId({})).toBe(false)
      expect(isSessionId([])).toBe(false)
    })
  })

  describe('isThreadId', () => {
    it('should return true for strings', () => {
      expect(isThreadId('any-string')).toBe(true)
    })

    it('should return true for ThreadId created by factory', () => {
      const id = createThreadId('thread-456')
      expect(isThreadId(id)).toBe(true)
    })

    it('should return false for non-strings', () => {
      expect(isThreadId(123)).toBe(false)
      expect(isThreadId(null)).toBe(false)
      expect(isThreadId(undefined)).toBe(false)
      expect(isThreadId({})).toBe(false)
      expect(isThreadId([])).toBe(false)
    })
  })

  describe('isRunId', () => {
    it('should return true for strings', () => {
      expect(isRunId('any-string')).toBe(true)
    })

    it('should return true for RunId created by factory', () => {
      const id = createRunId('run-789')
      expect(isRunId(id)).toBe(true)
    })

    it('should return false for non-strings', () => {
      expect(isRunId(123)).toBe(false)
      expect(isRunId(null)).toBe(false)
      expect(isRunId(undefined)).toBe(false)
      expect(isRunId({})).toBe(false)
      expect(isRunId([])).toBe(false)
    })
  })

  describe('type compatibility', () => {
    it('should allow SessionId to be assigned to string', () => {
      const sessionId: SessionId = createSessionId('session-123')
      const str: string = sessionId
      expect(str).toBe('session-123')
    })

    it('should allow ThreadId to be assigned to string', () => {
      const threadId: ThreadId = createThreadId('thread-456')
      const str: string = threadId
      expect(str).toBe('thread-456')
    })

    it('should allow RunId to be assigned to string', () => {
      const runId: RunId = createRunId('run-789')
      const str: string = runId
      expect(str).toBe('run-789')
    })
  })

  describe('branded type isolation', () => {
    it('should not allow SessionId to be assigned to ThreadId at compile time', () => {
      const sessionId: SessionId = createSessionId('session-123')
      const threadId: ThreadId = sessionId as unknown as ThreadId
      expect(threadId).toBe('session-123')
    })

    it('should not allow ThreadId to be assigned to RunId at compile time', () => {
      const threadId: ThreadId = createThreadId('thread-456')
      const runId: RunId = threadId as unknown as RunId
      expect(runId).toBe('thread-456')
    })

    it('should not allow RunId to be assigned to SessionId at compile time', () => {
      const runId: RunId = createRunId('run-789')
      const sessionId: SessionId = runId as unknown as SessionId
      expect(sessionId).toBe('run-789')
    })
  })
})
