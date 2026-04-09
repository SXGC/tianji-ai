import type { ObserverLogger } from '@tianji/observer'
import type { GraphEvent, RunId } from '@tianji/shared'
import { type CompileOptions, compileOrchestrationGraph } from './graph-compiler.js'
import type { OrchestrationGraph } from './graph-schema.js'

export interface RunOrchestrationGraphOptions {
  readonly graph: OrchestrationGraph
  readonly compileOptions: Omit<CompileOptions, 'runId' | 'observer' | 'emitGraphEvent'>
  readonly runId: RunId
  readonly initialState?: Record<string, unknown>
  readonly observer?: ObserverLogger
  readonly abortSignal?: AbortSignal
}

export interface OrchestrationRunResult {
  readonly events: AsyncIterable<GraphEvent>
  readonly finished: Promise<Record<string, unknown>>
}

/**
 * 顶层入口：编译图并启动执行，返回事件流和最终状态 Promise。
 *
 * 事件流包含 graph.* 事件（启动、节点状态变化、完成）。
 * 内部 deepagents 的 RuntimeEvent 当前由各 executor 自行处理，
 * 后续可在此处通过额外管道透传。
 *
 * 错误语义：若 invoke 抛错，`finished` 会 reject，同时事件流会通过
 * `try/finally` 正确结束（done 置位并释放所有等待中的消费者），
 * 而不是让 AsyncIterator 永远挂起。
 */
export function runOrchestrationGraph(
  options: RunOrchestrationGraphOptions
): OrchestrationRunResult {
  const eventQueue: GraphEvent[] = []
  const eventResolvers: ((value: IteratorResult<GraphEvent>) => void)[] = []
  let done = false

  const emit = (event: GraphEvent): void => {
    if (done) return
    if (eventResolvers.length > 0) {
      const resolve = eventResolvers.shift()
      // 长度判断后立即 shift，理论上不可能为 undefined
      if (resolve) {
        resolve({ value: event, done: false })
        return
      }
    }
    eventQueue.push(event)
  }

  const closeStream = (): void => {
    done = true
    while (eventResolvers.length > 0) {
      const resolve = eventResolvers.shift()
      if (resolve) {
        resolve({ value: undefined as never, done: true })
      }
    }
  }

  const events: AsyncIterable<GraphEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<GraphEvent> {
      return {
        next(): Promise<IteratorResult<GraphEvent>> {
          if (eventQueue.length > 0) {
            const value = eventQueue.shift() as GraphEvent
            return Promise.resolve({ value, done: false })
          }
          if (done) {
            return Promise.resolve({ value: undefined as never, done: true })
          }
          return new Promise<IteratorResult<GraphEvent>>((resolve) => {
            eventResolvers.push(resolve)
          })
        },
      }
    },
  }

  const compiled = compileOrchestrationGraph(options.graph, {
    ...options.compileOptions,
    runId: options.runId,
    observer: options.observer,
    emitGraphEvent: emit,
  })

  emit({
    type: 'graph.started',
    runId: options.runId,
    graphId: options.graph.id,
    graphVersion: options.graph.version,
    timestamp: Date.now(),
  })

  const finished = (async (): Promise<Record<string, unknown>> => {
    try {
      // LangGraph 的 invoke 类型签名比我们需要的更严格，这里用 unknown 逃逸
      const finalState = (await (
        compiled as unknown as {
          invoke: (
            input: Record<string, unknown>,
            config?: { signal?: AbortSignal }
          ) => Promise<Record<string, unknown>>
        }
      ).invoke(options.initialState ?? {}, {
        signal: options.abortSignal,
      })) as Record<string, unknown>

      emit({
        type: 'graph.completed',
        runId: options.runId,
        graphId: options.graph.id,
        finalState,
        timestamp: Date.now(),
      })

      return finalState
    } finally {
      // 无论 invoke 成功还是失败，都要关闭事件流，防止消费者永远挂起
      closeStream()
    }
  })()

  return { events, finished }
}
