import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { ensureDefaultUserConfig } from '../config.js'

const createdHomeDirs: string[] = []

describe('CLI config bootstrap', () => {
  afterEach(async () => {
    await Promise.all(
      createdHomeDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    )
  })

  it('creates an empty user config file on first run', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'tianji-cli-home-'))
    createdHomeDirs.push(homeDir)
    const previousHome = process.env.HOME

    process.env.HOME = homeDir

    try {
      const paths = await ensureDefaultUserConfig()
      const configContent = await readFile(paths.configFilePath, 'utf8')

      expect(configContent).toBe('{}\n')
    } finally {
      process.env.HOME = previousHome ?? ''
    }
  })

  it('initializes SOUL.md for the resolved default agent', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'tianji-cli-home-'))
    const workspaceDir = await mkdtemp(join(tmpdir(), 'tianji-cli-workspace-'))
    createdHomeDirs.push(homeDir, workspaceDir)
    const previousHome = process.env.HOME

    process.env.HOME = homeDir

    try {
      await mkdir(workspaceDir, { recursive: true })
      await writeFile(
        join(workspaceDir, 'tianji.config.json'),
        `${JSON.stringify(
          {
            agents: {
              defaultAgent: 'reviewer',
              items: {
                reviewer: {
                  model: 'openai/gpt-latest-medium',
                },
              },
            },
          },
          null,
          2
        )}\n`,
        'utf8'
      )

      const currentWorkingDirectory = process.cwd()
      process.chdir(workspaceDir)

      try {
        const paths = await ensureDefaultUserConfig()
        const soulContent = await readFile(join(paths.agentsDir, 'reviewer', 'SOUL.md'), 'utf8')

        expect(soulContent).toContain('Default Tianji Agent')
      } finally {
        process.chdir(currentWorkingDirectory)
      }
    } finally {
      process.env.HOME = previousHome ?? ''
    }
  })
})
