import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { McpServerSummary } from '@tianji/shared'

import {
  assertSafeMcpTarget,
  generateMcpSkillMarkdown,
  toLogicalMcpSkillId,
} from './skill-generator.js'

const MCP_SKILL_ROOT_PREFIX = 'tianji-mcp-skills-'

export interface CreateSessionScopedMcpSkillRegistryOptions {
  readonly allowedTargets?: readonly string[]
}

export interface SessionScopedMcpSkillFile {
  readonly logicalId: string
  readonly target: string
  readonly path: string
}

export interface SessionScopedMcpSkillRegistry {
  readonly sessionRoot: string
  readonly logicalIdToPath: Readonly<Record<string, string>>
  readonly files: readonly SessionScopedMcpSkillFile[]
  readonly cleanup: () => Promise<void>
}

/**
 * 把允许的 MCP server 摘要落到一个 session-scoped 临时目录里。
 *
 * 目录只在当前 session 内存在，且只生成 allowlist 里的 server。
 */
export async function createSessionScopedMcpSkillRegistry(
  servers: readonly McpServerSummary[],
  options: CreateSessionScopedMcpSkillRegistryOptions = {}
): Promise<SessionScopedMcpSkillRegistry> {
  const allowedTargets = new Set(options.allowedTargets ?? servers.map((server) => server.target))
  const plannedServers: McpServerSummary[] = []
  const seenTargets = new Set<string>()

  for (const server of servers) {
    if (!allowedTargets.has(server.target)) {
      continue
    }

    assertSafeMcpTarget(server.target)
    if (seenTargets.has(server.target)) {
      throw new Error(`Duplicate MCP server target: ${server.target}`)
    }
    seenTargets.add(server.target)
    generateMcpSkillMarkdown(server)
    plannedServers.push(server)
  }

  const sessionRoot = await mkdtemp(join(tmpdir(), MCP_SKILL_ROOT_PREFIX))
  const logicalIdToPath: Record<string, string> = Object.create(null)
  const files: SessionScopedMcpSkillFile[] = []

  try {
    for (const server of plannedServers) {
      const logicalId = toLogicalMcpSkillId(server.target)
      const skillDir = join(sessionRoot, server.target)
      const skillPath = join(skillDir, 'SKILL.md')

      await mkdir(skillDir, { recursive: true })
      await writeFile(skillPath, generateMcpSkillMarkdown(server), 'utf8')

      logicalIdToPath[logicalId] = skillPath
      files.push({
        logicalId,
        target: server.target,
        path: skillPath,
      })
    }
  } catch (error) {
    await rm(sessionRoot, { recursive: true, force: true })
    throw error
  }

  return {
    sessionRoot,
    logicalIdToPath,
    files,
    cleanup: async () => {
      await rm(sessionRoot, { recursive: true, force: true })
    },
  }
}
