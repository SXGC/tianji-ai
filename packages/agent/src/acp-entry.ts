/**
 * ACP stdio entry point for tianji native agent.
 *
 * 此文件是原生 agent 作为独立进程运行时的入口。
 * 通过 stdin/stdout 进行 ACP JSON-RPC 2.0 通信。
 *
 * @module acp-entry
 */

import { Readable, Writable } from 'node:stream'
import { AgentSideConnection, ndJsonStream } from '@agentclientprotocol/sdk'

import { TianjiAcpAgent } from './acp/agent-bridge.js'
import { loadAgentContext } from './context.js'
import { createAgentSession } from './session.js'

/**
 * 启动 ACP agent 进程。
 * 从 stdin 读取 JSON-RPC 请求，通过 stdout 返回响应和通知。
 */
export async function runAcpAgent(): Promise<void> {
  const context = await loadAgentContext()

  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
  const stream = ndJsonStream(output, input)

  const connection = new AgentSideConnection((conn) => {
    const sessionFactory = () => createAgentSession(context)
    return new TianjiAcpAgent(conn, sessionFactory)
  }, stream)

  await connection.closed
}

const isMain = process.argv[1] !== undefined

if (isMain) {
  void runAcpAgent().catch((error: unknown) => {
    console.error('ACP agent fatal error:', error)
    process.exit(1)
  })
}
