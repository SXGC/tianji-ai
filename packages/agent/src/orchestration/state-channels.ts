import { Annotation } from '@langchain/langgraph'
import type { StateChannelDef, StateChannelReducer } from './graph-schema'

/**
 * 把 OrchestrationGraph 的 state 定义编译为 LangGraph Annotation.Root。
 * 三种 reducer:
 *  - replace (默认): LastValue, 后写覆盖前值
 *  - append: 列表 reducer, 把新值追加到现有列表
 *  - merge: 对象 reducer, 浅合并两个对象
 */
export function compileStateChannels(
  channels: Record<string, StateChannelDef>
): ReturnType<typeof Annotation.Root> {
  const spec: Record<string, ReturnType<typeof Annotation>> = {}

  for (const [key, def] of Object.entries(channels)) {
    spec[key] = createChannelAnnotation(def)
  }

  return Annotation.Root(spec)
}

function createChannelAnnotation(def: StateChannelDef) {
  const reducer: StateChannelReducer = def.reducer ?? 'replace'

  if (reducer === 'replace') {
    return Annotation<unknown>({
      reducer: (_existing, update) => update,
      default: () => def.default,
    })
  }

  if (reducer === 'append') {
    return Annotation<unknown[]>({
      reducer: (existing, update) => {
        const base = Array.isArray(existing) ? existing : []
        const next = Array.isArray(update) ? update : [update]
        return [...base, ...next]
      },
      default: () => (Array.isArray(def.default) ? def.default : []),
    })
  }

  if (reducer === 'merge') {
    return Annotation<Record<string, unknown>>({
      reducer: (existing, update) => ({
        ...(existing ?? {}),
        ...(update ?? {}),
      }),
      default: () =>
        def.default && typeof def.default === 'object'
          ? (def.default as Record<string, unknown>)
          : {},
    })
  }

  throw new Error(`未知的 reducer 类型: ${String(reducer)}`)
}
