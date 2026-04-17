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
import type { ObserverLogger } from '@tianji/observer'
import {
  createJsonlFileSink,
  createObserverLogger,
  createStderrSink,
  errorToLogData,
} from '@tianji/observer'

import { TianjiAcpAgent } from './acp/agent-bridge.js'
import { type LoadedAgentContext, loadAgentContext } from './context.js'
import { buildDefaultGraph } from './default-graph-builder.js'
import { createUnifiedRuntimeEntry } from './unified-entry.js'

/**
 * 为 ACP 子进程创建结构化 logger。
 * stdout 被 JSON-RPC 占用，stderr 作为日志通道；同时写 JSONL 文件便于后续检索。
 */
function createAcpLogger(context: LoadedAgentContext): ObserverLogger {
  return createObserverLogger({
    sinks: [
      createJsonlFileSink({ filePath: context.paths.cliLogFilePath }),
      createStderrSink({ minLevel: 'info', pretty: true }),
    ],
  })
}

/**
 * 启动 ACP agent 进程。
 * 从 stdin 读取 JSON-RPC 请求，通过 stdout 返回响应和通知。
 */
export async function runAcpAgent(): Promise<void> {
  const context = await loadAgentContext()
  const logger = createAcpLogger(context)

  await logger.info(['acp', 'entry'], 'acp agent starting', {
    agentName: context.agent.agentName,
  })

  const built = await buildDefaultGraph(
    { source: 'acp', input: '', agentId: context.agent.agentName },
    context
  )
  const entry = createUnifiedRuntimeEntry({
    loadDefaultGraph: async () => built.graph,
    createExecutorRegistry: async () => built.executorFactory,
    runtime: {
      runGraph: async ({ request, graph, executors }) => {
        const sessionFactory = await import('./session.js')
        const session = await sessionFactory.createAgentSession(context)
        return {
          sessionId: session.sessionId,
          runId: undefined,
          events: session.queryWithGraph(graph, {
            initialState: { input: request.input },
            compileOptions: { agentExecutorFactory: executors },
          }),
        }
      },
      resumeGraph: async () => {
        throw new Error('ACP unified entry resume is not implemented yet')
      },
      cancelRun: async () => undefined,
      streamRun: () => {
        throw new Error('ACP unified entry stream is not implemented yet')
      },
    },
  })

  const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>
  const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>
  const stream = ndJsonStream(output, input)

  const connection = new AgentSideConnection((conn) => {
    return new TianjiAcpAgent(conn, entry, { logger })
  }, stream)

  await logger.info(['acp', 'entry'], 'acp connection established')

  await connection.closed

  await logger.info(['acp', 'entry'], 'acp connection closed')
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href

if (isMain) {
  try {
    await runAcpAgent()
  } catch (error: unknown) {
    const data = errorToLogData(error)
    process.stderr.write(
      `[acp-agent] Fatal: ${typeof data.message === 'string' ? data.message : String(error)}\n`
    )
    if (typeof data.stack === 'string') {
      process.stderr.write(`${data.stack}\n`)
    }
    process.exit(1)
  }
}
