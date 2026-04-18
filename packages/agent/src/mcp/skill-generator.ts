import type { McpServerSummary } from '@tianji/shared'

const SKILL_HEADER = '---'
const UNKNOWN_VALUE = 'unknown'
const CONTROL_CHARACTER_PATTERN = /[\r\n]/
const SAFE_TARGET_PATTERN = /^[A-Za-z0-9._-]+$/

export function toLogicalMcpSkillId(target: string): string {
  return `mcp.${target}`
}

/**
 * 生成单个 MCP server 的 session-scoped skill 文本。
 *
 * 模板是固定结构，只把 server 摘要填进去，不做任何启发式推断。
 */
export function generateMcpSkillMarkdown(server: McpServerSummary): string {
  assertSafeMcpTarget(server.target)
  const title = assertSafeInlineText('server.name', server.name.trim())
  const description = server.description?.trim()
  const safeDescription =
    description === undefined
      ? UNKNOWN_VALUE
      : assertSafeInlineText('server.description', description)
  const capabilityLines = buildCapabilitySummary(server)
  const usageServerTarget = server.target
  const logicalId = toLogicalMcpSkillId(server.target)

  return [
    SKILL_HEADER,
    `name: ${JSON.stringify(logicalId)}`,
    `description: ${JSON.stringify(safeDescription)}`,
    SKILL_HEADER,
    '',
    `# ${title}`,
    '',
    '## 适用场景',
    `- 查看 ${title} 暴露的 MCP 工具`,
    `- 先读取 ${title} 的 server 级能力摘要，再决定下一步`,
    '',
    '## 不适用场景',
    '- 不要把它当成本地文件系统',
    '- 不要把它当成通用网页抓取器',
    '',
    '## 认证状态',
    `- ${UNKNOWN_VALUE}`,
    '',
    '## 风险等级',
    `- ${UNKNOWN_VALUE}`,
    '',
    '## 能力摘要',
    ...capabilityLines,
    '',
    '## 使用规则',
    `- 如果你只需要知道有哪些 ${title} 工具，调用 \`call_mcp\`，\`action=discover\`，\`target=${usageServerTarget}\``,
    '- 如果你已经通过 discover 拿到精确的 `server.tool` 目标，再调用 `call_mcp`，`action=invoke`，`target=精确的 server.tool 目标`，并传入结构化 arguments',
  ].join('\n')
}

function buildCapabilitySummary(server: McpServerSummary): readonly string[] {
  if (server.tools.length === 0) {
    return ['- 无可用工具']
  }

  return server.tools.map((tool) => {
    const qualifiedName = assertSafeInlineText('tool.qualifiedName', tool.qualifiedName)
    return `- ${qualifiedName}`
  })
}

function assertSafeInlineText(label: string, value: string): string {
  if (value.length === 0) {
    throw new Error(`${label} must not be empty`)
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new Error(`${label} must be a single line`)
  }
  if (value.includes(SKILL_HEADER)) {
    throw new Error(`${label} must not contain front matter delimiter`)
  }
  return value
}

export function assertSafeMcpTarget(target: string): void {
  if (!SAFE_TARGET_PATTERN.test(target)) {
    throw new Error(`Invalid MCP server target: ${target}`)
  }
}
