/**
 * ACP stdio entry point for tianji native agent.
 *
 * 此文件是原生 agent 作为独立进程运行时的入口。
 * 通过 stdin/stdout 进行 ACP JSON-RPC 2.0 通信。
 *
 * @module acp-entry
 */

import { Readable, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'

import { resolveAgentModel } from '@tianji/runtime'
import type { TianjiAgentConfig } from '@tianji/shared'

import { TianjiAcpAgent } from './acp/agent-bridge.js'
import { loadAgentContext } from './context.js'
import {
  createDeepagentsExecutorFactory,
  loadDefaultOrchestrationGraph,
} from './orchestration/index.js'
import { createAgentSession } from './session.js'

/**
 * 启动 ACP agent 进程。
 * 从 stdin 读取 JSON-RPC 请求，通过 stdout 返回响应和通知。
 */
export async function runAcpAgent(): Promise<void> {
  console.error('[acp-agent] Starting ACP agent process')

  const context = await loadAgentContext()

  console.error('[acp-agent] Agent context loaded:', context.agent.agentName)

  const configDir = context.paths.configDir
  const agentConfigs: Readonly<Record<string, TianjiAgentConfig>> =
    context.config.agents?.items ?? {}
  const defaultGraph = await loadDefaultOrchestrationGraph({ configDir, agentConfigs })

  const executorFactory = createDeepagentsExecutorFactory({
    // 走 runtime 的 resolveAgentModel：当 provider 配置了自定义 baseUrl 时，
    // 预先实例化 ChatOpenAI，避免 deepagents 内部的 initChatModel 无法识别 provider。
    resolveModel: (modelRef) => resolveAgentModel(modelRef, context.config.providers),
  })

  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
  const stream = ndJsonStream(output, input)

  const connection = new AgentSideConnection((conn) => {
    const sessionFactory = () => createAgentSession(context)
    return new TianjiAcpAgent(conn, sessionFactory, defaultGraph, executorFactory)
  }, stream)

  console.error('[acp-agent] ACP connection established, waiting for requests')

  await connection.closed

  console.error('[acp-agent] ACP connection closed, agent exiting')
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  try {
    await runAcpAgent()
  } catch (error: unknown) {
    console.error('ACP agent fatal error:', error)
    process.exit(1)
  }
}
