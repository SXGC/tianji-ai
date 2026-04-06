import { type LoadedUserConfigContext, loadUserConfigContext } from '../config.js'

import type { CommandDefinition } from './types.js'

const debugConfigCommand: CommandDefinition = {
  name: 'config',
  description: 'cmd.debug.config.description',
  handler: async ({ deps }) => {
    const loadContext = deps?.loadContext ?? loadUserConfigContext
    const context: LoadedUserConfigContext = await loadContext()
    const writeStdout = deps?.writeStdout ?? ((msg: string) => process.stdout.write(msg))
    writeStdout(`${JSON.stringify(context.config, null, 2)}\n`)
    return 0
  },
}

export const debugCommand: CommandDefinition = {
  name: 'debug',
  description: 'cmd.debug.description',
  subcommands: [debugConfigCommand],
  handler: async () => {
    process.stderr.write('Missing subcommand for "debug".\n')
    return 2
  },
}
