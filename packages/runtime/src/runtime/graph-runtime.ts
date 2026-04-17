import { createRunId } from '@tianji/shared'
import type { DomainEvent } from '@tianji/shared'

import type {
  CancelGraphRunRequest,
  GraphRunHandle,
  GraphRunRequest,
  GraphRuntime,
  GraphRuntimeDeps,
  ResumeGraphRunRequest,
  StreamGraphRunRequest,
} from './types.js'

async function emptyEvents(): Promise<AsyncIterable<DomainEvent>> {
  return (async function* () {})()
}

/**
 * 图运行入口把整张图的 session/run 生命周期收口到 runtime 层。
 */
export function createGraphRuntime(deps: GraphRuntimeDeps): GraphRuntime {
  return {
    async runGraph(request: GraphRunRequest): Promise<GraphRunHandle> {
      const session =
        request.sessionId === undefined
          ? await deps.sessionRuntime.createSession()
          : await deps.sessionRuntime
              .openSession(request.sessionId)
              .catch(async () =>
                deps.sessionRuntime.createSession({ sessionId: request.sessionId })
              )
      const runId = request.runId ?? createRunId(`run_graph_${Date.now()}`)

      if (deps.graphRunner?.start === undefined) {
        return {
          sessionId: session.sessionId,
          runId,
          events: await emptyEvents(),
        }
      }

      const startedRunId = await deps.graphRunner.start({
        sessionId: session.sessionId,
        runId,
        graph: request.graph,
        initialState: request.initialState,
        executors: request.executors,
      })

      return {
        sessionId: session.sessionId,
        runId: startedRunId,
        events: deps.sessionRuntime.streamEvents(startedRunId),
      }
    },
    async resumeGraph(request: ResumeGraphRunRequest): Promise<GraphRunHandle> {
      if (deps.graphRunner?.resume !== undefined) {
        return deps.graphRunner.resume(request)
      }

      return {
        sessionId: request.sessionId,
        runId: request.runId,
        events: deps.sessionRuntime.streamEvents(request.runId),
      }
    },
    async cancelRun(request: CancelGraphRunRequest): Promise<void> {
      deps.sessionRuntime.cancelRun(request.runId)
    },
    streamRun(request: StreamGraphRunRequest): AsyncIterable<DomainEvent> {
      return deps.sessionRuntime.streamEvents(request.runId)
    },
  }
}
