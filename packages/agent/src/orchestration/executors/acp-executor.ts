/**
 * ACP 节点执行器工厂（注入式）。
 *
 * 业务职责：
 * - 把编排图中的 AcpAgentNode 编译为一个可供 LangGraph 调用的节点 action。
 * - 本文件不直接拉起 ACP 子进程；真正的 runner 由上层（通常是 apps/node 的 AgentRunner）
 *   通过 runnerProvider 注入，本 package 只提供适配层。
 * - 通过 emitGraphEvent 广播 GraphNodeStarted / GraphNodeCompleted 给上层 runner。
 *
 * 对外触点：
 * - apps/node 配置 SessionRuntime 时，把此工厂连同具体的 runnerProvider 一起传入。
 */
import { TianjiError } from '@tianji/shared'
import type { DomainEvent } from '@tianji/shared'

import type { AcpAgentNode } from '../graph-schema.js'
import {
  buildOutputInstructionSuffix,
  buildPromptFromState,
  buildStateUpdateFromText,
} from '../io-mapping.js'
import type { AcpExecutorFactory, NodeAction, NodeExecutorContext } from './executor-types.js'

/**
 * ACP runner 的最小接口。
 * apps/node 的 AgentRunner 已经满足这个形状，可以直接传入。
 */
export interface AcpRunnerLike {
  connect(): Promise<void>
  query(prompt: string): AsyncIterable<DomainEvent>
  disconnect(): Promise<void>
}

/**
 * 把一个 AcpAgentNode 映射为具体的 runner 实例。
 * 由上层实现，packages/agent 不关心 runner 如何构造。
 */
export type AcpRunnerProvider = (node: AcpAgentNode) => AcpRunnerLike

/**
 * 工厂配置：唯一依赖就是上层注入的 runnerProvider。
 */
export interface CreateAcpExecutorFactoryOptions {
  readonly runnerProvider: AcpRunnerProvider
}

/**
 * 创建一个工厂函数：将 AcpAgentNode 编译为 LangGraph 可调用的节点 action。
 *
 * 生命周期：
 * 1. 广播 graph.node.started。
 * 2. 读取 node.input 对应的 state 字段，构造 prompt 文本，多字段 output 时追加 JSON 指令。
 * 3. 通过 runnerProvider 取得 runner，connect → query → 消费事件流 → disconnect（finally 释放）。
 * 4. 取最后一条 assistant 文本，按 node.output 映射回 state 局部更新。
 * 5. 广播 graph.node.completed 并返回 state 更新。
 *
 * @param options - 工厂配置，必须包含 runnerProvider。
 * @returns 符合 AcpExecutorFactory 约定的工厂函数。
 */
export function createAcpExecutorFactory(
  options: CreateAcpExecutorFactoryOptions
): AcpExecutorFactory {
  return (node: AcpAgentNode, ctx: NodeExecutorContext): NodeAction => {
    const action: NodeAction = async (state) => {
      // 与 deepagents-executor 保持一致：先做 input 快速失败，避免产生
      // 孤儿的 started/failed 事件对。
      const promptText = buildPromptFromState(state, node.input)
      const suffix = buildOutputInstructionSuffix(node.output)
      const fullPrompt = suffix ? `${promptText}${suffix}` : promptText

      const startTimestamp = Date.now()
      ctx.emitGraphEvent({
        type: 'GraphNodeStarted',
        runId: ctx.runId,
        graphId: ctx.graphId,
        nodeId: node.id,
        nodeKind: 'acp-agent',
        timestamp: startTimestamp,
      })

      try {
        const runner = options.runnerProvider(node)
        await runner.connect()

        let accumulatedText = ''
        try {
          for await (const event of runner.query(fullPrompt)) {
            ctx.emitRuntimeEvent?.(event)
            if (event.type === 'MessageCompleted' && event.message.role === 'assistant') {
              accumulatedText = extractText(event.message)
            }
          }
        } finally {
          // 资源释放，必须在任何异常后依然执行。
          await runner.disconnect()
        }

        const stateUpdate = buildStateUpdateFromText(accumulatedText, node.output)

        ctx.emitGraphEvent({
          type: 'GraphNodeCompleted',
          runId: ctx.runId,
          graphId: ctx.graphId,
          nodeId: node.id,
          nodeKind: 'acp-agent',
          output: stateUpdate,
          timestamp: Date.now(),
        })

        return stateUpdate
      } catch (error_) {
        // 连接 / query / 解析失败统一走 failed 事件，再把原始错误再抛出。
        const tianjiError = toTianjiError(error_)
        ctx.emitGraphEvent({
          type: 'GraphNodeFailed',
          runId: ctx.runId,
          graphId: ctx.graphId,
          nodeId: node.id,
          nodeKind: 'acp-agent',
          error: tianjiError,
          timestamp: Date.now(),
        })
        throw error_
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
 * 把消息内容中所有 text part 拼接为纯文本。
 *
 * 这里使用最小结构化类型，避免把执行器与 @tianji/shared 的 AppMessage 强耦合：
 * 只需要 content 是一个可迭代的 part 列表，且 text part 带有 string 类型的 text 字段即可。
 */
function extractText(message: {
  readonly content: readonly { readonly type: string; readonly text?: string }[]
}): string {
  return message.content
    .filter(
      (part): part is { readonly type: 'text'; readonly text: string } =>
        part.type === 'text' && typeof part.text === 'string'
    )
    .map((part) => part.text)
    .join('')
}
