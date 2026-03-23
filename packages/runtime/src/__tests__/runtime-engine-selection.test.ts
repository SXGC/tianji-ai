/**
 * runtime 引擎选择与兼容边界测试。
 *
 * 业务职责：
 * - 校验 runtime 默认只执行 deepagents，并拒绝 legacy 引擎重新启用。
 * - 验证历史 legacy 快照在 runTurn/resumeRun 边界上的错误语义与 metadata 读取行为。
 *
 * 对外触点：
 * - 通过 createSessionRuntime 组装不同引擎配置。
 * - 结合 InMemorySnapshotStore 构造历史 session/run 快照。
 */
import {
  type RunSnapshot,
  type SessionSnapshot,
  TianjiError,
  createRunId,
  createSessionId,
} from '@tianji/contracts'
import { describe, expect, it } from 'vitest'

import {
  createSessionRuntime,
  readRunRuntimeMetadata,
  readSessionRuntimeMetadata,
} from '../runtime.js'
import { InMemorySnapshotStore } from '../snapshot-store.js'
import { ToolRegistry } from '../tool-catalog.js'

function createRuntimeWithLegacyEngineOverride() {
  return createSessionRuntime({
    engine: 'legacy',
    deepagents: {
      model: 'openai:gpt-5.1',
    },
    snapshotStore: new InMemorySnapshotStore(),
    toolCatalog: new ToolRegistry(),
  } as unknown as Parameters<typeof createSessionRuntime>[0])
}

describe('runtime engine selection', () => {
  describe('deepagents-only execution', () => {
    it('defaults to deepagents engine when engine is not specified', async () => {
      const store = new InMemorySnapshotStore()
      const runtime = createSessionRuntime({
        deepagents: {
          model: 'openai:gpt-5.1',
        },
        snapshotStore: store,
        toolCatalog: new ToolRegistry(),
      })

      const session = await runtime.createSession()
      expect(readSessionRuntimeMetadata(session.metadata)?.engine).toBe('deepagents')
    })

    it('rejects explicit legacy engine after final removal', () => {
      expect(() => createRuntimeWithLegacyEngineOverride()).toThrow(TianjiError)

      try {
        createRuntimeWithLegacyEngineOverride()
      } catch (error) {
        expect(error).toBeInstanceOf(TianjiError)
        expect((error as TianjiError).code).toBe('UNSUPPORTED_RUNTIME_ENGINE')
      }
    })

    it('allows resuming with the same deepagents engine after runtime restart', async () => {
      const store = new InMemorySnapshotStore()
      const firstRuntime = createSessionRuntime({
        deepagents: {
          model: 'openai:gpt-5.1',
        },
        snapshotStore: store,
        toolCatalog: new ToolRegistry(),
      })
      const session = await firstRuntime.createSession()
      const secondRuntime = createSessionRuntime({
        deepagents: {
          model: 'openai:gpt-5.1',
        },
        snapshotStore: store,
        toolCatalog: new ToolRegistry(),
      })

      const loaded = await secondRuntime.getSessionSnapshot(session.sessionId)
      expect(loaded).toBeDefined()
      expect(readSessionRuntimeMetadata(loaded?.metadata)?.engine).toBe('deepagents')
    })
  })

  describe('legacy snapshot compatibility boundaries', () => {
    it('rejects runTurn for sessions bound to the legacy engine', async () => {
      const store = new InMemorySnapshotStore()
      const legacySession: SessionSnapshot = {
        sessionId: createSessionId('session-legacy-boundary'),
        messages: [],
        createdAt: 1,
        updatedAt: 1,
        metadata: {
          runtime: { engine: 'legacy' },
        },
      }
      await store.saveSession(legacySession)

      const runtime = createSessionRuntime({
        deepagents: {
          model: 'openai:gpt-5.1',
        },
        snapshotStore: store,
        toolCatalog: new ToolRegistry(),
      })

      await expect(
        runtime.runTurn({
          sessionId: legacySession.sessionId,
          message: {
            id: 'msg-1',
            role: 'user',
            content: [{ type: 'text', text: 'hello' }],
            createdAt: Date.now(),
          },
        })
      ).rejects.toThrow(TianjiError)

      try {
        await runtime.runTurn({
          sessionId: legacySession.sessionId,
          message: {
            id: 'msg-1',
            role: 'user',
            content: [{ type: 'text', text: 'hello' }],
            createdAt: Date.now(),
          },
        })
      } catch (error) {
        expect(error).toBeInstanceOf(TianjiError)
        expect((error as TianjiError).code).toBe('SESSION_ENGINE_MISMATCH')
        expect((error as TianjiError).message).toContain('legacy')
        expect((error as TianjiError).message).toContain('deepagents')
      }
    })

    it('rejects resumeRun when the stored run is bound to the legacy engine', async () => {
      const store = new InMemorySnapshotStore()
      const session: SessionSnapshot = {
        sessionId: createSessionId('session-resume-engine-mismatch'),
        messages: [],
        createdAt: 1,
        updatedAt: 1,
        metadata: {
          runtime: { engine: 'deepagents' },
        },
      }
      await store.saveSession(session)
      const cancelledRunId = createRunId('run-cancelled-legacy')
      const previousRun: RunSnapshot = {
        runId: cancelledRunId,
        sessionId: session.sessionId,
        status: 'cancelled',
        messages: [],
        createdAt: 1,
        updatedAt: 1,
        pendingOperations: [],
        metadata: {
          runtime: { engine: 'legacy' },
        },
      }
      await store.saveRun(previousRun)

      const runtime = createSessionRuntime({
        deepagents: {
          model: 'openai:gpt-5.1',
        },
        snapshotStore: store,
        toolCatalog: new ToolRegistry(),
      })

      await expect(runtime.resumeRun({ runId: cancelledRunId })).rejects.toThrow(TianjiError)

      try {
        await runtime.resumeRun({ runId: cancelledRunId })
      } catch (error) {
        expect(error).toBeInstanceOf(TianjiError)
        expect((error as TianjiError).code).toBe('SESSION_ENGINE_MISMATCH')
        expect((error as TianjiError).message).toContain('legacy')
        expect((error as TianjiError).message).toContain('deepagents')
      }
    })

    it('rejects resumeRun when historical cancelled runs have no runtime engine metadata', async () => {
      const store = new InMemorySnapshotStore()
      const session: SessionSnapshot = {
        sessionId: createSessionId('session-resume-missing-engine'),
        messages: [],
        createdAt: 1,
        updatedAt: 1,
        metadata: {
          runtime: { engine: 'deepagents' },
        },
      }
      await store.saveSession(session)
      const cancelledRunId = createRunId('run-cancelled-missing-engine')
      const previousRun: RunSnapshot = {
        runId: cancelledRunId,
        sessionId: session.sessionId,
        status: 'cancelled',
        messages: [],
        createdAt: 1,
        updatedAt: 1,
        pendingOperations: [],
        metadata: {
          resumedFromRunId: createRunId('previous-run'),
        },
      }
      await store.saveRun(previousRun)

      const runtime = createSessionRuntime({
        deepagents: {
          model: 'openai:gpt-5.1',
        },
        snapshotStore: store,
        toolCatalog: new ToolRegistry(),
      })

      await expect(runtime.resumeRun({ runId: cancelledRunId })).rejects.toThrow(TianjiError)

      try {
        await runtime.resumeRun({ runId: cancelledRunId })
      } catch (error) {
        expect(error).toBeInstanceOf(TianjiError)
        expect((error as TianjiError).code).toBe('SESSION_ENGINE_MISMATCH')
        expect((error as TianjiError).message).toContain('legacy')
        expect((error as TianjiError).message).toContain('deepagents')
      }
    })
  })

  describe('metadata reader functions', () => {
    it('readSessionRuntimeMetadata returns undefined for missing runtime', () => {
      expect(readSessionRuntimeMetadata(undefined)).toBeUndefined()
      expect(readSessionRuntimeMetadata({})).toBeUndefined()
      expect(readSessionRuntimeMetadata({ other: 'field' })).toBeUndefined()
    })

    it('readSessionRuntimeMetadata returns undefined for invalid engine', () => {
      expect(readSessionRuntimeMetadata({ runtime: {} })).toBeUndefined()
      expect(readSessionRuntimeMetadata({ runtime: { engine: 'unknown' } })).toBeUndefined()
      expect(readSessionRuntimeMetadata({ runtime: { engine: null } })).toBeUndefined()
    })

    it('readSessionRuntimeMetadata returns metadata for valid engines', () => {
      expect(readSessionRuntimeMetadata({ runtime: { engine: 'legacy' } })).toEqual({
        engine: 'legacy',
      })
      expect(readSessionRuntimeMetadata({ runtime: { engine: 'deepagents' } })).toEqual({
        engine: 'deepagents',
      })
    })

    it('readRunRuntimeMetadata preserves historical legacy engine markers', () => {
      expect(readRunRuntimeMetadata({ runtime: { engine: 'legacy' } })).toEqual({
        engine: 'legacy',
        threadId: undefined,
        checkpointId: undefined,
      })
    })
  })
})
