import type { ObserverLogger } from '@tianji/observer'
import type { RuntimeTracingContext } from '@tianji/runtime'
import { type DomainEvent, type RunId, TianjiError } from '@tianji/shared'
import { type CompileOptions, compileOrchestrationGraph } from './graph-compiler.js'
import { renderOrchestrationGraphMermaid } from './graph-mermaid.js'
import type { OrchestrationGraph } from './graph-schema.js'

export interface RunOrchestrationGraphOptions {
  readonly graph: OrchestrationGraph
  readonly compileOptions: Omit<
    CompileOptions,
    'runId' | 'observer' | 'emitGraphEvent' | 'emitRuntimeEvent' | 'abortSignal'
  > & {
    readonly graphTracingContext?: RuntimeTracingContext
  }
  readonly runId: RunId
  readonly initialState?: Record<string, unknown>
  readonly observer?: ObserverLogger
  readonly abortSignal?: AbortSignal
  readonly onMermaid?: (diagram: string) => void
}

export interface OrchestrationRunResult {
  readonly events: AsyncIterable<DomainEvent>
  readonly finished: Promise<Record<string, unknown>>
}

/**
 * 顶层入口：编译图并启动执行，返回事件流和最终状态 Promise。
 *
 * 事件流包含 DomainEvent（graph 图级事件 + run/message/tool 运行时事件）。
 * GraphRunStarted/GraphNodeStarted/GraphNodeCompleted/GraphRunCompleted 由 graph-runner 直接 emit；
 * run/message/tool 等事件由各 executor 通过 emitRuntimeEvent 回调转发到同一事件流中。
 *
 * 错误语义：若 invoke 抛错，`finished` 会 reject，同时事件流会通过
 * `try/finally` 正确结束（done 置位并释放所有等待中的消费者），
 * 而不是让 AsyncIterator 永远挂起。
 */
export function runOrchestrationGraph(
  options: RunOrchestrationGraphOptions
): OrchestrationRunResult {
  const eventQueue: DomainEvent[] = []
  const eventResolvers: ((value: IteratorResult<DomainEvent>) => void)[] = []
  let done = false

  const emit = (event: DomainEvent): void => {
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

  const events: AsyncIterable<DomainEvent> = {
    [Symbol.asyncIterator](): AsyncIterator<DomainEvent> {
      return {
        next(): Promise<IteratorResult<DomainEvent>> {
          if (eventQueue.length > 0) {
            const value = eventQueue.shift() as DomainEvent
            return Promise.resolve({ value, done: false })
          }
          if (done) {
            return Promise.resolve({ value: undefined as never, done: true })
          }
          return new Promise<IteratorResult<DomainEvent>>((resolve) => {
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
    graphTracingContext: options.compileOptions.graphTracingContext,
  })

  const mermaidDiagram = renderOrchestrationGraphMermaid(options.graph)

  if (options.onMermaid !== undefined) {
    options.onMermaid(mermaidDiagram)
  }

  emit({
    type: 'GraphRunStarted',
    runId: options.runId,
    graphId: options.graph.id,
    graphVersion: options.graph.version,
    mermaidDiagram,
    timestamp: Date.now(),
  })

  const finished = (async (): Promise<Record<string, unknown>> => {
    try {
      // LangGraph 的 invoke 类型签名比我们需要的更严格，这里用 unknown 逃逸
      const finalState = await (
        compiled as unknown as {
          invoke: (
            input: Record<string, unknown>,
            config?: { signal?: AbortSignal }
          ) => Promise<Record<string, unknown>>
        }
      ).invoke(options.initialState ?? {}, {
        signal: options.abortSignal,
      })

      emit({
        type: 'GraphRunCompleted',
        runId: options.runId,
        graphId: options.graph.id,
        graphVersion: options.graph.version,
        finalState,
        timestamp: Date.now(),
      })

      return finalState
    } catch (error) {
      const isAbort =
        error instanceof Error &&
        error.name === 'AbortError' &&
        options.abortSignal?.aborted === true
      if (isAbort) {
        emit({
          type: 'GraphRunCancelled',
          runId: options.runId,
          graphId: options.graph.id,
          graphVersion: options.graph.version,
          reason: 'abort',
          timestamp: Date.now(),
        })
      } else {
        emit({
          type: 'GraphRunFailed',
          runId: options.runId,
          graphId: options.graph.id,
          graphVersion: options.graph.version,
          error: toTianjiError(error),
          timestamp: Date.now(),
        })
      }
      throw error
    } finally {
      // 无论 invoke 成功还是失败，都要关闭事件流，防止消费者永远挂起
      closeStream()
    }
  })()

  return { events, finished }
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
