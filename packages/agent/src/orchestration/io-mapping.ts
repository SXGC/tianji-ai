/**
 * 从 state 中读取节点 input 字段，构造发送给 agent 的 prompt。
 *  - 单字段：直接转字符串
 *  - 多字段：拼接为 ## 标题分段的 markdown
 *  - 字段不存在：抛错（Let it crash）
 */
export function buildPromptFromState(
  state: Record<string, unknown>,
  inputFields: readonly string[] | undefined
): string {
  if (!inputFields || inputFields.length === 0) {
    return ''
  }

  for (const field of inputFields) {
    if (!(field in state)) {
      throw new Error(`输入字段 "${field}" 不存在于 state 中`)
    }
  }

  if (inputFields.length === 1) {
    return stringifyValue(state[inputFields[0]])
  }

  const sections: string[] = []
  for (const field of inputFields) {
    sections.push(`## ${field}\n${stringifyValue(state[field])}`)
  }
  return sections.join('\n\n')
}

/**
 * 把 agent 输出文本映射回 state。
 *  - 单字段：整段文本写入
 *  - 多字段：要求 agent 输出 JSON，解析后按 key 分配
 */
export function buildStateUpdateFromText(
  text: string,
  outputFields: readonly string[] | undefined
): Record<string, unknown> {
  if (!outputFields || outputFields.length === 0) {
    return {}
  }

  if (outputFields.length === 1) {
    return { [outputFields[0]]: text }
  }

  const json = parseJsonAllowingFence(text)
  if (json === null || typeof json !== 'object') {
    throw new Error('多字段输出要求 agent 返回 JSON，但解析失败')
  }

  const jsonObject = json as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const field of outputFields) {
    if (!(field in jsonObject)) {
      throw new Error(`agent 输出 JSON 缺少字段 "${field}"`)
    }
    result[field] = jsonObject[field]
  }
  return result
}

/**
 * 多字段 output 时追加到 systemPrompt 的指令。
 */
export function buildOutputInstructionSuffix(outputFields: readonly string[] | undefined): string {
  if (!outputFields || outputFields.length <= 1) {
    return ''
  }
  const fieldList = outputFields.map((f) => `"${f}": string`).join(', ')
  return `\n\nReturn your answer strictly as JSON with shape: { ${fieldList} }`
}

function stringifyValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return ''
  return JSON.stringify(value)
}

function parseJsonAllowingFence(text: string): unknown {
  const trimmed = text.trim()
  let candidate = trimmed

  if (trimmed.startsWith('```') && trimmed.endsWith('```')) {
    const firstNewlineIndex = trimmed.indexOf('\n')
    const lastFenceIndex = trimmed.lastIndexOf('```')

    if (firstNewlineIndex !== -1 && lastFenceIndex > firstNewlineIndex) {
      const header = trimmed.slice(3, firstNewlineIndex).trim()

      if (header === '' || header === 'json') {
        candidate = trimmed.slice(firstNewlineIndex + 1, lastFenceIndex).trim()
      }
    }
  }

  try {
    return JSON.parse(candidate)
  } catch (error_) {
    throw new Error(`无法解析 JSON 输出: ${(error_ as Error).message}`)
  }
}
