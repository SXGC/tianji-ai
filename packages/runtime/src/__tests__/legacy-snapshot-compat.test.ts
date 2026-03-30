/**
 * 历史快照兼容性测试。
 *
 * 业务职责：
 * - 校验 legacy/deepagents 运行时元数据读取器对历史快照的兼容行为。
 * - 确保未携带 runtime 元数据的旧快照仍可被当前 runtime 安全加载。
 *
 * 对外触点：
 * - 调用 runtime.ts 暴露的 metadata 读取函数。
 * - 使用 InMemorySnapshotStore 模拟历史 session/run 快照持久化。
 */
import {
  type RunSnapshot,
  type SessionSnapshot,
  createRunId,
  createSessionId,
} from '@tianji/shared'
import { describe, expect, it } from 'vitest'

import {
  type SessionRuntimeOptions,
  createSessionRuntime,
  readRunRuntimeMetadata,
  readSessionRuntimeMetadata,
} from '../runtime.js'
import { InMemorySnapshotStore } from '../snapshot-store.js'

describe('legacy snapshot compatibility', () => {
  describe('readSessionRuntimeMetadata', () => {
    it('returns undefined for metadata without runtime field', () => {
      const metadata = { systemPrompt: 'test prompt' }
      expect(readSessionRuntimeMetadata(metadata)).toBeUndefined()
    })

    it('returns undefined for metadata with null runtime', () => {
      const metadata = { runtime: null }
      expect(readSessionRuntimeMetadata(metadata)).toBeUndefined()
    })

    it('returns undefined for metadata with invalid engine value', () => {
      const metadata = { runtime: { engine: 'invalid' } }
      expect(readSessionRuntimeMetadata(metadata)).toBeUndefined()
    })

    it('returns metadata for valid legacy engine', () => {
      const metadata = { runtime: { engine: 'legacy' } }
      expect(readSessionRuntimeMetadata(metadata)).toEqual({ engine: 'legacy' })
    })

    it('returns metadata for valid deepagents engine', () => {
      const metadata = { runtime: { engine: 'deepagents' } }
      expect(readSessionRuntimeMetadata(metadata)).toEqual({ engine: 'deepagents' })
    })
  })

  describe('readRunRuntimeMetadata', () => {
    it('returns undefined for metadata without runtime field', () => {
      const metadata = { systemPrompt: 'test', generationConfig: {} }
      expect(readRunRuntimeMetadata(metadata)).toBeUndefined()
    })

    it('returns metadata with only engine for legacy runs', () => {
      const metadata = { runtime: { engine: 'legacy' } }
      expect(readRunRuntimeMetadata(metadata)).toEqual({
        engine: 'legacy',
        threadId: undefined,
        checkpointId: undefined,
      })
    })

    it('returns metadata with threadId and checkpointId for deepagents runs', () => {
      const metadata = {
        runtime: {
          engine: 'deepagents',
          threadId: 'thread-123',
          checkpointId: 'checkpoint-456',
        },
      }
      expect(readRunRuntimeMetadata(metadata)).toEqual({
        engine: 'deepagents',
        threadId: 'thread-123',
        checkpointId: 'checkpoint-456',
      })
    })

    it('ignores non-string threadId and checkpointId', () => {
      const metadata = {
        runtime: {
          engine: 'deepagents',
          threadId: 123,
          checkpointId: null,
        },
      }
      expect(readRunRuntimeMetadata(metadata)).toEqual({
        engine: 'deepagents',
        threadId: undefined,
        checkpointId: undefined,
      })
    })
  })

  describe('session snapshot without runtime metadata', () => {
    it('can be loaded and defaults to legacy engine', async () => {
      const store = new InMemorySnapshotStore()

      const legacySession: SessionSnapshot = {
        sessionId: createSessionId('legacy-session'),
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: {
          systemPrompt: 'legacy prompt',
          customField: 'custom value',
        },
      }

      await store.saveSession(legacySession)

      const loaded = await store.loadSession(legacySession.sessionId)
      expect(loaded).toBeDefined()
      expect(loaded?.metadata?.systemPrompt).toBe('legacy prompt')
      expect(loaded?.metadata?.runtime).toBeUndefined()
    })
  })

  describe('run snapshot without runtime metadata', () => {
    it('can be loaded and preserves existing metadata fields', async () => {
      const store = new InMemorySnapshotStore()

      const legacyRun: RunSnapshot = {
        runId: createRunId('legacy-run'),
        sessionId: createSessionId('session'),
        status: 'completed',
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        pendingOperations: [],
        metadata: {
          systemPrompt: 'legacy system prompt',
          generationConfig: { maxTokens: 1000 },
          resumedFromRunId: createRunId('previous-run'),
        },
      }

      await store.saveRun(legacyRun)

      const loaded = await store.loadRun(legacyRun.runId)
      expect(loaded).toBeDefined()
      expect(loaded?.metadata?.systemPrompt).toBe('legacy system prompt')
      expect(loaded?.metadata?.resumedFromRunId).toBeDefined()
      expect(loaded?.metadata?.runtime).toBeUndefined()
    })
  })

  describe('session snapshot with runtime metadata', () => {
    it('preserves runtime metadata when loading', async () => {
      const store = new InMemorySnapshotStore()

      const sessionWithRuntime: SessionSnapshot = {
        sessionId: createSessionId('session-with-runtime'),
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        metadata: {
          runtime: { engine: 'deepagents' },
          customField: 'value',
        },
      }

      await store.saveSession(sessionWithRuntime)

      const loaded = await store.loadSession(sessionWithRuntime.sessionId)
      expect(loaded).toBeDefined()
      expect(readSessionRuntimeMetadata(loaded?.metadata)).toEqual({ engine: 'deepagents' })
    })
  })
})
