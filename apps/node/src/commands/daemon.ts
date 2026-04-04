import { fork } from 'node:child_process'
import { readFile, rm } from 'node:fs/promises'

import { DaemonClient } from '@tianji/agent'

import { type UserConfigPaths, getUserConfigPaths } from '../config.js'
import { runDaemonEntry } from '../daemon-entry.js'

import type { CommandDefinition } from './types.js'

async function readDaemonPort(paths: UserConfigPaths): Promise<number | undefined> {
  try {
    const content = await readFile(paths.daemonPortPath, 'utf8')
    const port = Number.parseInt(content.trim(), 10)
    return Number.isInteger(port) && port > 0 ? port : undefined
  } catch {
    return undefined
  }
}

async function readDaemonPid(paths: UserConfigPaths): Promise<number | undefined> {
  try {
    const content = await readFile(paths.daemonPidPath, 'utf8')
    const pid = Number.parseInt(content.trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

async function tryCreateDaemonClient(paths: UserConfigPaths): Promise<DaemonClient | undefined> {
  const port = await readDaemonPort(paths)
  if (port === undefined) {
    return undefined
  }

  return new DaemonClient({ host: '127.0.0.1', port })
}

async function requireDaemonClient(paths: UserConfigPaths): Promise<DaemonClient> {
  const client = await tryCreateDaemonClient(paths)
  if (client === undefined) {
    throw new Error('error.no_daemon_running')
  }

  return client
}

async function cleanupStaleDaemonFiles(paths: UserConfigPaths): Promise<void> {
  await rm(paths.daemonPortPath, { force: true })
  await rm(paths.daemonPidPath, { force: true })
}

function startDetachedDaemonProcess(): void {
  const child = fork(new URL('../daemon-entry.js', import.meta.url), [], {
    detached: true,
    stdio: 'ignore',
  })
  child.disconnect()
  child.unref()
}

async function waitForDaemonReady(
  paths: UserConfigPaths,
  timeoutMs = 10000
): Promise<{ pid: number; port: number }> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const port = await readDaemonPort(paths)
    if (port !== undefined) {
      const client = await tryCreateDaemonClient(paths)
      if (client === undefined) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        continue
      }
      try {
        await client.ping()
        const pid = await readDaemonPid(paths)
        return { pid: pid ?? 0, port }
      } catch {
        // Daemon not accepting connections yet.
      } finally {
        client.close()
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }

  throw new Error('error.daemon_timeout')
}

const daemonStartCommand: CommandDefinition = {
  name: 'start',
  description: 'cmd.daemon.start.description',
  options: [{ long: '--fg', description: 'cmd.daemon.start.option.fg', type: 'boolean' }],
  handler: async ({ options, deps, i18n }) => {
    const resolveUserConfigPaths = deps?.getUserConfigPaths ?? getUserConfigPaths
    const paths = resolveUserConfigPaths()

    const existingClient = await tryCreateDaemonClient(paths)
    if (existingClient !== undefined) {
      try {
        const ping = await existingClient.ping()
        process.stdout.write(`${i18n.t('daemon.already_running', { pid: ping.pid })}\n`)
        return undefined
      } catch {
        await cleanupStaleDaemonFiles(paths)
      }
    }

    if (options.fg === true) {
      const runDaemonEntryCommand = deps?.runDaemonEntry ?? runDaemonEntry
      await runDaemonEntryCommand()
      return undefined
    }

    startDetachedDaemonProcess()

    const { pid, port } = await waitForDaemonReady(paths)
    process.stdout.write(`${i18n.t('daemon.started', { pid, port })}\n`)
  },
}

const daemonStatusCommand: CommandDefinition = {
  name: 'status',
  description: 'cmd.daemon.status.description',
  handler: async ({ deps, i18n }) => {
    const resolveUserConfigPaths = deps?.getUserConfigPaths ?? getUserConfigPaths
    const paths = resolveUserConfigPaths()

    try {
      const client = await requireDaemonClient(paths)
      const ping = await client.ping()
      const port = await readDaemonPort(paths)
      process.stdout.write(
        `${i18n.t('daemon.status', {
          pid: ping.pid,
          port: port ?? 0,
          sessionId: ping.sessionId ?? '',
          uptime: ping.uptime ?? 0,
        })}\n`
      )
      return 0
    } catch (error) {
      if (error instanceof Error) {
        const message = error.message.startsWith('error.')
          ? i18n.t(error.message as never)
          : error.message
        process.stderr.write(`${message}\n`)
        return 1
      }

      throw error
    }
  },
}

const daemonStopCommand: CommandDefinition = {
  name: 'stop',
  description: 'cmd.daemon.stop.description',
  handler: async ({ deps, i18n }) => {
    const resolveUserConfigPaths = deps?.getUserConfigPaths ?? getUserConfigPaths
    const paths = resolveUserConfigPaths()

    try {
      const client = await requireDaemonClient(paths)
      await client.shutdown()
      process.stdout.write(`${i18n.t('daemon.stopped')}\n`)
      return 0
    } catch (error) {
      if (error instanceof Error) {
        const message = error.message.startsWith('error.')
          ? i18n.t(error.message as never)
          : error.message
        process.stderr.write(`${message}\n`)
        return 1
      }

      throw error
    }
  },
}

const daemonRestartCommand: CommandDefinition = {
  name: 'restart',
  description: 'cmd.daemon.restart.description',
  options: [{ long: '--fg', description: 'cmd.daemon.restart.option.fg', type: 'boolean' }],
  handler: async ({ options, deps, i18n }) => {
    const resolveUserConfigPaths = deps?.getUserConfigPaths ?? getUserConfigPaths
    const paths = resolveUserConfigPaths()

    const existingClient = await tryCreateDaemonClient(paths)
    if (existingClient !== undefined) {
      try {
        await existingClient.shutdown()
        process.stdout.write(`${i18n.t('daemon.stopped')}\n`)
      } catch {
        await cleanupStaleDaemonFiles(paths)
      }
    }

    if (options.fg === true) {
      const runDaemonEntryCommand = deps?.runDaemonEntry ?? runDaemonEntry
      await runDaemonEntryCommand()
      return undefined
    }

    startDetachedDaemonProcess()

    const { pid, port } = await waitForDaemonReady(paths)
    process.stdout.write(`${i18n.t('daemon.started', { pid, port })}\n`)
  },
}

/**
 * `daemon` 命令定义，管理后台守护进程。
 */
export const daemonCommand: CommandDefinition = {
  name: 'daemon',
  description: 'cmd.daemon.description',
  subcommands: [daemonStartCommand, daemonStatusCommand, daemonStopCommand, daemonRestartCommand],
  handler: async () => {
    throw new Error('daemon requires subcommand')
  },
}
