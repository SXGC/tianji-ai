import { afterEach, describe, expect, it } from 'vitest'

import { readControlPlaneRuntimeConfigFromEnv } from '../env-config.js'

describe('readControlPlaneRuntimeConfigFromEnv', () => {
  const originalBaseUrl = process.env.TIANJI_CP_BASE_URL
  const originalNodeId = process.env.TIANJI_NODE_ID
  const originalEnrollmentToken = process.env.TIANJI_CP_ENROLLMENT_TOKEN
  const originalAgentList = process.env.TIANJI_NODE_AGENT_LIST

  afterEach(() => {
    process.env.TIANJI_CP_BASE_URL = originalBaseUrl
    process.env.TIANJI_NODE_ID = originalNodeId
    process.env.TIANJI_CP_ENROLLMENT_TOKEN = originalEnrollmentToken
    process.env.TIANJI_NODE_AGENT_LIST = originalAgentList
  })

  it('should return null when controlplane env is absent', () => {
    expect(readControlPlaneRuntimeConfigFromEnv()).toBeNull()
  })

  it('should parse controlplane runtime config from env', () => {
    process.env.TIANJI_CP_BASE_URL = 'http://127.0.0.1:3000'
    process.env.TIANJI_NODE_ID = 'node-001'
    process.env.TIANJI_CP_ENROLLMENT_TOKEN = 'enroll-001'
    process.env.TIANJI_NODE_AGENT_LIST = JSON.stringify([
      {
        agentId: 'default',
        type: 'native',
        name: 'Default Agent',
        version: '0.0.1',
      },
    ])

    const config = readControlPlaneRuntimeConfigFromEnv()

    expect(config).not.toBeNull()
    expect(config?.baseUrl).toBe('http://127.0.0.1:3000')
    expect(String(config?.nodeId)).toBe('node-001')
    expect(config?.agentList).toHaveLength(1)
  })
})
