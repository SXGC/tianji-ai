import type { RunnableConfig } from '@langchain/core/runnables'
import { LangChainTracer } from '@langchain/core/tracers/tracer_langchain'
import { TianjiError } from '@tianji/shared'
import { Client } from 'langsmith'

import type { SessionRuntimeTracingConfig } from './types.js'

export interface RuntimeTracingContext {
  readonly tags?: readonly string[]
  readonly metadata?: Record<string, unknown>
}

interface RuntimeLangsmithTracingState {
  readonly tracer: LangChainTracer
  readonly project: string
  readonly tags?: readonly string[]
  readonly metadata?: Record<string, unknown>
}

export interface RuntimeTracingState {
  readonly langsmith?: RuntimeLangsmithTracingState
}

export function createRuntimeTracingState(
  config: SessionRuntimeTracingConfig | undefined
): RuntimeTracingState {
  const langsmith = config?.langsmith
  if (langsmith?.enabled !== true) {
    return {}
  }

  if (langsmith.project === undefined || langsmith.project.length === 0) {
    throw new TianjiError(
      'state',
      'INVALID_LANGSMITH_CONFIG',
      'tracing.langsmith.project is required when LangSmith tracing is enabled'
    )
  }

  if (langsmith.apiKey === undefined || langsmith.apiKey.length === 0) {
    throw new TianjiError(
      'state',
      'INVALID_LANGSMITH_CONFIG',
      'tracing.langsmith.apiKey is required when LangSmith tracing is enabled'
    )
  }

  const client = new Client({
    apiKey: langsmith.apiKey,
    apiUrl: langsmith.apiUrl,
  })

  return {
    langsmith: {
      tracer: new LangChainTracer({
        client,
        projectName: langsmith.project,
      }),
      project: langsmith.project,
      tags: cloneTags(langsmith.tags),
      metadata: cloneMetadata(langsmith.metadata),
    },
  }
}

export function buildDeepagentsRunnableConfig(input: {
  readonly threadId: string
  readonly checkpointId?: string
  readonly signal: AbortSignal
  readonly tracing?: RuntimeTracingState
  readonly tracingContext?: RuntimeTracingContext
}): RunnableConfig<{
  readonly thread_id: string
  readonly checkpoint_id?: string
}> & {
  readonly version: 'v2'
  readonly configurable: {
    readonly thread_id: string
    readonly checkpoint_id?: string
  }
} {
  const langsmith = input.tracing?.langsmith
  const tags = mergeTags(langsmith?.tags, input.tracingContext?.tags)
  const metadata = mergeMetadata(langsmith?.metadata, input.tracingContext?.metadata)

  return {
    version: 'v2',
    configurable: {
      thread_id: input.threadId,
      checkpoint_id: input.checkpointId,
    },
    signal: input.signal,
    callbacks: langsmith === undefined ? undefined : [langsmith.tracer],
    tags,
    metadata,
  }
}

function mergeTags(
  baseTags: readonly string[] | undefined,
  localTags: readonly string[] | undefined
): string[] | undefined {
  const merged = [...(baseTags ?? []), ...(localTags ?? [])]
  return merged.length === 0 ? undefined : merged
}

function mergeMetadata(
  base: Record<string, unknown> | undefined,
  local: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (base === undefined && local === undefined) {
    return undefined
  }

  return {
    ...(base ?? {}),
    ...(local ?? {}),
  }
}

function cloneTags(tags: readonly string[] | undefined): string[] | undefined {
  return tags === undefined ? undefined : [...tags]
}

function cloneMetadata(
  metadata: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  return metadata === undefined ? undefined : { ...metadata }
}
