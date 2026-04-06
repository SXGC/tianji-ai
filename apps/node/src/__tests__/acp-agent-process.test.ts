import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentProcessManager } from '../acp/agent-process.js'

type MutableChildProcess = ChildProcess & {
  exitCode: number | null
  pid: number
}

/**
 * 创建一个模拟的 ChildProcess 对象。
 *
 * @param options - 控制 stdout/stdin 是否可用
 */
function createMockChildProcess(options?: {
  noStdout?: boolean
  noStdin?: boolean
}): ChildProcess {
  const emitter = new EventEmitter()
  const proc = emitter as unknown as MutableChildProcess
  proc.exitCode = null
  proc.pid = 12345
  proc.kill = vi.fn((signal?: number | NodeJS.Signals) => {
    if (signal === 'SIGKILL' || signal === 'SIGTERM') {
      proc.exitCode = 1
      emitter.emit('exit', 1, signal)
    }
    return true
  }) as ChildProcess['kill']

  if (!options?.noStdout) {
    const { Readable } = require('node:stream')
    proc.stdout = new Readable({ read() {} })
  } else {
    proc.stdout = null
  }

  if (!options?.noStdin) {
    const { Writable } = require('node:stream')
    proc.stdin = new Writable({
      write(_c: Buffer | string, _e: BufferEncoding, cb: (error?: Error | null) => void) {
        cb()
      },
    })
  } else {
    proc.stdin = null
  }

  return proc as ChildProcess
}

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}))

describe('AgentProcessManager', () => {
  let mockSpawn: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.clearAllMocks()
    const cp = await import('node:child_process')
    mockSpawn = cp.spawn as unknown as ReturnType<typeof vi.fn>
  })

  it('stores agentId from config', () => {
    const manager = new AgentProcessManager({
      agentId: 'test-agent',
      command: 'tianji-agent',
    })

    expect(manager.agentId).toBe('test-agent')
  })

  it('isRunning returns false before spawn', () => {
    const manager = new AgentProcessManager({
      agentId: 'test-agent',
      command: 'tianji-agent',
    })

    expect(manager.isRunning).toBe(false)
  })

  describe('spawn', () => {
    it('spawns command with args and returns Web Streams', () => {
      const mockProc = createMockChildProcess()
      mockSpawn.mockReturnValue(mockProc)

      const manager = new AgentProcessManager({
        agentId: 'test-agent',
        command: 'tianji-agent',
        args: ['--flag'],
        env: { CUSTOM_VAR: 'value' },
      })

      const streams = manager.spawn()

      expect(mockSpawn).toHaveBeenCalledWith(
        'tianji-agent',
        ['--flag'],
        expect.objectContaining({
          stdio: ['pipe', 'pipe', 'inherit'],
        })
      )
      expect(streams.input).toBeDefined()
      expect(streams.output).toBeDefined()
      expect(manager.isRunning).toBe(true)
    })

    it('spawns external agent command directly', () => {
      const mockProc = createMockChildProcess()
      mockSpawn.mockReturnValue(mockProc)

      const manager = new AgentProcessManager({
        agentId: 'claude',
        command: 'claude',
        args: ['--acp'],
      })

      manager.spawn()

      expect(mockSpawn).toHaveBeenCalledWith('claude', ['--acp'], expect.any(Object))
    })

    it('spawns with empty args when none provided', () => {
      const mockProc = createMockChildProcess()
      mockSpawn.mockReturnValue(mockProc)

      const manager = new AgentProcessManager({
        agentId: 'test-agent',
        command: 'tianji-agent',
      })

      manager.spawn()

      expect(mockSpawn).toHaveBeenCalledWith('tianji-agent', [], expect.any(Object))
    })

    it('throws when agent is already running', () => {
      const mockProc = createMockChildProcess()
      mockSpawn.mockReturnValue(mockProc)

      const manager = new AgentProcessManager({
        agentId: 'test-agent',
        command: 'tianji-agent',
      })

      manager.spawn()

      expect(() => manager.spawn()).toThrow('Agent test-agent is already running')
    })

    it('throws when stdout is not available', () => {
      const mockProc = createMockChildProcess({ noStdout: true })
      mockSpawn.mockReturnValue(mockProc)

      const manager = new AgentProcessManager({
        agentId: 'test-agent',
        command: 'tianji-agent',
      })

      expect(() => manager.spawn()).toThrow('Agent test-agent stdio is not available')
    })

    it('throws when stdin is not available', () => {
      const mockProc = createMockChildProcess({ noStdin: true })
      mockSpawn.mockReturnValue(mockProc)

      const manager = new AgentProcessManager({
        agentId: 'test-agent',
        command: 'tianji-agent',
      })

      expect(() => manager.spawn()).toThrow('Agent test-agent stdio is not available')
    })

    it('sets process to null on exit event', () => {
      const mockProc = createMockChildProcess()
      mockSpawn.mockReturnValue(mockProc)

      const manager = new AgentProcessManager({
        agentId: 'test-agent',
        command: 'tianji-agent',
      })

      manager.spawn()
      expect(manager.isRunning).toBe(true)
      ;(mockProc as unknown as MutableChildProcess).exitCode = 0
      ;(mockProc as EventEmitter).emit('exit', 0)

      expect(manager.isRunning).toBe(false)
    })
  })

  describe('kill', () => {
    it('resolves immediately when no process is running', async () => {
      const manager = new AgentProcessManager({
        agentId: 'test-agent',
        command: 'tianji-agent',
      })

      await expect(manager.kill()).resolves.toBeUndefined()
    })

    it('sends SIGTERM and resolves on exit', async () => {
      const mockProc = createMockChildProcess()
      const killFn = vi.fn()
      ;(mockProc as unknown as MutableChildProcess).kill = killFn
      mockSpawn.mockReturnValue(mockProc)

      const manager = new AgentProcessManager({
        agentId: 'test-agent',
        command: 'tianji-agent',
      })

      manager.spawn()

      const killPromise = manager.kill()

      expect(killFn).toHaveBeenCalledWith('SIGTERM')
      ;(mockProc as EventEmitter).emit('exit', 0)

      await killPromise
      expect(manager.isRunning).toBe(false)
    })

    it('sends SIGKILL after timeout if process does not exit', async () => {
      vi.useFakeTimers()

      const mockProc = createMockChildProcess()
      const killFn = vi.fn()
      ;(mockProc as unknown as MutableChildProcess).kill = killFn
      mockSpawn.mockReturnValue(mockProc)

      const manager = new AgentProcessManager({
        agentId: 'test-agent',
        command: 'tianji-agent',
      })

      manager.spawn()

      const killPromise = manager.kill()

      expect(killFn).toHaveBeenCalledWith('SIGTERM')

      await vi.advanceTimersByTimeAsync(5000)

      await killPromise

      expect(killFn).toHaveBeenCalledWith('SIGKILL')

      vi.useRealTimers()
    })
  })
})
