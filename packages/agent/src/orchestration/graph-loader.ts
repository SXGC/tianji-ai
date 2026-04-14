import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { type TianjiAgentConfig, getAgentSoulPath, resolveAgentType } from '@tianji/shared'

import type { GraphNode, OrchestrationGraph } from './graph-schema.js'
import { buildSystemPrompt } from './system-prompt-builder.js'

/**
 * 随 `@tianji/agent` 发布的包内默认编排图位置。
 *
 * 运行时从 `packages/agent/src/orchestration/graph-loader.ts` 出发，向上两级再进入 `config/`。
 * 发布后结构相同（`dist/orchestration/graph-loader.js` → `config/...`），只要 `package.json`
 * 的 `files` 字段包含 `config` 就能被 npm 打包带走。
 */
const BUNDLED_DEFAULT_ORCHESTRATION_PATH = fileURLToPath(
  new URL('../../config/default-orchestration.json', import.meta.url)
)

export interface GraphLoaderOptions {
  /** configDir，用于定位 default-orchestration.json 和各 agent 的 SOUL.md */
  readonly configDir: string
  /** tianji.config.json 中 agents.items 的完整配置 */
  readonly agentConfigs: Readonly<Record<string, TianjiAgentConfig>>
}

/**
 * JSON 文件中 agent 节点的 agent 字段是 string（agent name），
 * 与最终 OrchestrationGraph 的 AgentNode.agent 对象不同。
 */
interface RawAgentNode {
  readonly id: string
  readonly type: 'agent'
  readonly agent: string
  readonly input?: readonly string[]
  readonly output?: readonly string[]
}

interface RawOrchestrationGraph {
  readonly id: string
  readonly name: string
  readonly version: number
  readonly source: string
  readonly locked: boolean
  readonly state: Record<string, unknown>
  readonly nodes: readonly (RawAgentNode | Record<string, unknown>)[]
  readonly edges: readonly { readonly from: string; readonly to: string }[]
}

/**
 * 加载 <configDir>/default-orchestration.json 并展开 agent name 为完整 AgentNode.agent 对象。
 *
 * - agent 节点只允许引用 native agent；external agent 必须用 acp-agent 节点。
 * - 当前只从 TianjiAgentConfig 展开 model + systemPrompt；tools/subagents/skills 留 undefined。
 *
 * @param options - 加载配置选项
 * @returns 展开后的 OrchestrationGraph
 * @throws 文件不存在、agent name 找不到、agent 是 external 类型、native agent 无 model
 */
export async function loadDefaultOrchestrationGraph(
  options: GraphLoaderOptions
): Promise<OrchestrationGraph> {
  const userJsonPath = join(options.configDir, 'default-orchestration.json')
  const rawJson = await readUserOrBundledOrchestration(userJsonPath)

  const raw = JSON.parse(rawJson) as RawOrchestrationGraph
  const expandedNodes: GraphNode[] = []

  for (const node of raw.nodes) {
    if (isRawAgentNode(node)) {
      expandedNodes.push(await expandAgentNode(node, options))
    } else {
      expandedNodes.push(node as unknown as GraphNode)
    }
  }

  return {
    id: raw.id,
    name: raw.name,
    version: raw.version,
    source: raw.source as OrchestrationGraph['source'],
    locked: raw.locked,
    state: raw.state as OrchestrationGraph['state'],
    nodes: expandedNodes,
    edges: raw.edges,
  }
}

/** 判断节点是否为待展开的原始 agent 节点（agent 字段是 string） */
function isRawAgentNode(node: Record<string, unknown> | RawAgentNode): node is RawAgentNode {
  return node.type === 'agent' && typeof node.agent === 'string'
}

/**
 * 将原始 agent 节点展开为完整的 AgentNode。
 *
 * @param raw - 原始 agent 节点（agent 字段为 string）
 * @param options - 加载配置选项
 * @returns 展开后的 AgentNode
 * @throws agent 不存在、agent 是 external 类型、agent 无 model
 */
async function expandAgentNode(raw: RawAgentNode, options: GraphLoaderOptions): Promise<GraphNode> {
  const agentName = raw.agent
  const config = options.agentConfigs[agentName]

  if (config === undefined) {
    throw new Error(
      `Agent node "${raw.id}" references unknown agent "${agentName}". ` +
        `Available agents: ${Object.keys(options.agentConfigs).join(', ') || '(none)'}`
    )
  }

  if (resolveAgentType(config) === 'external') {
    throw new Error(
      `Agent node "${raw.id}" references external agent "${agentName}". Use acp-agent node type instead.`
    )
  }

  if (config.model === undefined) {
    throw new Error(
      `Agent node "${raw.id}" references agent "${agentName}" which has no model configured.`
    )
  }

  const soulPath = getAgentSoulPath(options.configDir, agentName)
  const workspace = config.workspace ?? process.cwd()
  const systemPrompt = await buildSystemPrompt({ soulPath, workspace })

  return {
    id: raw.id,
    type: 'agent',
    agent: {
      model: config.model,
      systemPrompt,
    },
    input: raw.input,
    output: raw.output,
  }
}

/**
 * 读 user configDir 的 default-orchestration.json；当且仅当 ENOENT 时 fallback 读包内 bundled。
 *
 * 其它 IO 错误（权限、目录损坏等）必须暴露，不可静默降级。
 *
 * @param userPath - 用户目录下的 JSON 绝对路径
 * @returns 原始 JSON 文本
 */
async function readUserOrBundledOrchestration(userPath: string): Promise<string> {
  try {
    return await readFile(userPath, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      throw err
    }
  }
  return await readFile(BUNDLED_DEFAULT_ORCHESTRATION_PATH, 'utf8')
}
