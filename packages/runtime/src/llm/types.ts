export interface LlmGenerationConfig {
  readonly temperature?: number
  readonly maxTokens?: number
  readonly topP?: number
  readonly stopSequences?: readonly string[]
  readonly seed?: number
  readonly maxSteps?: number
  readonly extra?: Record<string, unknown>
}
