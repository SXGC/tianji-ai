import type { ObserverLogger } from '@tianji/observer'
import type { RunId, RuntimeEvent } from '@tianji/shared'
import { type CompileOptions, compileOrchestrationGraph } from './graph-compiler.js'
import type { OrchestrationGraph } from './graph-schema.js'

export interface RunOrchestrationGraphOptions {
  readonly graph: OrchestrationGraph
  readonly compileOptions: Omit<
    CompileOptions,
    'runId' | 'observer' | 'emitGraphEvent' | 'emitRuntimeEvent' | 'abortSignal'
  >
  readonly runId: RunId
  readonly initialState?: Record<string, unknown>
  readonly observer?: ObserverLogger
  readonly abortSignal?: AbortSignal
}

export interface OrchestrationRunResult {
  readonly events: AsyncIterable<RuntimeEvent>
  readonly finished: Promise<Record<string, unknown>>
}

/**
 * 顶层入口：编译图并启动执行，返回事件流和最终状态 Promise。
 *
 * 事件流包含 RuntimeEvent（graph 图级事件 + run/message/tool 运行时事件）。
 * graph.started/node.started/node.completed/completed 由 graph-runner 直接 emit；
 * run/message/tool 等事件由各 executor 通过 emitRuntimeEvent 回调转发到同一事件流中。
 *
 * 错误语义：若 invoke 抛错，`finished` 会 reject，同时事件流会通过
 * `try/finally` 正确结束（done 置位并释放所有等待中的消费者），
 * 而不是让 AsyncIterator 永远挂起。
 */
export function runOrchestrationGraph(
  options: RunOrchestrationGraphOptions
): OrchestrationRunResult {
  const eventQueue: RuntimeEvent[] = []
  const eventResolvers: ((value: IteratorResult<RuntimeEvent>) => void)[] = []
  let done = false

  const emit = (event: RuntimeEvent): void => {
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

  const events: AsyncIterable<RuntimeEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {
      return {
        next(): Promise<IteratorResult<RuntimeEvent>> {
          if (eventQueue.length > 0) {
            const value = eventQueue.shift() as RuntimeEvent
            return Promise.resolve({ value, done: false })
          }
          if (done) {
            return Promise.resolve({ value: undefined as never, done: true })
          }
          return new Promise<IteratorResult<RuntimeEvent>>((resolve) => {
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
    emitRuntimeEvent: emit,
    abortSignal: options.abortSignal,
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
