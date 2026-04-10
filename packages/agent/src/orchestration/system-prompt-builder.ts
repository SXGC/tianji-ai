import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { loadAgentSoul } from '@tianji/shared'

export interface BuildSystemPromptOptions {
  /** SOUL.md 文件路径（由 getAgentSoulPath(configDir, agentName) 生成） */
  readonly soulPath: string
  /** agent 的工作目录。取值链：TianjiAgentConfig.workspace → 若未配置则 process.cwd() */
  readonly workspace: string
}

/**
 * 构建完整的 systemPrompt。
 *
 * 1. 读 SOUL.md（必须存在，由 loadAgentSoul 保证）
 * 2. 尝试读 <workspace>/AGENTS.md，不存在则跳过
 * 3. 返回结构化 XML 块拼接结果
 *
 * @param options - 构建配置
 * @returns 拼接后的 systemPrompt 字符串
 */
export async function buildSystemPrompt(options: BuildSystemPromptOptions): Promise<string> {
  const soulContent = await loadAgentSoul(options.soulPath)

  const agentsContent = await tryReadFile(join(options.workspace, 'AGENTS.md'))

  let prompt = `<agent_soul>\n${soulContent}\n</agent_soul>`

  if (agentsContent !== null) {
    prompt += `\n\n<workspace_agents_md>\n${agentsContent}\n</workspace_agents_md>`
  }

  return prompt
}

/**
 * 尝试读取文件内容，文件不存在或内容为空时返回 null。
 *
 * @param filePath - 目标文件路径
 * @returns 文件内容字符串，或 null
 */
async function tryReadFile(filePath: string): Promise<string | null> {
  try {
    const content = await readFile(filePath, 'utf8')
    return content.trim().length > 0 ? content : null
  } catch {
    return null
  }
}
