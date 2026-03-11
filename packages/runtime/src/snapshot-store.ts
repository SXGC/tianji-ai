import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { RunId, RunSnapshot, SessionId, SessionSnapshot } from '@tianji/contracts'
import { deepClone } from '@tianji/shared'

export interface SnapshotStore {
  readonly saveSession: (snapshot: SessionSnapshot) => Promise<void>
  readonly saveRun: (snapshot: RunSnapshot) => Promise<void>
  readonly loadSession: (sessionId: SessionId) => Promise<SessionSnapshot | undefined>
  readonly loadRun: (runId: RunId) => Promise<RunSnapshot | undefined>
  readonly listRuns: (sessionId: SessionId) => Promise<readonly RunSnapshot[]>
}

export class InMemorySnapshotStore implements SnapshotStore {
  private readonly sessions = new Map<SessionId, SessionSnapshot>()
  private readonly runs = new Map<RunId, RunSnapshot>()

  readonly saveSession = async (snapshot: SessionSnapshot): Promise<void> => {
    this.sessions.set(snapshot.sessionId, deepClone(snapshot))
  }

  readonly saveRun = async (snapshot: RunSnapshot): Promise<void> => {
    this.runs.set(snapshot.runId, deepClone(snapshot))
  }

  readonly loadSession = async (sessionId: SessionId): Promise<SessionSnapshot | undefined> => {
    const snapshot = this.sessions.get(sessionId)
    return snapshot === undefined ? undefined : deepClone(snapshot)
  }

  readonly loadRun = async (runId: RunId): Promise<RunSnapshot | undefined> => {
    const snapshot = this.runs.get(runId)
    return snapshot === undefined ? undefined : deepClone(snapshot)
  }

  readonly listRuns = async (sessionId: SessionId): Promise<readonly RunSnapshot[]> => {
    return [...this.runs.values()]
      .filter((snapshot) => snapshot.sessionId === sessionId)
      .sort((left, right) => left.createdAt - right.createdAt)
      .map((snapshot) => deepClone(snapshot))
  }
}

export class FileSnapshotStore implements SnapshotStore {
  constructor(private readonly baseDirectory: string) {}

  readonly saveSession = async (snapshot: SessionSnapshot): Promise<void> => {
    const sessionsDirectory = join(this.baseDirectory, 'sessions')
    await mkdir(sessionsDirectory, { recursive: true })
    await writeJsonAtomically(join(sessionsDirectory, `${snapshot.sessionId}.json`), snapshot)
  }

  readonly saveRun = async (snapshot: RunSnapshot): Promise<void> => {
    const runsDirectory = join(this.baseDirectory, 'runs')
    await mkdir(runsDirectory, { recursive: true })
    await writeJsonAtomically(join(runsDirectory, `${snapshot.runId}.json`), snapshot)
  }

  readonly loadSession = async (sessionId: SessionId): Promise<SessionSnapshot | undefined> => {
    return readJsonIfPresent<SessionSnapshot>(
      join(this.baseDirectory, 'sessions', `${sessionId}.json`)
    )
  }

  readonly loadRun = async (runId: RunId): Promise<RunSnapshot | undefined> => {
    return readJsonIfPresent<RunSnapshot>(join(this.baseDirectory, 'runs', `${runId}.json`))
  }

  readonly listRuns = async (sessionId: SessionId): Promise<readonly RunSnapshot[]> => {
    const runsDirectory = join(this.baseDirectory, 'runs')

    try {
      const entries = await readdir(runsDirectory)
      const snapshots = await Promise.all(
        entries
          .filter((entry) => entry.endsWith('.json'))
          .map((entry) => readJsonIfPresent<RunSnapshot>(join(runsDirectory, entry)))
      )

      return snapshots
        .filter((snapshot): snapshot is RunSnapshot => snapshot !== undefined)
        .filter((snapshot) => snapshot.sessionId === sessionId)
        .sort((left, right) => left.createdAt - right.createdAt)
    } catch (error) {
      if (isMissingFileError(error)) {
        return []
      }

      throw error
    }
  }
}

async function writeJsonAtomically(
  filePath: string,
  value: SessionSnapshot | RunSnapshot
): Promise<void> {
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, JSON.stringify(value, null, 2), 'utf8')
  await rename(temporaryPath, filePath)
}

async function readJsonIfPresent<T>(filePath: string): Promise<T | undefined> {
  try {
    const content = await readFile(filePath, 'utf8')
    return JSON.parse(content) as T
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined
    }

    throw error
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}
