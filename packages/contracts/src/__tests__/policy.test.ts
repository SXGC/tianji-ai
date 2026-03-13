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

    it('should accept valid values', () => {
      const policy: RetryPolicy = {
        maxAttempts: 1,
        baseDelayMs: 100,
        maxDelayMs: 5000,
      }

      expect(policy.maxAttempts).toBeTypeOf('number')
      expect(policy.baseDelayMs).toBeTypeOf('number')
      expect(policy.maxDelayMs).toBeTypeOf('number')
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

    it('should accept valid values', () => {
      const policy: ToolPolicy = {
        timeoutMs: 60000,
        maxConcurrency: 10,
        allowDestructive: true,
      }

      expect(policy.timeoutMs).toBeTypeOf('number')
      expect(policy.maxConcurrency).toBeTypeOf('number')
      expect(policy.allowDestructive).toBeTypeOf('boolean')
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

    it('should accept valid values', () => {
      const policy: PathPolicy = {
        forbidDirectories: ['/etc', '/root'],
        filenameDenyPatterns: ['\\.env$', '.*\\.key$'],
      }

      expect(Array.isArray(policy.forbidDirectories)).toBe(true)
      expect(Array.isArray(policy.filenameDenyPatterns)).toBe(true)
      expect(policy.forbidDirectories).toContain('/etc')
      expect(policy.filenameDenyPatterns).toContain('\\.env$')
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

    it('should have valid retry policy defaults', () => {
      const { retry } = DEFAULT_EXECUTION_POLICY

      expect(retry.maxAttempts).toBeTypeOf('number')
      expect(retry.maxAttempts).toBeGreaterThan(0)
      expect(retry.baseDelayMs).toBeTypeOf('number')
      expect(retry.baseDelayMs).toBeGreaterThan(0)
      expect(retry.maxDelayMs).toBeTypeOf('number')
      expect(retry.maxDelayMs).toBeGreaterThan(0)
      expect(retry.maxDelayMs).toBeGreaterThanOrEqual(retry.baseDelayMs)
    })

    it('should have valid tool policy defaults', () => {
      const { tool } = DEFAULT_EXECUTION_POLICY

      expect(tool.timeoutMs).toBeTypeOf('number')
      expect(tool.timeoutMs).toBeGreaterThan(0)
      expect(tool.maxConcurrency).toBeTypeOf('number')
      expect(tool.maxConcurrency).toBeGreaterThan(0)
      expect(tool.allowDestructive).toBeTypeOf('boolean')
      expect(tool.allowDestructive).toBe(false) // Safe default
    })

    it('should have valid path policy defaults', () => {
      const { toolPath } = DEFAULT_EXECUTION_POLICY

      expect(Array.isArray(toolPath.forbidDirectories)).toBe(true)
      expect(Array.isArray(toolPath.filenameDenyPatterns)).toBe(true)
    })

    it('should have all required fields', () => {
      expect(DEFAULT_EXECUTION_POLICY).toHaveProperty('retry')
      expect(DEFAULT_EXECUTION_POLICY).toHaveProperty('retry.maxAttempts')
      expect(DEFAULT_EXECUTION_POLICY).toHaveProperty('retry.baseDelayMs')
      expect(DEFAULT_EXECUTION_POLICY).toHaveProperty('retry.maxDelayMs')
      expect(DEFAULT_EXECUTION_POLICY).toHaveProperty('tool')
      expect(DEFAULT_EXECUTION_POLICY).toHaveProperty('tool.timeoutMs')
      expect(DEFAULT_EXECUTION_POLICY).toHaveProperty('tool.maxConcurrency')
      expect(DEFAULT_EXECUTION_POLICY).toHaveProperty('tool.allowDestructive')
      expect(DEFAULT_EXECUTION_POLICY).toHaveProperty('toolPath')
      expect(DEFAULT_EXECUTION_POLICY).toHaveProperty('toolPath.forbidDirectories')
      expect(DEFAULT_EXECUTION_POLICY).toHaveProperty('toolPath.filenameDenyPatterns')
    })

    it('should match ExecutionPolicy type', () => {
      const policy: ExecutionPolicy = DEFAULT_EXECUTION_POLICY
      expect(policy).toBe(DEFAULT_EXECUTION_POLICY)
    })

    it('should have reasonable default values', () => {
      // Retry: 3 attempts with 1-30 second backoff
      expect(DEFAULT_EXECUTION_POLICY.retry.maxAttempts).toBe(3)
      expect(DEFAULT_EXECUTION_POLICY.retry.baseDelayMs).toBe(1000)
      expect(DEFAULT_EXECUTION_POLICY.retry.maxDelayMs).toBe(30000)

      // Tool: 30s timeout, 5 concurrent, no destructive
      expect(DEFAULT_EXECUTION_POLICY.tool.timeoutMs).toBe(30000)
      expect(DEFAULT_EXECUTION_POLICY.tool.maxConcurrency).toBe(5)
      expect(DEFAULT_EXECUTION_POLICY.tool.allowDestructive).toBe(false)

      // Path: No restrictions by default
      expect(DEFAULT_EXECUTION_POLICY.toolPath.forbidDirectories).toEqual([])
      expect(DEFAULT_EXECUTION_POLICY.toolPath.filenameDenyPatterns).toEqual([])
    })
  })
})
