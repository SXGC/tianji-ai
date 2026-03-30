import { describe, expect, it } from 'vitest'
import {
  DEFAULT_EXECUTION_POLICY,
  type ExecutionPolicy,
  type PathPolicy,
  type RetryPolicy,
  type ToolPolicy,
} from '../policy.js'

describe('policy types', () => {
  describe('RetryPolicy', () => {
    it('should define required fields', () => {
      const policy: RetryPolicy = {
        maxAttempts: 3,
        baseDelayMs: 1000,
        maxDelayMs: 30000,
      }

      expect(policy.maxAttempts).toBe(3)
      expect(policy.baseDelayMs).toBe(1000)
      expect(policy.maxDelayMs).toBe(30000)
    })
  })

  describe('ToolPolicy', () => {
    it('should define required fields', () => {
      const policy: ToolPolicy = {
        timeoutMs: 30000,
        maxConcurrency: 5,
        allowDestructive: false,
      }

      expect(policy.timeoutMs).toBe(30000)
      expect(policy.maxConcurrency).toBe(5)
      expect(policy.allowDestructive).toBe(false)
    })
  })

  describe('PathPolicy', () => {
    it('should define required fields', () => {
      const policy: PathPolicy = {
        forbidDirectories: [],
        filenameDenyPatterns: [],
      }

      expect(policy.forbidDirectories).toEqual([])
      expect(policy.filenameDenyPatterns).toEqual([])
    })
  })

  describe('ExecutionPolicy', () => {
    it('should define required nested fields', () => {
      const policy: ExecutionPolicy = {
        retry: {
          maxAttempts: 3,
          baseDelayMs: 1000,
          maxDelayMs: 30000,
        },
        tool: {
          timeoutMs: 30000,
          maxConcurrency: 5,
          allowDestructive: false,
        },
        toolPath: {
          forbidDirectories: [],
          filenameDenyPatterns: [],
        },
      }

      expect(policy.retry).toBeDefined()
      expect(policy.tool).toBeDefined()
      expect(policy.toolPath).toBeDefined()
    })
  })

  describe('DEFAULT_EXECUTION_POLICY', () => {
    it('should be defined', () => {
      expect(DEFAULT_EXECUTION_POLICY).toBeDefined()
    })

    it('should have reasonable default values', () => {
      expect(DEFAULT_EXECUTION_POLICY.retry.maxAttempts).toBe(3)
      expect(DEFAULT_EXECUTION_POLICY.retry.baseDelayMs).toBe(1000)
      expect(DEFAULT_EXECUTION_POLICY.retry.maxDelayMs).toBe(30000)
      expect(DEFAULT_EXECUTION_POLICY.tool.timeoutMs).toBe(30000)
      expect(DEFAULT_EXECUTION_POLICY.tool.maxConcurrency).toBe(5)
      expect(DEFAULT_EXECUTION_POLICY.tool.allowDestructive).toBe(false)
      expect(DEFAULT_EXECUTION_POLICY.toolPath.forbidDirectories).toEqual([])
      expect(DEFAULT_EXECUTION_POLICY.toolPath.filenameDenyPatterns).toEqual([])
    })
  })
})
