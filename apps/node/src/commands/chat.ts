import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'

import { DaemonClient } from '@tianji/agent'

import { getUserConfigPaths } from '../config.js'

import type { CommandDefinition } from './types.js'

/**
 * `chat` 命令定义，连接到 daemon 进行多轮会话。
 */
export const chatCommand: CommandDefinition = {
  name: 'chat',
  description: 'cmd.chat.description',
  handler: async ({ deps, i18n }) => {
    const resolveUserConfigPaths = deps?.getUserConfigPaths ?? getUserConfigPaths
    const paths = resolveUserConfigPaths()

    let port: number | undefined
    try {
      const content = await readFile(paths.daemonPortPath, 'utf8')
      const parsed = Number.parseInt(content.trim(), 10)
      port = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
    } catch {
      port = undefined
    }

    if (port === undefined) {
      throw new Error(i18n.t('error.no_daemon_running'))
    }

    const client = new DaemonClient({ host: '127.0.0.1', port })
    const ping = await client.ping()
    process.stdout.write(`${i18n.t('daemon.connected', { pid: ping.pid })}\n`)

    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> ',
    })
    rl.prompt()

    for await (const line of rl) {
      const trimmed = line.trim()
      if (trimmed === '') {
        rl.prompt()
        continue
      }
      if (trimmed === '.exit') {
        rl.close()
        break
      }

      for await (const event of client.sendChat(trimmed)) {
        if (event.type === 'MessageDelta' && event.channel === 'text') {
          process.stdout.write(event.payload.content)
        }
      }
      process.stdout.write('\n')
      rl.prompt()
    }

    return 0
  },
}
