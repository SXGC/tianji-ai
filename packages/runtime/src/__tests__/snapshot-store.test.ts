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
})

describe('FileSnapshotStore', () => {
  let directory: string

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'tianji-runtime-'))
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  it('saves run snapshots and lists them by session', async () => {
    const store = new FileSnapshotStore(directory)
    const sessionId = createSessionId('session-file')
    const firstRun: RunSnapshot = {
      runId: createRunId('run-1'),
      sessionId,
      status: 'completed',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
      pendingOperations: [],
    }
    const secondRun: RunSnapshot = {
      runId: createRunId('run-2'),
      sessionId,
      status: 'cancelled',
      messages: [],
      createdAt: 2,
      updatedAt: 2,
      pendingOperations: [],
    }

    await store.saveRun(firstRun)
    await store.saveRun(secondRun)

    await expect(store.loadRun(firstRun.runId)).resolves.toEqual(firstRun)
    await expect(store.listRuns(sessionId)).resolves.toEqual([firstRun, secondRun])
  })
})
