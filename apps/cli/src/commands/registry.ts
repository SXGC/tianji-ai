import { chatCommand } from './chat.js'
import { daemonCommand } from './daemon.js'
import { logCommand } from './log.js'
import { runCommand } from './run.js'
import type { CommandDefinition } from './types.js'

export const COMMAND_REGISTRY: readonly CommandDefinition[] = [
  runCommand,
  logCommand,
  daemonCommand,
  chatCommand,
]

export function findCommand(
  commands: readonly CommandDefinition[],
  name: string
): CommandDefinition | undefined {
  return commands.find((command) => command.name === name)
}
