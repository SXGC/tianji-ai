import {
  ProviderError,
  type TianjiError,
  type ToolInvocation,
  type ToolResult,
} from '@tianji/shared'
import { type LanguageModelUsage, type LanguageModelV1, generateText, streamText, tool } from 'ai'

import type {
  LlmGateway,
  LlmProvider,
  LlmProviderConfig,
  LlmRequest,
  LlmResponse,
  LlmStream,
  LlmStreamCallback,
} from './index.js'
import { appMessagesToSdkMessages } from './message-conversion.js'
import { convertToolSpecs } from './tool-schema-bridge.js'
import { collectLlmUsage } from './usage.js'

type SdkResultLike = {
  readonly text: string
  readonly usage: Pick<LanguageModelUsage, 'promptTokens' | 'completionTokens' | 'totalTokens'>
  readonly finishReason: string
  readonly response: {
    readonly id: string
    readonly modelId: string
  }
  readonly toolCalls: readonly unknown[]
  readonly toolResults: readonly unknown[]
}

type ProviderModelFactory = (config: LlmProviderConfig) => LanguageModelV1

type JsonValue = null | string | number | boolean | { [key: string]: JsonValue } | JsonValue[]

type ProviderMetadata = Record<string, Record<string, JsonValue>>

type SdkStreamLike = {
  readonly fullStream: AsyncIterable<{ type: string; textDelta?: string }>
  readonly text: Promise<string>
  readonly usage: Promise<
    Pick<LanguageModelUsage, 'promptTokens' | 'completionTokens' | 'totalTokens'>
  >
  readonly finishReason: Promise<string>
  readonly response: Promise<{
    readonly id: string
    readonly modelId: string
  }>
  readonly toolCalls: Promise<readonly unknown[]>
  readonly toolResults: Promise<readonly unknown[]>
}

function toError(value: unknown): Error {
  if (value instanceof Error) {
    return value
  }

  return new Error(String(value))
}

function mergeAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined)

  if (activeSignals.length === 0) {
    return undefined
  }

  if (activeSignals.length === 1) {
    return activeSignals[0]
  }

  const controller = new AbortController()
  const abort = (): void => controller.abort()

  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort()
      return controller.signal
    }

    signal.addEventListener('abort', abort, { once: true })
  }

  return controller.signal
}

function isToolCall(value: unknown): value is ToolInvocation {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as {
    toolCallId?: unknown
    toolName?: unknown
    args?: unknown
  }

  return typeof candidate.toolCallId === 'string' && typeof candidate.toolName === 'string'
}

function isToolResult(value: unknown): value is { toolCallId: string; result: unknown } {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as {
    toolCallId?: unknown
    result?: unknown
  }

  return typeof candidate.toolCallId === 'string' && 'result' in candidate
}

function mapToolCalls(values: readonly unknown[]): ToolInvocation[] {
  return values.filter(isToolCall).map((value) => ({
    toolCallId: value.toolCallId,
    toolName: value.toolName,
    args: value.args,
  }))
}

function mapToolResults(values: readonly unknown[]): ToolResult[] {
  return values.filter(isToolResult).map((value) => ({
    toolCallId: value.toolCallId,
    result: value.result,
  }))
}

function buildTools(request: LlmRequest) {
  if (request.tools === undefined || request.tools.length === 0) {
    return undefined
  }

  const bridgedTools = convertToolSpecs(request.tools)

  return Object.fromEntries(
    Object.entries(bridgedTools).map(([toolName, definition]) => {
      const executeTool = request.executeTool

      if (executeTool === undefined) {
        return [toolName, tool({ ...definition, execute: undefined })]
      }

      return [
        toolName,
        tool({
          ...definition,
          execute: async (args: unknown, options: { readonly toolCallId: string }) =>
            executeTool(toolName, args, options),
        }),
      ]
    })
  )
}

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item))
  }

  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJsonValue(item)]))
  }

  // Remaining non-JSON-representable types (undefined, symbol, bigint, function)
  return null
}

function toJsonObject(value: Record<string, unknown>): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJsonValue(item)]))
}

function buildProviderOptions(config: LlmProviderConfig): ProviderMetadata | undefined {
  if (config.options === undefined) {
    return undefined
  }

  return {
    [config.provider]: toJsonObject(config.options),
  }
}

function buildCallOptions(config: LlmProviderConfig, request: LlmRequest, model: LanguageModelV1) {
  return {
    model,
    messages: appMessagesToSdkMessages(request.messages),
    system: request.systemPrompt,
    abortSignal: request.abortSignal,
    headers: request.headers,
    tools: buildTools(request),
    providerOptions: buildProviderOptions(config),
    temperature: request.config?.temperature,
    maxTokens: request.config?.maxTokens,
    topP: request.config?.topP,
    stopSequences:
      request.config?.stopSequences === undefined ? undefined : [...request.config.stopSequences],
    seed: request.config?.seed,
    maxSteps:
      request.config?.maxSteps ??
      (request.tools !== undefined && request.executeTool !== undefined ? 2 : 1),
    ...request.config?.extra,
  }
}

function toLlmResponse(
  provider: LlmProvider,
  config: LlmProviderConfig,
  latencyMs: number,
  result: SdkResultLike
): LlmResponse {
  return {
    content: result.text,
    usage: collectLlmUsage(result.usage, config.pricing),
    meta: {
      provider,
      model: result.response.modelId,
      requestId: result.response.id,
      latencyMs,
    },
    finishReason: result.finishReason,
    toolCalls: mapToolCalls(result.toolCalls),
    toolResults: mapToolResults(result.toolResults),
  }
}

function envVarForProvider(provider: LlmProvider): string {
  switch (provider) {
    case 'openai':
      return 'OPENAI_API_KEY'
    case 'anthropic':
      return 'ANTHROPIC_API_KEY'
    case 'google':
      return 'GOOGLE_GENERATIVE_AI_API_KEY'
  }
}

function isTianjiError(error: unknown): error is TianjiError {
  return error instanceof Error && 'category' in error && 'code' in error
}

class SdkLlmStream implements LlmStream {
  private readonly callbacks = new Set<LlmStreamCallback>()
  private completion: Promise<LlmResponse> | undefined

  constructor(
    private readonly provider: LlmProvider,
    private readonly config: LlmProviderConfig,
    private readonly startedAt: number,
    private readonly result: SdkStreamLike,
    private readonly controller: AbortController
  ) {}

  private ensureStarted(): Promise<LlmResponse> {
    this.completion ??= this.consume()

    return this.completion
  }

  readonly onEvent = (callback: LlmStreamCallback): void => {
    this.callbacks.add(callback)
    this.ensureStarted()
  }

  readonly abort = (): void => {
    this.controller.abort()
  }

  readonly waitUntilComplete = (): Promise<LlmResponse> => this.ensureStarted()

  private emit(event: Parameters<LlmStreamCallback>[0]): void {
    for (const callback of this.callbacks) {
      callback(event)
    }
  }

  private async consume(): Promise<LlmResponse> {
    try {
      for await (const chunk of this.result.fullStream) {
        if (chunk.type === 'text-delta' && typeof chunk.textDelta === 'string') {
          this.emit({
            type: 'delta',
            payload: {
              delta: chunk.textDelta,
              isFinal: false,
            },
          })
        }
      }

      const [text, usage, finishReason, response, toolCalls, toolResults] = await Promise.all([
        this.result.text,
        this.result.usage,
        this.result.finishReason,
        this.result.response,
        this.result.toolCalls,
        this.result.toolResults,
      ])

      this.emit({
        type: 'delta',
        payload: {
          delta: '',
          isFinal: true,
        },
      })

      const responseValue = toLlmResponse(this.provider, this.config, Date.now() - this.startedAt, {
        text,
        usage,
        finishReason,
        response,
        toolCalls,
        toolResults,
      })

      this.emit({
        type: 'complete',
        payload: { response: responseValue },
      })

      return responseValue
    } catch (error) {
      const resolvedError = toError(error)
      this.emit({
        type: 'error',
        payload: {
          message: resolvedError.message,
          code: resolvedError.name,
        },
      })
      throw resolvedError
    }
  }
}

export class SdkLlmGateway implements LlmGateway {
  constructor(
    private readonly config: LlmProviderConfig,
    private readonly provider: LlmProvider,
    private readonly createModel: ProviderModelFactory
  ) {}

  readonly generate = async (request: LlmRequest): Promise<LlmResponse> => {
    const startedAt = Date.now()

    try {
      const result = await generateText({
        ...buildCallOptions(this.config, request, this.createModel(this.config)),
      })

      return toLlmResponse(this.provider, this.config, Date.now() - startedAt, result)
    } catch (error) {
      if (error instanceof ProviderError || isTianjiError(error)) {
        throw error
      }

      const resolvedError = toError(error)
      throw new ProviderError('LLM_GENERATION_FAILED', resolvedError.message, {
        cause: resolvedError,
      })
    }
  }

  readonly stream = async (request: LlmRequest): Promise<LlmStream> => {
    const startedAt = Date.now()
    const controller = new AbortController()
    const abortSignal = mergeAbortSignals(request.abortSignal, controller.signal)
    const result = streamText({
      ...buildCallOptions(this.config, { ...request, abortSignal }, this.createModel(this.config)),
    })

    return new SdkLlmStream(this.provider, this.config, startedAt, result, controller)
  }

  readonly isReady = (): boolean => {
    return (
      this.config.apiKey !== undefined ||
      this.config.baseUrl !== undefined ||
      this.config.headers !== undefined ||
      Boolean(process.env[envVarForProvider(this.provider)])
    )
  }

  readonly getProviderInfo = () => ({
    provider: this.provider,
    model: this.config.model,
  })
}
