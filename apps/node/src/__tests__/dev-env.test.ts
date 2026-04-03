import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { loadDevelopmentEnv } from '../dev-env.js'

const createdDirs: string[] = []
const TEST_ENV_KEYS = ['TEST_ENV_LOCAL_ONLY', 'TEST_ENV_FALLBACK_ONLY', 'TEST_ENV_KEEP_EXISTING']

describe('development env loader', () => {
  afterEach(async () => {
    for (const key of TEST_ENV_KEYS) {
      Reflect.deleteProperty(process.env, key)
    }

    await Promise.all(createdDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  it('prefers .env.local over .env', async () => {
    const repoRoot = await prepareRepoRoot()
    await writeFile(join(repoRoot, '.env'), 'TEST_ENV_LOCAL_ONLY=from-dot-env\n', 'utf8')
    await writeFile(
      join(repoRoot, '.env.local'),
      'TEST_ENV_LOCAL_ONLY=from-dot-env-local\n',
      'utf8'
    )

    loadDevelopmentEnv(repoRoot)

    expect(process.env.TEST_ENV_LOCAL_ONLY).toBe('from-dot-env-local')
  })

  it('falls back to .env when .env.local is missing', async () => {
    const repoRoot = await prepareRepoRoot()
    await writeFile(join(repoRoot, '.env'), 'TEST_ENV_FALLBACK_ONLY=from-dot-env\n', 'utf8')

    loadDevelopmentEnv(repoRoot)

    expect(process.env.TEST_ENV_FALLBACK_ONLY).toBe('from-dot-env')
  })

  it('does not override existing shell env vars', async () => {
    const repoRoot = await prepareRepoRoot()
    await writeFile(join(repoRoot, '.env.local'), 'TEST_ENV_KEEP_EXISTING=from-file\n', 'utf8')
    process.env.TEST_ENV_KEEP_EXISTING = 'from-shell'

    loadDevelopmentEnv(repoRoot)

    expect(process.env.TEST_ENV_KEEP_EXISTING).toBe('from-shell')
  })
})

async function prepareRepoRoot(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'tianji-cli-env-'))
  createdDirs.push(repoRoot)
  return repoRoot
}
