import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export interface SerializedMessage {
  readonly role: string
  readonly content: unknown
  readonly name?: string
  readonly toolCallId?: string
  readonly additional_kwargs?: Record<string, unknown>
}

export interface SerializedTool {
  readonly name: string
  readonly description?: string
  readonly schema?: unknown
}

export interface SerializedToolCall {
  readonly id: string
  readonly name: string
  readonly args: unknown
}

export interface LlmCallRequest {
  readonly model: string
  readonly systemPrompt: string
  readonly messages: readonly SerializedMessage[]
  readonly tools: readonly SerializedTool[]
  readonly toolChoice?: unknown
  readonly modelSettings?: Record<string, unknown>
}

export interface LlmCallResponse {
  readonly content: unknown
  readonly toolCalls: readonly SerializedToolCall[]
  readonly usageMetadata?: {
    readonly inputTokens?: number
    readonly outputTokens?: number
    readonly totalTokens?: number
  }
  readonly additional_kwargs?: Record<string, unknown>
}

export interface LlmCallRecord {
  readonly index: number
  readonly request: LlmCallRequest
  readonly response: LlmCallResponse
}

export interface LlmRawRecord {
  readonly runId: string
  readonly sessionId: string
  readonly createdAt: number
  readonly calls: readonly LlmCallRecord[]
}

/**
 * 将 LLM 调用记录原子写入 {baseDirectory}/raws/llm_{runId}.json。
 *
 * 写入方式: 先写临时文件再 rename，保证文件内容完整性。
 */
export class LlmRawStore {
  constructor(private readonly baseDirectory: string) {}

  /**
   * 将一条 LLM 调用记录持久化到磁盘。
   *
   * @param record - 要写入的记录，包含完整的请求与响应信息
   */
  async write(record: LlmRawRecord): Promise<void> {
    const rawsDir = join(this.baseDirectory, 'raws')
    await mkdir(rawsDir, { recursive: true })

    const targetPath = join(rawsDir, `llm_${record.runId}.json`)
    const tmpPath = `${targetPath}.${randomUUID()}.tmp`

    await writeFile(tmpPath, JSON.stringify(record, null, 2), 'utf8')
    await rename(tmpPath, targetPath)
  }
}
