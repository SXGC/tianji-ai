/**
 * CLI 子进程集成测试（smoke test）。
 *
 * 通过 child_process.spawn 执行真实的 tianji CLI 二进制，验证进程级行为。
 * smoke 用例会隔离 HOME，避免用户层配置污染项目根 tianji.config.json 的结果。
 * 运行方式：
 *   pnpm --filter @tianji/cli build
 *   SMOKE_E2E=1 pnpm --filter @tianji/cli test:smoke
 */
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

const CLI_BIN = resolve(import.meta.dirname, '../../bin/tianji.mjs')
const WORKSPACE_ROOT = resolve(import.meta.dirname, '../../../..')
const PROJECT_CONFIG_PATH = resolve(WORKSPACE_ROOT, 'tianji.config.json')

const projectConfig = JSON.parse(await readFile(PROJECT_CONFIG_PATH, 'utf8')) as {
  providers?: {
    openai?: {
      apiKey?: string
    }
  }
}

const hasApiKey =
  typeof projectConfig.providers?.openai?.apiKey === 'string' &&
  projectConfig.providers.openai.apiKey.length > 0
const isSmokeEnabled = process.env.SMOKE_E2E === '1'

const describeIfSmoke = isSmokeEnabled ? describe : describe.skip

const createdHomeDirs: string[] = []

interface ExecResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

afterEach(async () => {
  await Promise.all(
    createdHomeDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

function runTianji(args: readonly string[], env?: NodeJS.ProcessEnv): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    const child = spawn('node', [CLI_BIN, ...args], {
      env: env ?? process.env,
      cwd: WORKSPACE_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('close', (code: number | null) => {
      resolvePromise({
        code: code ?? 1,
        stdout,
        stderr,
      })
    })

    child.on('error', () => {
      resolvePromise({
        code: 1,
        stdout,
        stderr,
      })
    })
  })
}

async function createSmokeEnv(): Promise<NodeJS.ProcessEnv> {
  const homeDir = await mkdtemp(join(tmpdir(), 'tianji-cli-smoke-home-'))
  createdHomeDirs.push(homeDir)

  return {
    ...process.env,
    HOME: homeDir,
    OPENAI_API_KEY: projectConfig.providers?.openai?.apiKey ?? '',
    SMOKE_E2E: '1',
  }
}

describeIfSmoke('CLI smoke e2e (subprocess)', () => {
  it('exits with code 2 when no command is provided', async () => {
    const result = await runTianji([])
    expect(result.code).toBe(2)
  })

  it('exits with code 2 for unknown command', async () => {
    const result = await runTianji(['bad'])
    expect(result.code).toBe(2)
  })

  const describeIfApiKey = hasApiKey ? describe : describe.skip

  describeIfApiKey('with valid API key', () => {
    it('uses project config and exits with code 0 for cli run', async () => {
      const smokeEnv = await createSmokeEnv()
      const result = await runTianji(['run', '请只回复: smoke ok'], smokeEnv)

      expect(result.code).toBe(0)
      expect(result.stdout).toContain('smoke ok')
    })

    it('bootstraps an empty user config file without overriding project config', async () => {
      const smokeEnv = await createSmokeEnv()
      const result = await runTianji(['run', '请只回复: smoke ok'], smokeEnv)
      const userConfigPath = join(smokeEnv.HOME ?? '', '.config', 'tianji-ai', 'tianji.json')
      const userConfigContent = await readFile(userConfigPath, 'utf8')

      expect(result.code).toBe(0)
      expect(userConfigContent).toBe('{}\n')
      expect(result.stderr).toBe('')
    })
  })
})
