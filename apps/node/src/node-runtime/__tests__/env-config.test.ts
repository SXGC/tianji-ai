import { afterEach, describe, expect, it } from 'vitest'

import { readStoredControlPlaneConfig } from '../controlplane-config.js'
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

describe('readStoredControlPlaneConfig', () => {
  it('returns null when user config has no stored controlplane config', () => {
    expect(readStoredControlPlaneConfig({})).toBeNull()
  })

  it('reads controlplane config from TianjiConfig', () => {
    const result = readStoredControlPlaneConfig({
      controlPlane: {
        baseUrl: 'http://127.0.0.1:3000',
        enrollmentToken: 'token',
        nodeId: 'node-1',
        hostname: 'host',
        platform: 'linux',
        version: '0.0.1',
      },
    })
    expect(result).not.toBeNull()
    expect(result!.baseUrl).toBe('http://127.0.0.1:3000')
    expect(result!.enrollmentToken).toBe('token')
    expect(result!.hostname).toBe('host')
    expect(result!.platform).toBe('linux')
    expect(result!.version).toBe('0.0.1')
  })

  it('returns null when baseUrl is missing', () => {
    expect(
      readStoredControlPlaneConfig({
        controlPlane: { enrollmentToken: 'token' } as Record<string, unknown>,
      })
    ).toBeNull()
  })

  it('returns null when enrollmentToken is missing', () => {
    expect(
      readStoredControlPlaneConfig({
        controlPlane: { baseUrl: 'http://localhost' } as Record<string, unknown>,
      })
    ).toBeNull()
  })
})
