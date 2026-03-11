/**
 * Tests for @tianji/contracts package exports.
 *
 * This test verifies that the package can be imported and that the barrel export
 * structure is valid. As types are added to the package, tests should be added
 * to verify type definitions compile correctly.
 */
import { describe, expect, it } from 'vitest'

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
