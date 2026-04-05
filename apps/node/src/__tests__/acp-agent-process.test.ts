import type { ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AgentProcessManager } from '../acp/agent-process.js'

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
  const proc = emitter as unknown as ChildProcess
  ;(proc as Record<string, unknown>).exitCode = null
  ;(proc as Record<string, unknown>).pid = 12345
  ;(proc as Record<string, unknown>).kill = vi.fn((signal?: string) => {
    if (signal === 'SIGKILL' || signal === 'SIGTERM') {
      ;(proc as Record<string, unknown>).exitCode = 1
      emitter.emit('exit', 1, signal)
    }
    return true
  })

  if (!options?.noStdout) {
    const { Readable } = require('node:stream')
    ;(proc as Record<string, unknown>).stdout = new Readable({ read() {} })
  } else {
    ;(proc as Record<string, unknown>).stdout = null
  }

  if (!options?.noStdin) {
    const { Writable } = require('node:stream')
    ;(proc as Record<string, unknown>).stdin = new Writable({
      write(_c, _e, cb) {
        cb()
      },
    })
  } else {
    ;(proc as Record<string, unknown>).stdin = null
  }

  return proc
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
      binaryPath: '/usr/bin/test',
    })

    expect(manager.agentId).toBe('test-agent')
  })

  it('isRunning returns false before spawn', () => {
    const manager = new AgentProcessManager({
      agentId: 'test-agent',
      binaryPath: '/usr/bin/test',
    })

    expect(manager.isRunning).toBe(false)
  })

  describe('spawn', () => {
    it('spawns a child process and returns Web Streams', () => {
      const mockProc = createMockChildProcess()
      mockSpawn.mockReturnValue(mockProc)

      const manager = new AgentProcessManager({
        agentId: 'test-agent',
        binaryPath: '/usr/bin/test',
        args: ['--port', '3000'],
        env: { CUSTOM_VAR: 'value' },
      })

      const streams = manager.spawn()

      expect(mockSpawn).toHaveBeenCalledWith(
        '/usr/bin/test',
        ['--port', '3000'],
        expect.objectContaining({
          stdio: ['pipe', 'pipe', 'inherit'],
        })
      )
      expect(streams.input).toBeDefined()
      expect(streams.output).toBeDefined()
      expect(manager.isRunning).toBe(true)
    })

    it('spawns with empty args when none provided', () => {
      const mockProc = createMockChildProcess()
      mockSpawn.mockReturnValue(mockProc)

      const manager = new AgentProcessManager({
        agentId: 'test-agent',
        binaryPath: '/usr/bin/test',
      })

      manager.spawn()

      expect(mockSpawn).toHaveBeenCalledWith('/usr/bin/test', [], expect.any(Object))
    })

    it('throws when agent is already running', () => {
      const mockProc = createMockChildProcess()
      mockSpawn.mockReturnValue(mockProc)

      const manager = new AgentProcessManager({
        agentId: 'test-agent',
        binaryPath: '/usr/bin/test',
      })

      manager.spawn()

      expect(() => manager.spawn()).toThrow('Agent test-agent is already running')
    })

    it('throws when stdout is not available', () => {
      const mockProc = createMockChildProcess({ noStdout: true })
      mockSpawn.mockReturnValue(mockProc)

      const manager = new AgentProcessManager({
        agentId: 'test-agent',
        binaryPath: '/usr/bin/test',
      })

      expect(() => manager.spawn()).toThrow('Agent test-agent stdio is not available')
    })

    it('throws when stdin is not available', () => {
      const mockProc = createMockChildProcess({ noStdin: true })
      mockSpawn.mockReturnValue(mockProc)

      const manager = new AgentProcessManager({
        agentId: 'test-agent',
        binaryPath: '/usr/bin/test',
      })

      expect(() => manager.spawn()).toThrow('Agent test-agent stdio is not available')
    })

    it('sets process to null on exit event', () => {
      const mockProc = createMockChildProcess()
      mockSpawn.mockReturnValue(mockProc)

      const manager = new AgentProcessManager({
        agentId: 'test-agent',
        binaryPath: '/usr/bin/test',
      })

      manager.spawn()
      expect(manager.isRunning).toBe(true)

      // 模拟进程退出
      ;(mockProc as Record<string, unknown>).exitCode = 0
      ;(mockProc as EventEmitter).emit('exit', 0)

      expect(manager.isRunning).toBe(false)
    })
  })

  describe('kill', () => {
    it('resolves immediately when no process is running', async () => {
      const manager = new AgentProcessManager({
        agentId: 'test-agent',
        binaryPath: '/usr/bin/test',
      })

      await expect(manager.kill()).resolves.toBeUndefined()
    })

    it('sends SIGTERM and resolves on exit', async () => {
      const mockProc = createMockChildProcess()
      // 覆盖 kill 使其不自动触发 exit
      const killFn = vi.fn()
      ;(mockProc as Record<string, unknown>).kill = killFn
      mockSpawn.mockReturnValue(mockProc)

      const manager = new AgentProcessManager({
        agentId: 'test-agent',
        binaryPath: '/usr/bin/test',
      })

      manager.spawn()

      const killPromise = manager.kill()

      // 验证 SIGTERM 已发送
      expect(killFn).toHaveBeenCalledWith('SIGTERM')

      // 模拟进程退出
      ;(mockProc as EventEmitter).emit('exit', 0)

      await killPromise
      expect(manager.isRunning).toBe(false)
    })

    it('sends SIGKILL after timeout if process does not exit', async () => {
      vi.useFakeTimers()

      const mockProc = createMockChildProcess()
      const killFn = vi.fn()
      ;(mockProc as Record<string, unknown>).kill = killFn
      mockSpawn.mockReturnValue(mockProc)

      const manager = new AgentProcessManager({
        agentId: 'test-agent',
        binaryPath: '/usr/bin/test',
      })

      manager.spawn()

      const killPromise = manager.kill()

      expect(killFn).toHaveBeenCalledWith('SIGTERM')

      // 快进 5 秒触发 SIGKILL
      await vi.advanceTimersByTimeAsync(5000)

      await killPromise

      expect(killFn).toHaveBeenCalledWith('SIGKILL')

      vi.useRealTimers()
    })
  })
})
