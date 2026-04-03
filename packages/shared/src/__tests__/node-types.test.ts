import { describe, expect, it } from 'vitest'
import { createNodeId, createSessionId } from '../identifiers.js'
import type {
  AgentInfo,
  NodeHeartbeatRequest,
  NodeRegisterRequest,
  NodeRegisterResponse,
} from '../node-types.js'
import { NODE_EXECUTION_STATES, NODE_STATUSES } from '../node-types.js'

describe('node-types', () => {
  describe('NodeExecutionState', () => {
    it('should include idle and busy', () => {
      expect(NODE_EXECUTION_STATES).toEqual(['idle', 'busy'])
    })
  })

  describe('NodeStatus', () => {
    it('should include online and offline', () => {
      expect(NODE_STATUSES).toEqual(['online', 'offline'])
    })
  })

  describe('AgentInfo', () => {
    it('should construct a native agent info', () => {
      const agent: AgentInfo = {
        agentId: 'default',
        type: 'native',
        name: 'default',
        version: '3.0.0',
      }
      expect(agent.type).toBe('native')
    })

    it('should construct a third-party agent info', () => {
      const agent: AgentInfo = {
        agentId: 'claude-code',
        type: 'third-party',
        name: 'Claude Code',
        version: '1.0.0',
      }
      expect(agent.type).toBe('third-party')
    })
  })

  describe('NodeRegisterRequest', () => {
    it('should construct a register request with agent list', () => {
      const req: NodeRegisterRequest = {
        nodeId: createNodeId('node-uuid'),
        enrollmentToken: 'token-123',
        hostname: 'dev-machine',
        platform: 'linux',
        version: '3.0.0',
        agentList: [{ agentId: 'default', type: 'native', name: 'default', version: '3.0.0' }],
      }
      expect(req.agentList).toHaveLength(1)
    })
  })

  describe('NodeHeartbeatRequest', () => {
    it('should construct a heartbeat without agent list', () => {
      const req: NodeHeartbeatRequest = {
        executionState: 'idle',
      }
      expect(req.agentList).toBeUndefined()
    })

    it('should construct a heartbeat with agent list update', () => {
      const req: NodeHeartbeatRequest = {
        executionState: 'busy',
        agentList: [{ agentId: 'default', type: 'native', name: 'default', version: '3.0.0' }],
      }
      expect(req.executionState).toBe('busy')
      expect(req.agentList).toHaveLength(1)
    })
  })

  describe('NodeRegisterResponse', () => {
    it('should construct a register response', () => {
      const res: NodeRegisterResponse = {
        accessToken: 'jwt-token-value',
        expiresAt: Date.now() + 90 * 24 * 60 * 60 * 1000,
      }
      expect(res.accessToken).toBeDefined()
      expect(res.expiresAt).toBeGreaterThan(Date.now())
    })
  })

  describe('identifier integration', () => {
    it('should use SessionId values for task.run sessionIds', () => {
      const sessionIds = [createSessionId('session-a'), createSessionId('session-b')]
      expect(sessionIds).toHaveLength(2)
      expect(sessionIds[0]).toBe('session-a')
    })
  })
})
