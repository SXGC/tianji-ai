import { readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { McpServerSummary } from '@tianji/shared'

import { createSessionScopedMcpSkillRegistry } from '../registry.js'
import {
  assertSafeMcpTarget,
  generateMcpSkillMarkdown,
  toLogicalMcpSkillId,
} from '../skill-generator.js'

function createServerSummaries(): readonly McpServerSummary[] {
  return [
    {
      target: 'github',
      name: 'GitHub MCP',
      description: 'GitHub repository, issue, PR and checks access',
      tools: [
        {
          name: 'list_pull_requests',
          qualifiedName: 'github.list_pull_requests',
          description: 'List pull requests for a repository',
          requiredParameters: ['owner', 'repo'],
          optionalParameterCount: 0,
        },
        {
          name: 'create_comment',
          qualifiedName: 'github.create_comment',
          description: 'Create a pull request comment',
          requiredParameters: ['pullRequestId', 'body'],
          optionalParameterCount: 0,
        },
      ],
    },
    {
      target: 'linear',
      name: 'Linear MCP',
      description: 'Linear issue tracking access',
      tools: [
        {
          name: 'create_issue',
          qualifiedName: 'linear.create_issue',
          description: 'Create a Linear issue',
          requiredParameters: ['teamId', 'title'],
          optionalParameterCount: 0,
        },
      ],
    },
  ]
}

describe('skill-generator', () => {
  it('输入 MCP server 摘要后生成 session 级目录，并返回完整逻辑 id 到路径映射', async () => {
    const registry = await createSessionScopedMcpSkillRegistry(createServerSummaries(), {
      allowedTargets: ['github', 'linear'],
    })

    try {
      expect(registry.sessionRoot.startsWith(tmpdir())).toBe(true)
      expect(registry.logicalIdToPath).toEqual({
        'mcp.github': join(registry.sessionRoot, 'github', 'SKILL.md'),
        'mcp.linear': join(registry.sessionRoot, 'linear', 'SKILL.md'),
      })
      expect(registry.files).toEqual([
        {
          logicalId: 'mcp.github',
          target: 'github',
          path: join(registry.sessionRoot, 'github', 'SKILL.md'),
        },
        {
          logicalId: 'mcp.linear',
          target: 'linear',
          path: join(registry.sessionRoot, 'linear', 'SKILL.md'),
        },
      ])

      const skillRootEntries = (await readdir(registry.sessionRoot)).sort()
      expect(skillRootEntries).toEqual(['github', 'linear'])

      const githubMarkdown = await readFile(registry.logicalIdToPath['mcp.github'], 'utf8')
      const linearMarkdown = await readFile(registry.logicalIdToPath['mcp.linear'], 'utf8')

      expect(githubMarkdown).toContain('name: "mcp.github"')
      expect(githubMarkdown).toContain(
        'description: "GitHub repository, issue, PR and checks access"'
      )
      expect(githubMarkdown).toContain('# GitHub MCP')
      expect(githubMarkdown).toContain('target=github')
      expect(githubMarkdown).toContain('target=精确的 server.tool 目标')
      expect(githubMarkdown).not.toContain('github.tool')
      expect(githubMarkdown).not.toContain('authenticated')
      expect(githubMarkdown).not.toContain('medium')
      expect(githubMarkdown).toContain('- github.list_pull_requests')
      expect(linearMarkdown).toContain('name: "mcp.linear"')
    } finally {
      await registry.cleanup()
    }
  })

  it('只纳入 allowlist 里的 server', async () => {
    const registry = await createSessionScopedMcpSkillRegistry(createServerSummaries(), {
      allowedTargets: ['github'],
    })

    try {
      expect(registry.logicalIdToPath).toEqual({
        'mcp.github': join(registry.sessionRoot, 'github', 'SKILL.md'),
      })
      expect(Object.keys(registry.logicalIdToPath)).toEqual(['mcp.github'])

      const skillRootEntries = await readdir(registry.sessionRoot)
      expect(skillRootEntries).toEqual(['github'])

      const skillMarkdown = await readFile(registry.logicalIdToPath['mcp.github'], 'utf8')
      expect(skillMarkdown).toContain('name: "mcp.github"')
    } finally {
      await registry.cleanup()
    }
  })

  it('空工具列表会写出固定的占位能力摘要', () => {
    const markdown = generateMcpSkillMarkdown({
      target: 'empty',
      name: 'Empty MCP',
      description: 'No tools yet',
      tools: [],
    })

    expect(markdown).toContain('- 无可用工具')
    expect(markdown).toContain(`name: ${JSON.stringify(toLogicalMcpSkillId('empty'))}`)
  })

  it('危险元数据会直接报错，不生成不可解析的 skill', () => {
    expect(() => assertSafeMcpTarget('github\nbad')).toThrow(/Invalid MCP server target: github/)

    expect(() =>
      generateMcpSkillMarkdown({
        target: 'github',
        name: 'GitHub\nMCP',
        description: 'safe',
        tools: [],
      })
    ).toThrow(/server\.name must be a single line/)

    expect(() =>
      generateMcpSkillMarkdown({
        target: 'github',
        name: 'GitHub MCP',
        description: 'bad --- delimiter',
        tools: [],
      })
    ).toThrow(/server\.description must not contain front matter delimiter/)
  })

  it('重复 target 直接报错', async () => {
    await expect(
      createSessionScopedMcpSkillRegistry([
        ...createServerSummaries(),
        {
          target: 'github',
          name: 'Duplicate GitHub MCP',
          description: 'duplicate',
          tools: [],
        },
      ])
    ).rejects.toThrow(/Duplicate MCP server target: github/)
  })
})
