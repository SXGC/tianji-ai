import { getUserConfigPaths } from '../config.js'
import { followCliLog } from '../log-follow.js'

import type { CommandDefinition } from './types.js'

/**
 * `log` 命令定义，默认 follow 并允许设置回放行数。
 */
export const logCommand: CommandDefinition = {
  name: 'log',
  description: 'cmd.log.description',
  options: [
    {
      long: '--follow',
      short: '-f',
      description: 'cmd.log.option.follow',
      type: 'boolean',
      default: true,
    },
    {
      long: '--lines',
      short: '-n',
      description: 'cmd.log.option.lines',
      type: 'number',
      default: 100,
    },
  ],
  handler: async ({ options, deps, i18n }) => {
    const resolveUserConfigPaths = deps?.getUserConfigPaths ?? getUserConfigPaths
    const followCliLogCommand = deps?.followCliLog ?? followCliLog
    const paths = resolveUserConfigPaths()

    await followCliLogCommand(paths.cliLogFilePath, i18n, {
      follow: options.follow === true,
      lines: typeof options.lines === 'number' ? options.lines : 100,
    })

    return 0
  },
}
