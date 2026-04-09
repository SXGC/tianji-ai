/**
 * deepagents 节点执行器工厂。
 *
 * 业务职责：
 * - 把编排图中的 AgentNode 编译为一个可供 LangGraph 调用的节点 action。
 * - 每次节点被调度都创建一个独立的 SessionRuntime（线程级隔离），执行单轮对话后销毁。
 * - 通过 emitGraphEvent 广播 graph.node.started / graph.node.completed 给上层 runner。
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
  type SessionRuntime,
  type SessionRuntimeDeepagentsConfig,
  type SessionRuntimeOptions,
  type ToolCatalog,
  createSessionRuntime,
} from '@tianji/runtime'
import { TianjiError } from '@tianji/shared'
import type { AppMessage, RunId, RuntimeEvent } from '@tianji/shared'

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
  /** 观测日志句柄，可选。 */
  readonly observer?: ObserverLogger
  /**
   * 测试钩子：在每次节点执行前观察 SessionRuntime 实际收到的 RunTurnOptions。
   * 仅供测试使用，生产代码不应依赖此钩子。
   */
  readonly onRuntimeOptions?: (options: RunTurnOptions) => void
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
        type: 'graph.node.started',
        runId: ctx.runId,
        graphId: ctx.graphId,
        nodeId: node.id,
        nodeKind: 'agent',
        timestamp: startTimestamp,
      })

      try {
        const runtime = buildRuntimeForNode(node, options)
        const session = await runtime.createSession({})

        const userMessage: AppMessage = {
          id: `msg_user_${startTimestamp}`,
          role: 'user',
          content: [{ type: 'text', text: promptText }],
          createdAt: startTimestamp,
        }

        const runOptions: RunTurnOptions = {
          sessionId: session.sessionId,
          message: userMessage,
          systemPrompt: fullSystemPrompt,
          abortSignal: ctx.abortSignal,
        }
        options.onRuntimeOptions?.(runOptions)

        const runId = await runtime.runTurn(runOptions)
        const finalAssistantText = await collectFinalAssistantText(runtime, runId)

        const stateUpdate = buildStateUpdateFromText(finalAssistantText, node.output)

        ctx.emitGraphEvent({
          type: 'graph.node.completed',
          runId: ctx.runId,
          graphId: ctx.graphId,
          nodeId: node.id,
          output: stateUpdate,
          timestamp: Date.now(),
        })

        await runtime.closeSession(session.sessionId)
        return stateUpdate
      } catch (caught) {
        // 把底层错误归一化为 TianjiError 后广播 failed 事件，再把原始错误再抛出，
        // 让 LangGraph 正常结束 run 并让上层 runner 走 finished reject 路径。
        const error = toTianjiError(caught)
        ctx.emitGraphEvent({
          type: 'graph.node.failed',
          runId: ctx.runId,
          graphId: ctx.graphId,
          nodeId: node.id,
          error,
          timestamp: Date.now(),
        })
        throw caught
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
 * 根据节点配置构造一个全新的 SessionRuntime，实现节点间线程隔离。
 */
function buildRuntimeForNode(
  node: AgentNode,
  options: CreateDeepagentsExecutorFactoryOptions
): SessionRuntime {
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
  const deepagentsConfig: SessionRuntimeDeepagentsConfig = {
    model: options.resolveModel(node.agent.model),
    subagents,
    skills: node.agent.skills,
  }
  const sessionOptions: SessionRuntimeOptions = {
    deepagents: deepagentsConfig,
    snapshotStore: new InMemorySnapshotStore(),
    toolCatalog: options.toolCatalog,
    logger: options.observer,
  }
  return createSessionRuntime(sessionOptions)
}

/**
 * 消费 runtime 的事件流，取出最后一条 assistant message 的文本内容。
 *
 * 节点只关心最终输出，不消费 delta/tool 事件，但仍完整迭代以确保 run 结束。
 */
async function collectFinalAssistantText(runtime: SessionRuntime, runId: RunId): Promise<string> {
  let finalText = ''
  const events: AsyncIterable<RuntimeEvent> = runtime.streamEvents(runId)
  for await (const event of events) {
    if (event.type === 'message.completed' && event.message.role === 'assistant') {
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
