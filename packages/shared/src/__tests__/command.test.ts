import { describe, expect, it } from 'vitest'
import type {
  Command,
  TaskCancelCommand,
  TaskCancelPayload,
  TaskRunCommand,
  TaskRunPayload,
} from '../command.js'
import { COMMAND_STATES, isTerminalCommandState } from '../command.js'
import { createCommandId, createNodeId, createSessionId, createTaskId } from '../identifiers.js'

describe('command types', () => {
  describe('CommandState', () => {
    it('should include all expected states', () => {
      const expected = ['pending', 'leased', 'running', 'completed', 'failed', 'observation_lost']
      expect(COMMAND_STATES).toEqual(expected)
    })

    it('should identify terminal states correctly', () => {
      expect(isTerminalCommandState('completed')).toBe(true)
      expect(isTerminalCommandState('failed')).toBe(true)
      expect(isTerminalCommandState('observation_lost')).toBe(true)
      expect(isTerminalCommandState('pending')).toBe(false)
      expect(isTerminalCommandState('leased')).toBe(false)
      expect(isTerminalCommandState('running')).toBe(false)
    })
  })

  describe('TaskRunPayload', () => {
    it('should construct a payload without sessionIds', () => {
      const payload: TaskRunPayload = {
        taskId: createTaskId('task-001'),
        agentId: 'default',
        goal: 'refactor runtime.ts',
      }
      expect(payload.sessionIds).toBeUndefined()
    })

    it('should construct a payload with sessionIds', () => {
      const payload: TaskRunPayload = {
        taskId: createTaskId('task-001'),
        agentId: 'default',
        goal: 'refactor runtime.ts',
        sessionIds: [createSessionId('session-a'), createSessionId('session-b')],
      }
      expect(payload.sessionIds).toHaveLength(2)
    })
  })

  describe('Command', () => {
    it('should construct a task.run command', () => {
      const cmd: Command = {
        commandId: createCommandId('cmd-001'),
        nodeId: createNodeId('node-001'),
        type: 'task.run',
        payload: {
          taskId: createTaskId('task-001'),
          agentId: 'default',
          goal: 'refactor runtime.ts',
        },
        state: 'pending',
        createdAt: Date.now(),
      }
      expect(cmd.type).toBe('task.run')
      expect(cmd.state).toBe('pending')
    })

    it('should allow leased state with leasedAt', () => {
      const cmd: Command = {
        commandId: createCommandId('cmd-001'),
        nodeId: createNodeId('node-001'),
        type: 'task.run',
        payload: {
          taskId: createTaskId('task-001'),
          agentId: 'default',
          goal: 'refactor',
        },
        state: 'leased',
        leasedAt: Date.now(),
        createdAt: Date.now(),
      }
      expect(cmd.state).toBe('leased')
      expect(cmd.leasedAt).toBeDefined()
    })

    it('should construct a poll response', () => {
      const response = {
        commandId: createCommandId('cmd-002'),
        type: 'task.run' as const,
        payload: {
          taskId: createTaskId('task-002'),
          agentId: 'default',
          goal: 'review changes',
        },
      }

      expect(response.commandId).toBe('cmd-002')
      expect(response.type).toBe('task.run')
    })
  })

  describe('TaskCancelCommand', () => {
    it('Command 支持 task.cancel 子类型', () => {
      const cmd: Command = {
        commandId: createCommandId('cmd-cancel-001'),
        nodeId: createNodeId('node-001'),
        type: 'task.cancel',
        payload: { taskId: createTaskId('task-001'), reason: 'user' },
        state: 'pending',
        createdAt: Date.now(),
      }
      expect(cmd.type).toBe('task.cancel')
      if (cmd.type === 'task.cancel') {
        expect(cmd.payload.taskId).toBe('task-001')
        expect(cmd.payload.reason).toBe('user')
      }
    })

    it('discriminated union：不同 type 对应不同 payload 形状', () => {
      const runCmd: TaskRunCommand = {
        commandId: createCommandId('cmd-run-001'),
        nodeId: createNodeId('node-001'),
        type: 'task.run',
        payload: {
          taskId: createTaskId('task-001'),
          agentId: 'default',
          goal: 'do work',
        },
        state: 'pending',
        createdAt: Date.now(),
      }
      const cancelCmd: TaskCancelCommand = {
        commandId: createCommandId('cmd-cancel-002'),
        nodeId: createNodeId('node-001'),
        type: 'task.cancel',
        payload: { taskId: createTaskId('task-001'), reason: 'user' },
        state: 'pending',
        createdAt: Date.now(),
      }
      const cmds: Command[] = [runCmd, cancelCmd]
      expect(cmds).toHaveLength(2)
      expect(cmds[0]?.type).toBe('task.run')
      expect(cmds[1]?.type).toBe('task.cancel')
    })

    it('TaskCancelPayload 最小字段', () => {
      const payload: TaskCancelPayload = {
        taskId: createTaskId('task-001'),
        reason: 'user',
      }
      expect(payload.taskId).toBe('task-001')
      expect(payload.reason).toBe('user')
    })
  })
})
