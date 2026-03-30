import {
  PolicyError,
  type RunId,
  type SessionId,
  ToolError,
  type ToolInvocation,
  type ToolSpec,
} from '@tianji/shared'

export type RuntimeToolSideEffect = 'none' | 'idempotent' | 'destructive'

export interface RuntimeToolExecutionContext {
  readonly sessionId: SessionId
  readonly runId: RunId
  readonly toolCallId: string
  readonly abortSignal?: AbortSignal
}

export interface RuntimeToolDefinition {
  readonly spec: ToolSpec
  readonly execute: (args: unknown, context: RuntimeToolExecutionContext) => Promise<unknown>
  readonly sideEffect?: RuntimeToolSideEffect
}

export interface ToolCatalog {
  readonly hasTool: (toolName: string) => boolean
  readonly getTool: (toolName: string) => RuntimeToolDefinition | undefined
  readonly listTools: () => readonly RuntimeToolDefinition[]
  readonly getToolSpecs: () => readonly ToolSpec[]
  readonly executeTool: (
    invocation: ToolInvocation,
    context: RuntimeToolExecutionContext
  ) => Promise<unknown>
}

class StaticToolCatalog implements ToolCatalog {
  private readonly definitions: ReadonlyMap<string, RuntimeToolDefinition>
  private readonly orderedDefinitions: readonly RuntimeToolDefinition[]

  constructor(definitions: readonly RuntimeToolDefinition[]) {
    this.orderedDefinitions = [...definitions]
    this.definitions = new Map(definitions.map((definition) => [definition.spec.name, definition]))
  }

  readonly hasTool = (toolName: string): boolean => this.definitions.has(toolName)

  readonly getTool = (toolName: string): RuntimeToolDefinition | undefined =>
    this.definitions.get(toolName)

  readonly listTools = (): readonly RuntimeToolDefinition[] => this.orderedDefinitions

  readonly getToolSpecs = (): readonly ToolSpec[] =>
    this.orderedDefinitions.map((definition) => definition.spec)

  readonly executeTool = async (
    invocation: ToolInvocation,
    context: RuntimeToolExecutionContext
  ): Promise<unknown> => {
    const definition = this.getTool(invocation.toolName)

    if (definition === undefined) {
      throw new ToolError('TOOL_NOT_FOUND', `Tool \"${invocation.toolName}\" is not registered`)
    }

    return definition.execute(invocation.args, context)
  }
}

export class ToolRegistry implements ToolCatalog {
  private readonly definitions = new Map<string, RuntimeToolDefinition>()

  constructor(definitions: readonly RuntimeToolDefinition[] = []) {
    for (const definition of definitions) {
      this.registerTool(definition)
    }
  }

  registerTool(definition: RuntimeToolDefinition): this {
    if (this.definitions.has(definition.spec.name)) {
      throw new ToolError(
        'TOOL_DUPLICATE',
        `Tool \"${definition.spec.name}\" has already been registered`
      )
    }

    this.definitions.set(definition.spec.name, definition)
    return this
  }

  createCatalog(toolNames?: readonly string[]): ToolCatalog {
    if (toolNames === undefined) {
      return new StaticToolCatalog(this.listTools())
    }

    const definitions = toolNames.map((toolName) => {
      const definition = this.definitions.get(toolName)

      if (definition === undefined) {
        throw new ToolError('TOOL_NOT_FOUND', `Tool \"${toolName}\" is not registered`)
      }

      return definition
    })

    return new StaticToolCatalog(definitions)
  }

  readonly hasTool = (toolName: string): boolean => this.definitions.has(toolName)

  readonly getTool = (toolName: string): RuntimeToolDefinition | undefined =>
    this.definitions.get(toolName)

  readonly listTools = (): readonly RuntimeToolDefinition[] => [...this.definitions.values()]

  readonly getToolSpecs = (): readonly ToolSpec[] =>
    this.listTools().map((definition) => definition.spec)

  readonly executeTool = async (
    invocation: ToolInvocation,
    context: RuntimeToolExecutionContext
  ): Promise<unknown> => {
    const catalog = this.createCatalog()
    return catalog.executeTool(invocation, context)
  }
}

export function ensureToolAllowed(
  definition: RuntimeToolDefinition,
  allowDestructive: boolean
): void {
  if (definition.sideEffect === 'destructive' && !allowDestructive) {
    throw new PolicyError(
      'TOOL_DESTRUCTIVE_BLOCKED',
      `Tool \"${definition.spec.name}\" is blocked by the current execution policy`
    )
  }
}
