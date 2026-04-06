import { fork } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'

import { DaemonClient } from '@tianji/agent'

import {
  type LoadedUserConfigContext,
  type UserConfigPaths,
  getUserConfigPaths,
  loadUserConfigContext,
} from '../config.js'
import { runDaemonEntry } from '../daemon-entry.js'
import { logDebug, logInfo } from '../logger.js'
import {
  areStoredControlPlaneConfigsEqual,
  buildStoredControlPlaneConfig,
  readStoredControlPlaneConfig,
} from '../node-runtime/controlplane-config.js'
import { parseRegisterUrl } from './register.js'

import type { TianjiConfig } from '@tianji/shared'

import type { CommandDefinition } from './types.js'

const DAEMON_START_SCOPE = ['cli', 'daemon', 'start'] as const

function formatControlPlaneStatusDetails(input: {
  status: string
  baseUrl: string | null
  lastError: string | null
}): string {
  let suffix = `, controlplane=${input.status}`
  if (input.baseUrl) {
    suffix += `, controlplaneUrl=${input.baseUrl}`
  }
  if (input.lastError) {
    suffix += `, controlplaneError=${input.lastError}`
  }
  return suffix
}

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
  options: [
    { long: '--fg', description: 'cmd.daemon.start.option.fg', type: 'boolean' },
    { long: '--register', description: 'cmd.daemon.start.option.register', type: 'string' },
  ],
  handler: async ({ options, deps, i18n }) => {
    const resolveUserConfigPaths = deps?.getUserConfigPaths ?? getUserConfigPaths
    const paths = resolveUserConfigPaths()

    // 配置加载与 --register 处理
    const registerUrl = options.register as string | undefined
    const loadConfig =
      deps?.loadConfig ??
      (async () => {
        const ctx: LoadedUserConfigContext = await loadUserConfigContext()
        return ctx.config
      })
    const config = await loadConfig().catch(() => ({}))
    const storedControlPlaneConfig = readStoredControlPlaneConfig(config)
    await logInfo(paths, DAEMON_START_SCOPE, 'Loaded daemon configuration', {
      hasRegisterUrl: registerUrl !== undefined,
      hasStoredControlPlaneConfig: storedControlPlaneConfig !== null,
    })

    if (registerUrl) {
      const parsed = parseRegisterUrl(registerUrl)
      const candidate = buildStoredControlPlaneConfig(parsed)
      const stored = storedControlPlaneConfig

      await logDebug(paths, DAEMON_START_SCOPE, 'Parsed register URL', {
        baseUrl: candidate.baseUrl,
        nodeId: candidate.nodeId,
      })

      if (stored && !areStoredControlPlaneConfigsEqual(stored, candidate)) {
        await logInfo(
          paths,
          DAEMON_START_SCOPE,
          'Stored control plane config differs from register URL',
          {
            baseUrl: candidate.baseUrl,
            nodeId: candidate.nodeId,
          }
        )
        const confirm =
          deps?.confirmOverwrite ??
          (async (message: string) => {
            const readline = await import('node:readline/promises')
            const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
            const answer = await rl.question(`${message} [y/N] `)
            rl.close()
            return answer.toLowerCase() === 'y'
          })
        const accepted = await confirm(i18n.t('daemon.register.confirm_overwrite'))
        if (!accepted) {
          await logInfo(paths, DAEMON_START_SCOPE, 'Registration config overwrite declined', {
            baseUrl: candidate.baseUrl,
            nodeId: candidate.nodeId,
          })
          process.stderr.write(`${i18n.t('daemon.register.declined')}\n`)
          return 0
        }
      }

      if (!stored || !areStoredControlPlaneConfigsEqual(stored, candidate)) {
        const saveConfig =
          deps?.saveConfig ??
          (async (c: Partial<TianjiConfig>) => {
            await writeFile(paths.configFilePath, `${JSON.stringify(c, null, 2)}\n`, 'utf8')
          })
        await saveConfig({
          ...config,
          controlPlane: {
            baseUrl: candidate.baseUrl,
            enrollmentToken: candidate.enrollmentToken,
            nodeId: String(candidate.nodeId),
            hostname: candidate.hostname,
            platform: candidate.platform,
            version: candidate.version,
          },
        })
        await logInfo(paths, DAEMON_START_SCOPE, 'Saved control plane registration config', {
          baseUrl: candidate.baseUrl,
          nodeId: candidate.nodeId,
        })
        process.stdout.write(`${i18n.t('daemon.register.saved')}\n`)
      } else {
        await logDebug(paths, DAEMON_START_SCOPE, 'Reusing existing control plane config', {
          baseUrl: candidate.baseUrl,
          nodeId: candidate.nodeId,
        })
      }
    } else {
      const stored = storedControlPlaneConfig
      if (!stored) {
        await logInfo(paths, DAEMON_START_SCOPE, 'No stored control plane config found')
        process.stderr.write(`${i18n.t('daemon.register.no_config')}\n`)
        return 1
      }

      await logDebug(paths, DAEMON_START_SCOPE, 'Loaded stored control plane config', {
        baseUrl: stored.baseUrl,
        nodeId: stored.nodeId,
      })
    }

    const existingClient = await tryCreateDaemonClient(paths)
    if (existingClient !== undefined) {
      try {
        const ping = await existingClient.ping()
        await logInfo(paths, DAEMON_START_SCOPE, 'Daemon already running', {
          pid: ping.pid,
        })
        process.stdout.write(`${i18n.t('daemon.already_running', { pid: ping.pid })}\n`)
        return undefined
      } catch {
        await logDebug(paths, DAEMON_START_SCOPE, 'Removing stale daemon files before start')
        await cleanupStaleDaemonFiles(paths)
      }
    }

    if (options.fg === true) {
      await logInfo(paths, DAEMON_START_SCOPE, 'Starting daemon in foreground mode')
      const runDaemonEntryCommand = deps?.runDaemonEntry ?? runDaemonEntry
      await runDaemonEntryCommand()
      return undefined
    }

    await logDebug(paths, DAEMON_START_SCOPE, 'Starting daemon in background mode')
    startDetachedDaemonProcess()

    const { pid, port } = await waitForDaemonReady(paths)
    await logInfo(paths, DAEMON_START_SCOPE, 'Daemon started in background mode', {
      pid,
      port,
    })
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
        })}${formatControlPlaneStatusDetails({
          status: ping.controlPlane.status,
          baseUrl: ping.controlPlane.baseUrl,
          lastError: ping.controlPlane.lastError,
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
