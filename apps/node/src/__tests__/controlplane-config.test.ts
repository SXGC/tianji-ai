import { hostname, platform } from 'node:os'

import { createNodeId } from '@tianji/shared'
import { describe, expect, it } from 'vitest'

import {
  areStoredControlPlaneConfigsEqual,
  buildStoredControlPlaneConfig,
  readStoredControlPlaneConfig,
} from '../node-runtime/controlplane-config.js'

describe('buildStoredControlPlaneConfig', () => {
  it('builds config from baseUrl and enrollmentToken', () => {
    const result = buildStoredControlPlaneConfig({
      baseUrl: 'http://localhost:3000',
      enrollmentToken: 'tok-123',
    })

    expect(result.baseUrl).toBe('http://localhost:3000')
    expect(result.enrollmentToken).toBe('tok-123')
    expect(result.nodeId).toEqual(createNodeId(hostname()))
    expect(result.hostname).toBe(hostname())
    expect(result.platform).toBe(platform())
    expect(result.version).toBe('0.0.1')
  })
})

describe('areStoredControlPlaneConfigsEqual', () => {
  it('returns true when baseUrl and enrollmentToken match', () => {
    expect(
      areStoredControlPlaneConfigsEqual(
        { baseUrl: 'http://a', enrollmentToken: 'tok' },
        { baseUrl: 'http://a', enrollmentToken: 'tok' }
      )
    ).toBe(true)
  })

  it('returns false when baseUrl differs', () => {
    expect(
      areStoredControlPlaneConfigsEqual(
        { baseUrl: 'http://a', enrollmentToken: 'tok' },
        { baseUrl: 'http://b', enrollmentToken: 'tok' }
      )
    ).toBe(false)
  })

  it('returns false when enrollmentToken differs', () => {
    expect(
      areStoredControlPlaneConfigsEqual(
        { baseUrl: 'http://a', enrollmentToken: 'tok1' },
        { baseUrl: 'http://a', enrollmentToken: 'tok2' }
      )
    ).toBe(false)
  })
})

describe('readStoredControlPlaneConfig', () => {
  it('returns null when controlPlane is missing', () => {
    expect(readStoredControlPlaneConfig({})).toBeNull()
  })

  it('returns null when baseUrl is empty', () => {
    expect(
      readStoredControlPlaneConfig({ controlPlane: { baseUrl: '', enrollmentToken: 'tok' } })
    ).toBeNull()
  })

  it('returns null when enrollmentToken is missing', () => {
    expect(
      readStoredControlPlaneConfig({ controlPlane: { baseUrl: 'http://a', enrollmentToken: '' } })
    ).toBeNull()
  })

  it('reads stored config with defaults for optional fields', () => {
    const result = readStoredControlPlaneConfig({
      controlPlane: {
        baseUrl: 'http://a',
        enrollmentToken: 'tok',
      },
    })

    expect(result).not.toBeNull()
    expect(result!.baseUrl).toBe('http://a')
    expect(result!.enrollmentToken).toBe('tok')
    expect(result!.hostname).toBe(hostname())
    expect(result!.platform).toBe(platform())
    expect(result!.version).toBe('0.0.1')
  })

  it('uses stored values when all fields are present', () => {
    const result = readStoredControlPlaneConfig({
      controlPlane: {
        baseUrl: 'http://a',
        enrollmentToken: 'tok',
        nodeId: 'my-node',
        hostname: 'my-host',
        platform: 'linux',
        version: '1.2.3',
      },
    })

    expect(result).not.toBeNull()
    expect(result!.nodeId).toEqual(createNodeId('my-node'))
    expect(result!.hostname).toBe('my-host')
    expect(result!.platform).toBe('linux')
    expect(result!.version).toBe('1.2.3')
  })
})
