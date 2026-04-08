import { fork } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'

import { type ControlPlaneStatusSnapshot, DaemonClient } from '@tianji/agent'

import {
  type LoadedUserConfigContext,
  type UserConfigPaths,
  getUserConfigPaths,
  loadUserConfigContext,
} from '../config.js'
import { runDaemonEntry } from '../daemon-entry.js'
import { type CliLogScope, logDebug, logError, logInfo } from '../logger.js'
import {
  areStoredControlPlaneConfigsEqual,
  buildStoredControlPlaneConfig,
  readStoredControlPlaneConfig,
} from '../node-runtime/controlplane-config.js'
import { parseRegisterUrl } from './register.js'

import type { TianjiConfig } from '@tianji/shared'

import type { CliDependencies, CommandDefinition } from './types.js'

import type { I18n } from '../i18n/index.js'

const DAEMON_START_SCOPE = ['cli', 'daemon', 'start'] as const
const DAEMON_STOP_SCOPE = ['cli', 'daemon', 'stop'] as const
const DAEMON_RESTART_SCOPE = ['cli', 'daemon', 'restart'] as const

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

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function forceKillProcess(pid: number): boolean {
  try {
    process.kill(pid, 'SIGKILL')
    return true
  } catch {
    return false
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true
    }

    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  return !isProcessAlive(pid)
}

/**
 * 尝试优雅停止 daemon，超时后强制终止。
 *
 * 优先使用调用方传入的 pid，避免因 DaemonServer.shutdown() 已删除 pid 文件
 * 而误判进程已退出。
 *
 * @returns 进程是否已退出
 */
async function stopDaemonGracefullyOrForce(
  paths: UserConfigPaths,
  scope: CliLogScope,
  preloadedPid?: number
): Promise<boolean> {
  const pid = preloadedPid ?? (await readDaemonPid(paths))
  if (pid === undefined) {
    return true
  }

  if (!isProcessAlive(pid)) {
    await logDebug(paths, scope, 'Daemon process already exited', { pid })
    await cleanupStaleDaemonFiles(paths)
    return true
  }

  await logDebug(paths, scope, 'Waiting for daemon process to exit', { pid })
  const exited = await waitForProcessExit(pid, 5000)
  if (exited) {
    await logDebug(paths, scope, 'Daemon process exited gracefully', { pid })
    await cleanupStaleDaemonFiles(paths)
    return true
  }

  // Re-read PID file: if server already cleaned up its own PID file, shutdown succeeded
  const currentPid = await readDaemonPid(paths)
  if (currentPid === undefined) {
    await logDebug(paths, scope, 'Daemon PID file removed, treating as successful shutdown', {
      pid,
    })
    return true
  }

  await logDebug(paths, scope, 'Graceful shutdown timed out, sending SIGTERM', { pid })
  process.kill(pid, 'SIGTERM')
  const exitedAfterTerm = await waitForProcessExit(pid, 3000)
  if (exitedAfterTerm) {
    await logDebug(paths, scope, 'Daemon process exited after SIGTERM', { pid })
    await cleanupStaleDaemonFiles(paths)
    return true
  }

  await logDebug(paths, scope, 'SIGTERM timed out, sending SIGKILL', { pid })
  const killed = forceKillProcess(pid)
  await logDebug(paths, scope, 'SIGKILL result', { pid, killed })

  if (killed) {
    const exitedAfterKill = await waitForProcessExit(pid, 3000)
    await logDebug(paths, scope, 'Process exit after SIGKILL', { pid, exited: exitedAfterKill })
  }

  await cleanupStaleDaemonFiles(paths)
  return !isProcessAlive(pid)
}

async function ensureNoOrphanedDaemon(paths: UserConfigPaths): Promise<boolean> {
  const pid = await readDaemonPid(paths)
  if (pid === undefined) {
    return false
  }

  if (!isProcessAlive(pid)) {
    await cleanupStaleDaemonFiles(paths)
    return false
  }

  return true
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

/**
 * 轮询 daemon 的 controlplane 状态，直到不再处于 connecting 或超时。
 */
async function waitForControlPlaneSettled(
  paths: UserConfigPaths,
  timeoutMs = 15000
): Promise<ControlPlaneStatusSnapshot> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const client = await tryCreateDaemonClient(paths)
    if (client !== undefined) {
      try {
        const ping = await client.ping()
        if (ping.controlPlane.status !== 'connecting') {
          return ping.controlPlane
        }
      } catch {
        // daemon 还没响应，继续等
      } finally {
        client.close()
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return {
    enabled: true,
    status: 'degraded',
    baseUrl: null,
    lastSuccessAt: null,
    lastError: 'Timed out waiting for controlplane registration',
  }
}

/**
 * 处理 --register URL 参数：解析、确认覆盖、保存配置。
 *
 * @returns 0 表示用户拒绝覆盖，undefined 表示成功
 */
async function handleRegisterUrl(
  paths: UserConfigPaths,
  registerUrl: string,
  config: Partial<TianjiConfig>,
  storedControlPlaneConfig: ReturnType<typeof readStoredControlPlaneConfig>,
  deps: CliDependencies | undefined,
  i18n: I18n
): Promise<number | undefined> {
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
      { baseUrl: candidate.baseUrl, nodeId: candidate.nodeId }
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

  return undefined
}

/**
 * 检查已有 daemon 进程状态，确保可以安全启动新进程。
 *
 * @returns 非 undefined 时表示应提前退出并使用该退出码
 */
async function ensureDaemonSlotAvailable(
  paths: UserConfigPaths,
  i18n: I18n
): Promise<number | undefined> {
  const existingClient = await tryCreateDaemonClient(paths)
  if (existingClient !== undefined) {
    try {
      const ping = await existingClient.ping()
      await logInfo(paths, DAEMON_START_SCOPE, 'Daemon already running', { pid: ping.pid })
      process.stdout.write(`${i18n.t('daemon.already_running', { pid: ping.pid })}\n`)
      return 0
    } catch {
      if (await ensureNoOrphanedDaemon(paths)) {
        process.stderr.write(
          'Daemon process is still running but not responding. Stop it before starting a new one.\n'
        )
        return 1
      }
      await logDebug(paths, DAEMON_START_SCOPE, 'Removing stale daemon files before start')
      await cleanupStaleDaemonFiles(paths)
    }
  } else if (await ensureNoOrphanedDaemon(paths)) {
    process.stderr.write(
      'Daemon process is still running but state files are inconsistent. Stop it before starting a new one.\n'
    )
    return 1
  }

  return undefined
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
      const registerResult = await handleRegisterUrl(
        paths,
        registerUrl,
        config,
        storedControlPlaneConfig,
        deps,
        i18n
      )
      if (registerResult !== undefined) {
        return registerResult
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

    const slotResult = await ensureDaemonSlotAvailable(paths, i18n)
    if (slotResult !== undefined) {
      return slotResult
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

    const cpStatus = await waitForControlPlaneSettled(paths)
    if (cpStatus.status === 'connected') {
      process.stdout.write(`${i18n.t('daemon.controlplane.connected')}\n`)
    } else {
      await logError(paths, DAEMON_START_SCOPE, 'Controlplane registration failed after start', {
        status: cpStatus.status,
        lastError: cpStatus.lastError ?? 'unknown',
      })
      process.stderr.write(
        `${i18n.t('daemon.controlplane.failed', { error: cpStatus.lastError ?? 'unknown' })}\n`
      )
    }
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
      const pid = await readDaemonPid(paths)
      const client = await requireDaemonClient(paths)

      if (pid !== undefined) {
        await logInfo(paths, DAEMON_STOP_SCOPE, 'Stopping daemon', { pid })
        process.stdout.write(`${i18n.t('daemon.stop.stopping', { pid })}\n`)
      }

      await logInfo(paths, DAEMON_STOP_SCOPE, 'Sending shutdown request')
      await client.shutdown()
      client.close()

      const stopped = await stopDaemonGracefullyOrForce(paths, DAEMON_STOP_SCOPE, pid)
      if (!stopped) {
        await logError(paths, DAEMON_STOP_SCOPE, 'Failed to stop daemon process', {
          pid: pid ?? 0,
        })
        process.stderr.write(`${i18n.t('daemon.stop.process_kill_failed', { pid: pid ?? 0 })}\n`)
        return 1
      }

      if (pid !== undefined) {
        await logInfo(paths, DAEMON_STOP_SCOPE, 'Daemon process stopped', { pid })
        process.stdout.write(`${i18n.t('daemon.stop.process_killed', { pid })}\n`)
      }

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

    const loadConfig =
      deps?.loadConfig ??
      (async () => {
        const ctx: LoadedUserConfigContext = await loadUserConfigContext()
        return ctx.config
      })
    const config = await loadConfig().catch(() => ({}))
    const storedControlPlaneConfig = readStoredControlPlaneConfig(config)

    await logInfo(paths, DAEMON_RESTART_SCOPE, 'Daemon restart initiated', {
      hasStoredControlPlaneConfig: storedControlPlaneConfig !== null,
      controlPlaneBaseUrl: storedControlPlaneConfig?.baseUrl ?? null,
      nodeId: storedControlPlaneConfig?.nodeId ?? null,
      foreground: options.fg === true,
    })

    if (storedControlPlaneConfig) {
      process.stdout.write(
        `Control plane: ${storedControlPlaneConfig.baseUrl}, nodeId=${storedControlPlaneConfig.nodeId}\n`
      )
    }

    const oldPid = await readDaemonPid(paths)
    const existingClient = await tryCreateDaemonClient(paths)

    if (existingClient !== undefined) {
      await logInfo(paths, DAEMON_RESTART_SCOPE, 'Found running daemon, stopping', {
        pid: oldPid ?? 0,
      })
      process.stdout.write(`${i18n.t('daemon.restart.found_running', { pid: oldPid ?? 0 })}\n`)

      try {
        await logInfo(paths, DAEMON_RESTART_SCOPE, 'Sending shutdown request', {
          pid: oldPid ?? 0,
        })
        await existingClient.shutdown()
        existingClient.close()
        process.stdout.write(`${i18n.t('daemon.restart.shutdown_sent', { pid: oldPid ?? 0 })}\n`)
      } catch {
        await logInfo(paths, DAEMON_RESTART_SCOPE, 'Shutdown request failed, escalating')
        process.stdout.write(`${i18n.t('daemon.restart.shutdown_failed')}\n`)
      }

      const stopped = await stopDaemonGracefullyOrForce(paths, DAEMON_RESTART_SCOPE, oldPid)
      if (!stopped) {
        await logError(paths, DAEMON_RESTART_SCOPE, 'Failed to stop daemon process', {
          pid: oldPid ?? 0,
        })
        process.stderr.write(
          `${i18n.t('daemon.restart.process_kill_failed', { pid: oldPid ?? 0 })}\n`
        )
        return 1
      }

      await logInfo(paths, DAEMON_RESTART_SCOPE, 'Daemon process stopped', {
        pid: oldPid ?? 0,
      })
      process.stdout.write(`${i18n.t('daemon.restart.process_killed', { pid: oldPid ?? 0 })}\n`)
    } else if (oldPid !== undefined && isProcessAlive(oldPid)) {
      await logInfo(paths, DAEMON_RESTART_SCOPE, 'Found orphaned daemon process', {
        pid: oldPid,
      })
      process.stdout.write(`${i18n.t('daemon.restart.orphan_found', { pid: oldPid })}\n`)

      const stopped = await stopDaemonGracefullyOrForce(paths, DAEMON_RESTART_SCOPE, oldPid)
      if (!stopped) {
        await logError(paths, DAEMON_RESTART_SCOPE, 'Failed to stop orphaned daemon process', {
          pid: oldPid,
        })
        process.stderr.write(`${i18n.t('daemon.restart.process_kill_failed', { pid: oldPid })}\n`)
        return 1
      }

      await logInfo(paths, DAEMON_RESTART_SCOPE, 'Orphaned daemon process stopped', {
        pid: oldPid,
      })
      process.stdout.write(`${i18n.t('daemon.restart.process_killed', { pid: oldPid })}\n`)
    } else {
      await cleanupStaleDaemonFiles(paths)
      await logInfo(paths, DAEMON_RESTART_SCOPE, 'No running daemon found, starting fresh')
      process.stdout.write(`${i18n.t('daemon.restart.no_daemon')}\n`)
    }

    if (options.fg === true) {
      await logInfo(paths, DAEMON_RESTART_SCOPE, 'Starting daemon in foreground mode')
      process.stdout.write(`${i18n.t('daemon.restart.starting_fg')}\n`)
      const runDaemonEntryCommand = deps?.runDaemonEntry ?? runDaemonEntry
      await runDaemonEntryCommand()
      return undefined
    }

    await logInfo(paths, DAEMON_RESTART_SCOPE, 'Starting daemon in background mode')
    process.stdout.write(`${i18n.t('daemon.restart.starting_bg')}\n`)
    startDetachedDaemonProcess()

    const { pid: newPid, port } = await waitForDaemonReady(paths)
    await logInfo(paths, DAEMON_RESTART_SCOPE, 'Daemon restarted', {
      oldPid: oldPid ?? null,
      newPid,
      port,
    })
    process.stdout.write(`${i18n.t('daemon.restart.restarted', { pid: newPid, port })}\n`)
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
