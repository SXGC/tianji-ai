import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { TianjiConfigSchema } from '../src/config.js'

// 1. Generate JSON Schema from Zod (no name param to produce inline schema without $ref wrapper)
const base = zodToJsonSchema(TianjiConfigSchema, {
  $refStrategy: 'none',
  target: 'jsonSchema7',
})

// 2. Chinese description map, keys are JSON pointer paths
const descriptions: Record<string, string> = {
  '': '天机 AI 配置文件。支持三层配置合并：默认 < 用户 < 工作区',
  '/properties/locale': '界面语言。可选值：en, zh-CN',
  '/properties/providers':
    'LLM 提供商连接配置。key 为提供商名称（如 openai），value 包含 apiKey 等连接参数。支持 ${env:VAR_NAME} 占位符引用环境变量',
  '/properties/agents': 'Agent 定义集合',
  '/properties/agents/properties/defaultAgent':
    '默认 agent 名称，必须在 items 中有对应定义。默认值：default',
  '/properties/agents/properties/items':
    'Agent 配置项。key 为 agent 名称（小写字母、数字、连字符、下划线），value 为该 agent 的配置',
  '/properties/agents/properties/items/additionalProperties/properties/model':
    '模型引用，格式为 provider/modelName（如 openai/gpt-4.1）。原生 agent 必填',
  '/properties/agents/properties/items/additionalProperties/properties/command':
    '执行命令。原生 agent 默认为 tianji-agent，外部 agent 填写对应命令（如 claude、codex）',
  '/properties/agents/properties/items/additionalProperties/properties/args': '命令行参数数组',
  '/properties/agents/properties/items/additionalProperties/properties/env':
    '环境变量键值对，会注入到 agent 运行环境中',
  '/properties/agents/properties/items/additionalProperties/properties/workspace':
    'Agent 的工作目录。deepagents 在此目录下执行文件操作和 shell 命令。默认为 process.cwd()',
  '/properties/runtime': '运行时配置',
  '/properties/runtime/properties/retry': '重试策略配置',
  '/properties/runtime/properties/retry/properties/maxAttempts': '最大重试次数。默认值：2',
  '/properties/runtime/properties/retry/properties/baseDelayMs':
    '基础重试延迟（毫秒）。默认值：300',
  '/properties/runtime/properties/retry/properties/maxDelayMs':
    '最大重试延迟（毫秒）。默认值：3000',
  '/properties/runtime/properties/tool': '工具执行策略配置',
  '/properties/runtime/properties/tool/properties/timeoutMs':
    '单次工具执行超时时间（毫秒）。默认值：120000',
  '/properties/runtime/properties/tool/properties/maxConcurrency': '工具最大并发数。默认值：4',
  '/properties/runtime/properties/tool/properties/allowDestructive':
    '是否允许执行破坏性操作。默认值：false',
  '/properties/runtime/properties/tool/properties/pathPolicy': '路径安全策略',
  '/properties/runtime/properties/tool/properties/pathPolicy/properties/forbidDirectories':
    '禁止访问的目录列表。默认值：[".git/", "node_modules/"]',
  '/properties/runtime/properties/tool/properties/pathPolicy/properties/filenameDenyPatterns':
    '禁止访问的文件名正则列表。默认拒绝 .env 文件和 SSH 密钥',
  '/properties/observer': '可观测性配置',
  '/properties/observer/properties/enabled': '是否启用观测日志。默认值：true',
  '/properties/observer/properties/redactSecrets': '日志中是否脱敏敏感信息。默认值：true',
  '/properties/controlPlane': '控制面连接配置。配置后节点会注册到控制面并接受任务下发',
  '/properties/controlPlane/properties/baseUrl': '控制面服务地址',
  '/properties/controlPlane/properties/enrollmentToken': '节点注册令牌',
  '/properties/controlPlane/properties/nodeId': '节点唯一标识',
  '/properties/controlPlane/properties/hostname': '节点主机名。可选，默认自动检测',
  '/properties/controlPlane/properties/platform': '节点操作系统平台。可选，默认自动检测',
  '/properties/controlPlane/properties/version': '节点版本号。可选',
}

/**
 * 收集 JSON Schema 节点的子 schema（properties + additionalProperties）。
 */
function collectChildSchemas(
  schema: Record<string, unknown>,
  pointer: string
): Array<{ schema: Record<string, unknown>; pointer: string }> {
  const children: Array<{ schema: Record<string, unknown>; pointer: string }> = []

  if (typeof schema.properties === 'object' && schema.properties !== null) {
    for (const [key, value] of Object.entries(schema.properties as Record<string, unknown>)) {
      if (typeof value === 'object' && value !== null) {
        children.push({
          schema: value as Record<string, unknown>,
          pointer: `${pointer}/properties/${key}`,
        })
      }
    }
  }

  if (typeof schema.additionalProperties === 'object' && schema.additionalProperties !== null) {
    children.push({
      schema: schema.additionalProperties as Record<string, unknown>,
      pointer: `${pointer}/additionalProperties`,
    })
  }

  return children
}

/**
 * Iteratively inject Chinese descriptions into the generated JSON Schema.
 * Uses an explicit stack instead of recursion.
 */
function applyDescriptions(root: Record<string, unknown>): void {
  const stack: Array<{ schema: Record<string, unknown>; pointer: string }> = [
    { schema: root, pointer: '' },
  ]

  while (stack.length > 0) {
    const { schema, pointer } = stack.pop()!

    if (descriptions[pointer] !== undefined) {
      schema.description = descriptions[pointer]
    }

    stack.push(...collectChildSchemas(schema, pointer))
  }
}

applyDescriptions(base as Record<string, unknown>)

// 4. Write output
const outputPath = resolve(import.meta.dirname, '../schemas/tianji-config.schema.json')
writeFileSync(outputPath, `${JSON.stringify(base, null, 2)}\n`, 'utf8')
