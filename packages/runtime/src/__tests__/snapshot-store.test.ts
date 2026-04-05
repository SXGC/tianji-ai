import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  type RunSnapshot,
  type SessionSnapshot,
  createRunId,
  createSessionId,
} from '@tianji/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { FileSnapshotStore, InMemorySnapshotStore } from '../snapshot-store.js'

describe('InMemorySnapshotStore', () => {
  it('saves and loads session snapshots', async () => {
    const store = new InMemorySnapshotStore()
    const snapshot: SessionSnapshot = {
      sessionId: createSessionId('session-memory'),
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    }

    await store.saveSession(snapshot)

    await expect(store.loadSession(snapshot.sessionId)).resolves.toEqual(snapshot)
  })

  it('saves and loads run snapshots', async () => {
    const store = new InMemorySnapshotStore()
    const sessionId = createSessionId('session-run')
    const run: RunSnapshot = {
      runId: createRunId('run-single'),
      sessionId,
      status: 'completed',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
      pendingOperations: [],
    }

    await store.saveRun(run)

    await expect(store.loadRun(run.runId)).resolves.toEqual(run)
  })

  it('lists runs filtered by sessionId and sorted by createdAt', async () => {
    const store = new InMemorySnapshotStore()
    const sessionA = createSessionId('session-a')
    const sessionB = createSessionId('session-b')
    const runA1: RunSnapshot = {
      runId: createRunId('run-a1'),
      sessionId: sessionA,
      status: 'completed',
      messages: [],
      createdAt: 2,
      updatedAt: 2,
      pendingOperations: [],
    }
    const runA2: RunSnapshot = {
      runId: createRunId('run-a2'),
      sessionId: sessionA,
      status: 'completed',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
      pendingOperations: [],
    }
    const runB1: RunSnapshot = {
      runId: createRunId('run-b1'),
      sessionId: sessionB,
      status: 'running',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
      pendingOperations: [],
    }

    await store.saveRun(runA1)
    await store.saveRun(runA2)
    await store.saveRun(runB1)

    await expect(store.listRuns(sessionA)).resolves.toEqual([runA2, runA1])
    await expect(store.listRuns(sessionB)).resolves.toEqual([runB1])
  })

  it('returns undefined for non-existent session or run', async () => {
    const store = new InMemorySnapshotStore()

    await expect(store.loadSession(createSessionId('ghost'))).resolves.toBeUndefined()
    await expect(store.loadRun(createRunId('ghost'))).resolves.toBeUndefined()
    await expect(store.listRuns(createSessionId('ghost'))).resolves.toEqual([])
  })

  it('overwrites snapshot on duplicate save', async () => {
    const store = new InMemorySnapshotStore()
    const sessionId = createSessionId('session-overwrite')
    const first: SessionSnapshot = {
      sessionId,
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    }
    const second: SessionSnapshot = {
      sessionId,
      messages: [],
      createdAt: 1,
      updatedAt: 2,
    }

    await store.saveSession(first)
    await store.saveSession(second)

    const loaded = await store.loadSession(sessionId)
    expect(loaded?.updatedAt).toBe(2)
  })

  it('clones on save and load to ensure isolation', async () => {
    const store = new InMemorySnapshotStore()
    const sessionId = createSessionId('session-clone')
    const snapshot: SessionSnapshot = {
      sessionId,
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    }

    await store.saveSession(snapshot)

    // Mutate original after save — stored copy should be unaffected
    ;(snapshot as SessionSnapshot & { messages: unknown[] }).messages.push({ role: 'system' })

    const loaded = await store.loadSession(sessionId)
    expect(loaded?.messages).toEqual([])

    // Mutate the loaded copy — stored copy should still be unaffected
    ;(loaded as SessionSnapshot & { messages: unknown[] }).messages.push({ role: 'user' })

    // Reload should still have empty messages
    const reloaded = await store.loadSession(sessionId)
    expect(reloaded?.messages).toEqual([])
  })
})

describe('FileSnapshotStore', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'tianji-runtime-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('saves and loads session snapshots', async () => {
    const store = new FileSnapshotStore(directory)
    const snapshot: SessionSnapshot = {
      sessionId: createSessionId('session-file-load'),
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    }

    await store.saveSession(snapshot)

    await expect(store.loadSession(snapshot.sessionId)).resolves.toEqual(snapshot)
  })

  it('returns undefined for non-existent session or run', async () => {
    const store = new FileSnapshotStore(directory)

    await expect(store.loadSession(createSessionId('ghost'))).resolves.toBeUndefined()
    await expect(store.loadRun(createRunId('ghost'))).resolves.toBeUndefined()
  })

  it('returns empty array when listing runs for session with no runs directory', async () => {
    const store = new FileSnapshotStore(directory)

    await expect(store.listRuns(createSessionId('ghost'))).resolves.toEqual([])
  })

  it('overwrites run snapshot on duplicate save', async () => {
    const store = new FileSnapshotStore(directory)
    const sessionId = createSessionId('session-overwrite-file')
    const runId = createRunId('run-overwrite')
    const first: RunSnapshot = {
      runId,
      sessionId,
      status: 'running',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
      pendingOperations: [],
    }
    const second: RunSnapshot = {
      runId,
      sessionId,
      status: 'completed',
      messages: [],
      createdAt: 1,
      updatedAt: 2,
      pendingOperations: [],
    }

    await store.saveRun(first)
    await store.saveRun(second)

    const loaded = await store.loadRun(runId)
    expect(loaded?.status).toBe('completed')
  })

  it('saves run snapshots and lists them by session', async () => {
    const store = new FileSnapshotStore(directory)
    const sessionId = createSessionId('session-file')
    const firstRun: RunSnapshot = {
      runId: createRunId('run-1'),
      sessionId,
      status: 'completed',
      messages: [],
      createdAt: 2,
      updatedAt: 2,
      pendingOperations: [],
    }
    const secondRun: RunSnapshot = {
      runId: createRunId('run-2'),
      sessionId,
      status: 'cancelled',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
      pendingOperations: [],
    }

    await store.saveRun(firstRun)
    await store.saveRun(secondRun)

    await expect(store.loadRun(firstRun.runId)).resolves.toEqual(firstRun)
    // secondRun has createdAt=1, firstRun has createdAt=2 — sorted ascending by createdAt
    await expect(store.listRuns(sessionId)).resolves.toEqual([secondRun, firstRun])
  })
})
