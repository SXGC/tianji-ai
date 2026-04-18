/**
 * deepagents 节点执行器工厂。
 *
 * 业务职责：
 * - 把编排图中的 AgentNode 编译为一个可供 LangGraph 调用的节点 action。
 * - 每次节点被调度都创建一个独立的 SessionRuntime（线程级隔离），执行单轮对话后销毁。
 * - 通过 emitGraphEvent 广播 GraphNodeStarted / GraphNodeCompleted 给上层 runner。
 *
 * 对外触点：
 * - 被 packages/agent 的 orchestration 入口当作默认 AgentExecutorFactory 使用。
 * - 底层依赖 @tianji/runtime 的 SessionRuntime、InMemorySnapshotStore、ToolCatalog 接口。
 */
import type { BaseLanguageModel } from '@langchain/core/language_models/base'
import type { ObserverLogger } from '@tianji/observer'
import {
  InMemorySnapshotStore,
  type RunTurnOptions,
  type RuntimeToolDefinition,
  type SessionRuntime,
  type SessionRuntimeDeepagentsConfig,
  type SessionRuntimeOptions,
  type SnapshotStore,
  type ToolCatalog,
  type ToolRegistry,
  createSessionRuntime,
} from '@tianji/runtime'
import { TianjiError } from '@tianji/shared'
import type {
  AppMessage,
  DomainEvent,
  GraphRunCapabilityUpperBound,
  McpServerSummary,
  ResolvedNodeCapabilities,
  RunId,
  SessionId,
  TokenUsage,
} from '@tianji/shared'

import { type CallMcpTargetPolicy, createCallMcpTool } from '../../mcp/call-mcp-tool.js'
import {
  createGraphRunCapabilityUpperBound,
  resolveNodeCapabilities as defaultResolveNodeCapabilities,
} from '../capability-resolver.js'
import type { AgentNode } from '../graph-schema.js'
import {
  buildOutputInstructionSuffix,
  buildPromptFromState,
  buildStateUpdateFromText,
} from '../io-mapping.js'
import type { AgentExecutorFactory, NodeAction, NodeExecutorContext } from './executor-types.js'

/**
 * 工厂配置：控制 deepagents-executor 如何解析模型、注入工具、日志和测试钩子。
 */
export interface CreateDeepagentsExecutorFactoryOptions {
  /**
   * 把图中节点的 model 字符串解析为实际的模型实例或字符串引用。
   * 测试中可返回 FakeListChatModel；生产中可直接返回 model 字符串以便 runtime 自行解析 provider。
   */
  readonly resolveModel: (modelRef: string) => string | BaseLanguageModel
  /** 所有节点共享的工具目录，可选。 */
  readonly toolCatalog?: ToolCatalog
  /** 共享 ToolRegistry，可按节点 selected tools 切片。 */
  readonly toolRegistry?: ToolRegistry
  /** graph-run 级别的能力上限。未提供时默认空 allowlist。 */
  readonly graphRunCapabilityUpperBound?: GraphRunCapabilityUpperBound
  /** 节点能力解析入口，默认使用 capability-resolver。 */
  readonly resolveNodeCapabilities?: (
    node: AgentNode,
    upperBound: GraphRunCapabilityUpperBound
  ) => ResolvedNodeCapabilities
  /** 节点 skill id 到实际技能路径的映射。 */
  readonly resolveSkillPath?: (skillId: string) => string
  /** call_mcp 需要的 MCP server 摘要列表。 */
  readonly listMcpServers?: () => readonly McpServerSummary[]
  /** call_mcp 的 discover 注入实现。 */
  readonly discoverMcp?: Parameters<typeof createCallMcpTool>[0]['discoverMcp']
  /** call_mcp 的 invoke 注入实现。 */
  readonly invokeMcp?: Parameters<typeof createCallMcpTool>[0]['invokeMcp']
  /** call_mcp 只读 invoke 白名单。 */
  readonly readonlyInvokeTargets?: readonly string[]
  /** call_mcp target policy。 */
  readonly targetPolicies?: Readonly<Record<string, CallMcpTargetPolicy>>
  /** 观测日志句柄，可选。 */
  readonly observer?: ObserverLogger
  /**
   * 测试钩子：在每次节点执行前观察 SessionRuntime 实际收到的 RunTurnOptions。
   * 仅供测试使用，生产代码不应依赖此钩子。
   */
  readonly onRuntimeOptions?: (options: RunTurnOptions) => void
  /** 测试钩子：观察 createSessionRuntime 实际接收到的 SessionRuntimeOptions。 */
  readonly onSessionRuntimeOptions?: (options: SessionRuntimeOptions) => void
}

/**
 * 创建一个工厂函数：将 AgentNode 编译为 LangGraph 可调用的节点 action。
 *
 * 生命周期：
 * 1. 读取 node.input 对应的 state 字段，构造用户消息文本。
 * 2. 为当前节点创建独立的 SessionRuntime（InMemorySnapshotStore，线程隔离）。
 * 3. 调用 runTurn 执行单轮推理，收集最后一条 assistant 文本。
 * 4. 根据 node.output 把文本映射回 state 的局部更新。
 * 5. 广播 graph.node.started / graph.node.completed 事件。
 *
 * @param options - 工厂配置
 * @returns 符合 AgentExecutorFactory 约定的工厂函数
 */
export function createDeepagentsExecutorFactory(
  options: CreateDeepagentsExecutorFactoryOptions
): AgentExecutorFactory {
  return (node: AgentNode, ctx: NodeExecutorContext): NodeAction => {
    const action: NodeAction = async (state) => {
      // 先做 input 快速失败，避免创建无用的 runtime/session。
      // 这里刻意放在 started 事件之前：输入缺失是调用方的契约错误，
      // 让它裸抛，避免产生一个孤儿的 started/failed 事件对。
      const promptText = buildPromptFromState(state, node.input)
      const systemPromptSuffix = buildOutputInstructionSuffix(node.output)
      const fullSystemPrompt = node.agent.systemPrompt + systemPromptSuffix

      const startTimestamp = Date.now()
      ctx.emitGraphEvent({
        type: 'GraphNodeStarted',
        runId: ctx.runId,
        graphId: ctx.graphId,
        nodeId: node.id,
        nodeKind: 'agent',
        timestamp: startTimestamp,
      })

      let runtime: SessionRuntime | undefined
      let currentSessionId: SessionId | undefined
      let nodeRunId: RunId | undefined
      let shouldCloseTemporarySession = false

      try {
        runtime = buildRuntimeForNode(node, options, ctx, ctx.snapshotStore)
        currentSessionId = await openOrCreateSession(runtime, ctx.sessionId)
        shouldCloseTemporarySession = ctx.sessionId === undefined

        const userMessage: AppMessage = {
          id: `msg_user_${startTimestamp}`,
          role: 'user',
          content: [{ type: 'text', text: promptText }],
          createdAt: startTimestamp,
        }

        const runOptions: RunTurnOptions = {
          sessionId: currentSessionId,
          message: userMessage,
          systemPrompt: fullSystemPrompt,
          abortSignal: ctx.abortSignal,
        }
        options.onRuntimeOptions?.(runOptions)

        nodeRunId = await runtime.runTurn(runOptions)
        const finalAssistantText = await collectFinalAssistantText(
          runtime,
          nodeRunId,
          ctx.emitRuntimeEvent
        )
        const usage = await readRunUsage(runtime, nodeRunId)
        const stateUpdate = buildStateUpdateFromText(finalAssistantText, node.output)

        ctx.emitGraphEvent({
          type: 'GraphNodeCompleted',
          runId: ctx.runId,
          graphId: ctx.graphId,
          nodeId: node.id,
          nodeKind: 'agent',
          output: stateUpdate,
          ...(usage === undefined ? {} : { usage }),
          timestamp: Date.now(),
        })
        return stateUpdate
      } catch (error_) {
        // 把底层错误归一化为 TianjiError 后广播 failed 事件，再把原始错误再抛出，
        // 让 LangGraph 正常结束 run 并让上层 runner 走 finished reject 路径。
        const tianjiError = toTianjiError(error_)
        ctx.emitGraphEvent({
          type: 'GraphNodeFailed',
          runId: ctx.runId,
          graphId: ctx.graphId,
          nodeId: node.id,
          nodeKind: 'agent',
          error: tianjiError,
          timestamp: Date.now(),
        })
        throw error_
      } finally {
        if (
          shouldCloseTemporarySession &&
          runtime !== undefined &&
          currentSessionId !== undefined
        ) {
          await runtime.closeSession(currentSessionId)
        }
      }
    }

    return action
  }
}

/**
 * 把任意抛出的值归一化为 TianjiError，保留 cause 链。
 */
function toTianjiError(caught: unknown): TianjiError {
  if (caught instanceof TianjiError) {
    return caught
  }
  if (caught instanceof Error) {
    return new TianjiError('internal', caught.name || 'unknown', caught.message, { cause: caught })
  }
  return new TianjiError('internal', 'unknown', String(caught))
}

/**
 * 打开已有 session 或新建一个。
 *
 * 若提供了 sessionId，尝试 openSession（加载历史）；SESSION_NOT_FOUND 时用同一 ID 新建。
 * 未提供 sessionId 时创建临时匿名 session（与旧行为兼容）。
 */
async function openOrCreateSession(
  runtime: SessionRuntime,
  sessionId: SessionId | undefined
): Promise<SessionId> {
  if (sessionId !== undefined) {
    try {
      await runtime.openSession(sessionId)
    } catch (err) {
      if ((err as { code?: string }).code !== 'SESSION_NOT_FOUND') throw err
      await runtime.createSession({ sessionId })
    }
    return sessionId
  }
  const session = await runtime.createSession({})
  return session.sessionId
}

/**
 * 只从当前节点 run snapshot 中读取 usage，避免混入 session 累计 usage。
 */
async function readRunUsage(
  runtime: SessionRuntime,
  runId: RunId | undefined
): Promise<TokenUsage | undefined> {
  if (runId === undefined) {
    return undefined
  }

  const usage = (await runtime.getRunSnapshot(runId))?.metadata?.usage
  if (typeof usage !== 'object' || usage === null) {
    return undefined
  }

  const candidate = usage as {
    inputTokens?: unknown
    outputTokens?: unknown
    totalTokens?: unknown
  }
  if (
    typeof candidate.inputTokens !== 'number' ||
    typeof candidate.outputTokens !== 'number' ||
    typeof candidate.totalTokens !== 'number'
  ) {
    return undefined
  }

  return {
    inputTokens: candidate.inputTokens,
    outputTokens: candidate.outputTokens,
    totalTokens: candidate.totalTokens,
  }
}

/**
 * 根据节点配置构造一个全新的 SessionRuntime，实现节点间线程隔离。
 *
 * @param snapshotStore - 由上层注入的持久化存储；未提供时使用 InMemorySnapshotStore（临时）。
 */
function buildRuntimeForNode(
  node: AgentNode,
  options: CreateDeepagentsExecutorFactoryOptions,
  ctx: NodeExecutorContext,
  snapshotStore?: SnapshotStore
): SessionRuntime {
  const graphRunCapabilityUpperBound =
    ctx.graphRunCapabilityUpperBound ??
    options.graphRunCapabilityUpperBound ??
    createGraphRunCapabilityUpperBound()
  const resolveNodeCapabilities =
    ctx.resolveNodeCapabilities ?? options.resolveNodeCapabilities ?? defaultResolveNodeCapabilities
  const nodeCapabilities = resolveNodeCapabilities(node, graphRunCapabilityUpperBound)

  // runtime 侧要求 subagents 元素具备 `[key: string]: unknown` 索引签名；
  // agent-schema 定义的 SubAgentDef 字段都属于 unknown 子集，显式复制到字面量即可满足。
  const subagents = node.agent.subagents?.map(
    (sa): { [key: string]: unknown; readonly name: string } => ({
      name: sa.name,
      description: sa.description,
      systemPrompt: sa.systemPrompt,
      tools: sa.tools,
      model: sa.model,
    })
  )
  const skills = resolveSkillPaths(nodeCapabilities, options.resolveSkillPath)
  const toolCatalog = buildNodeToolCatalog(nodeCapabilities, options, graphRunCapabilityUpperBound)
  const deepagentsConfig: SessionRuntimeDeepagentsConfig = {
    model: options.resolveModel(node.agent.model),
    subagents,
    skills: skills.length > 0 ? skills : undefined,
  }
  const sessionOptions: SessionRuntimeOptions = {
    deepagents: deepagentsConfig,
    snapshotStore: snapshotStore ?? new InMemorySnapshotStore(),
    toolCatalog,
    logger: options.observer,
  }
  options.onSessionRuntimeOptions?.(sessionOptions)
  return createSessionRuntime(sessionOptions)
}

function resolveSkillPaths(
  nodeCapabilities: ResolvedNodeCapabilities,
  resolveSkillPath?: (skillId: string) => string
): readonly string[] {
  if (nodeCapabilities.skills.length === 0) {
    return []
  }

  if (resolveSkillPath === undefined) {
    throw new Error('resolveSkillPath is required when node declares skills')
  }

  const resolvedSkills: string[] = []
  for (const skillId of nodeCapabilities.skills) {
    const skillPath = resolveSkillPath(skillId)
    if (typeof skillPath !== 'string' || skillPath.length === 0) {
      throw new Error(`Failed to resolve skill path for skill id: ${skillId}`)
    }
    resolvedSkills.push(skillPath)
  }
  return resolvedSkills
}

function buildNodeToolCatalog(
  nodeCapabilities: ResolvedNodeCapabilities,
  options: CreateDeepagentsExecutorFactoryOptions,
  graphRunCapabilityUpperBound: GraphRunCapabilityUpperBound
): readonly RuntimeToolDefinition[] {
  if (nodeCapabilities.tools.length === 0) {
    return []
  }

  const sharedToolCatalog = options.toolRegistry ?? options.toolCatalog
  const runtimeTools: RuntimeToolDefinition[] = []

  for (const toolName of nodeCapabilities.tools) {
    if (toolName === 'call_mcp') {
      runtimeTools.push(
        buildNodeScopedCallMcpTool(options, nodeCapabilities, graphRunCapabilityUpperBound)
      )
      continue
    }

    const toolDefinition = sharedToolCatalog?.getTool(toolName)
    if (toolDefinition === undefined) {
      throw new Error(`Tool "${toolName}" is not registered`)
    }
    runtimeTools.push(toolDefinition)
  }

  return runtimeTools
}

function buildNodeScopedCallMcpTool(
  options: CreateDeepagentsExecutorFactoryOptions,
  nodeCapabilities: ResolvedNodeCapabilities,
  graphRunCapabilityUpperBound: GraphRunCapabilityUpperBound
): RuntimeToolDefinition {
  if (
    options.listMcpServers === undefined ||
    options.discoverMcp === undefined ||
    options.invokeMcp === undefined
  ) {
    throw new Error('call_mcp requires listMcpServers, discoverMcp, and invokeMcp callbacks')
  }

  return createCallMcpTool({
    getCapabilities: () => ({
      nodeCapabilities,
      graphRunUpperBound: graphRunCapabilityUpperBound,
      readonlyInvokeTargets: options.readonlyInvokeTargets,
      targetPolicies: options.targetPolicies,
    }),
    listServers: options.listMcpServers,
    discoverMcp: options.discoverMcp,
    invokeMcp: options.invokeMcp,
  })
}

/**
 * 消费 runtime 的事件流，取出最后一条 assistant message 的文本内容。
 *
 * 节点只关心最终输出，不消费 delta/tool 事件，但仍完整迭代以确保 run 结束。
 * 如果提供了 onEvent 回调，所有事件都会被透传出去。
 *
 * @param runtime - 当前节点的 SessionRuntime 实例
 * @param runId - 本轮 run 的唯一标识
 * @param onEvent - 可选的事件透传回调，每个 DomainEvent 都会调用一次
 */
async function collectFinalAssistantText(
  runtime: SessionRuntime,
  runId: RunId,
  onEvent?: (event: DomainEvent) => void
): Promise<string> {
  let finalText = ''
  const events: AsyncIterable<DomainEvent> = runtime.streamEvents(runId)
  for await (const event of events) {
    onEvent?.(event)
    if (event.type === 'MessageCompleted' && event.message.role === 'assistant') {
      finalText = extractTextFromMessage(event.message)
    }
  }
  return finalText
}

/**
 * 把 AppMessage 中所有 text part 拼接为纯文本。
 */
function extractTextFromMessage(message: AppMessage): string {
  const parts: string[] = []
  for (const part of message.content) {
    if (part.type === 'text') {
      parts.push(part.text)
    }
  }
  return parts.join('')
}
