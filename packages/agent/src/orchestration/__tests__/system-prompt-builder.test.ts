import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { buildSystemPrompt } from '../system-prompt-builder.js'

describe('buildSystemPrompt', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tianji-prompt-builder-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('AGENTS.md 不存在时只返回 soul 块', async () => {
    const soulPath = join(tempDir, 'SOUL.md')
    await writeFile(soulPath, '# Agent\nYou are helpful.\n', 'utf8')

    const result = await buildSystemPrompt({
      soulPath,
      workspace: join(tempDir, 'nonexistent-workspace'),
    })

    expect(result).toContain('<agent_soul>')
    expect(result).toContain('# Agent')
    expect(result).toContain('You are helpful.')
    expect(result).toContain('</agent_soul>')
    expect(result).not.toContain('<workspace_agents_md>')
  })

  it('AGENTS.md 存在时正确拼接两个块', async () => {
    const soulPath = join(tempDir, 'SOUL.md')
    await writeFile(soulPath, 'Soul content here.\n', 'utf8')

    const workspace = join(tempDir, 'workspace')
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'AGENTS.md'), 'Workspace rules here.\n', 'utf8')

    const result = await buildSystemPrompt({ soulPath, workspace })

    expect(result).toContain('<agent_soul>')
    expect(result).toContain('Soul content here.')
    expect(result).toContain('</agent_soul>')
    expect(result).toContain('<workspace_agents_md>')
    expect(result).toContain('Workspace rules here.')
    expect(result).toContain('</workspace_agents_md>')

    // soul 在前，agents.md 在后
    const soulIndex = result.indexOf('<agent_soul>')
    const agentsIndex = result.indexOf('<workspace_agents_md>')
    expect(soulIndex).toBeLessThan(agentsIndex)
  })

  it('SOUL.md 不存在时报错（由 loadAgentSoul 保证）', async () => {
    const missingSoulPath = join(tempDir, 'missing-SOUL.md')

    await expect(
      buildSystemPrompt({ soulPath: missingSoulPath, workspace: tempDir })
    ).rejects.toThrow(/soul/i)
  })
})
