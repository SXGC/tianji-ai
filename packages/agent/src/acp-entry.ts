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

import { TianjiAcpAgent } from './acp/agent-bridge.js'
import { loadAgentContext } from './context.js'
import { createAgentSession } from './session.js'

/**
 * 启动 ACP agent 进程。
 * 从 stdin 读取 JSON-RPC 请求，通过 stdout 返回响应和通知。
 */
export async function runAcpAgent(): Promise<void> {
  console.error('[acp-agent] Starting ACP agent process')

  const context = await loadAgentContext()

  console.error('[acp-agent] Agent context loaded:', context.agent.agentName)

  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
  const stream = ndJsonStream(output, input)

  const connection = new AgentSideConnection((conn) => {
    const sessionFactory = () => createAgentSession(context)
    return new TianjiAcpAgent(conn, sessionFactory)
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
