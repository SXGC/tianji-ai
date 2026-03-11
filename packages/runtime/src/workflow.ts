import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import type { AppMessage, ExecutionPolicy, RunId, SessionId } from '@tianji/contracts'
import type { LlmGenerationConfig, LlmResponse } from '@tianji/llm'

const RuntimeWorkflowState = Annotation.Root({
  sessionId: Annotation<SessionId>(),
  runId: Annotation<RunId>(),
  messages: Annotation<readonly AppMessage[]>(),
  policy: Annotation<ExecutionPolicy>(),
  systemPrompt: Annotation<string | undefined>(),
  generationConfig: Annotation<LlmGenerationConfig | undefined>(),
  finalMessage: Annotation<AppMessage | undefined>(),
  response: Annotation<LlmResponse | undefined>(),
})

export type RuntimeWorkflowState = typeof RuntimeWorkflowState.State

export function createRuntimeWorkflow(
  executeAssistantTurn: (
    state: RuntimeWorkflowState
  ) => Promise<Pick<RuntimeWorkflowState, 'finalMessage' | 'response'>>
) {
  return new StateGraph(RuntimeWorkflowState)
    .addNode('assistant_turn', executeAssistantTurn)
    .addEdge(START, 'assistant_turn')
    .addEdge('assistant_turn', END)
    .compile({
      name: 'tianji-runtime-turn',
      description: 'Single-turn runtime workflow for assistant responses',
    })
}
