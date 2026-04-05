import { describe, expect, it } from 'vitest'

import { parseRegisterUrl } from '../commands/register.js'
import { areStoredControlPlaneConfigsEqual } from '../node-runtime/controlplane-config.js'

describe('parseRegisterUrl', () => {
  it('extracts baseUrl and enrollment token', () => {
    expect(parseRegisterUrl('http://127.0.0.1:3000/register?enrollment-token=test-token')).toEqual({
      baseUrl: 'http://127.0.0.1:3000',
      enrollmentToken: 'test-token',
    })
  })

  it('rejects urls without enrollment token', () => {
    expect(() => parseRegisterUrl('http://127.0.0.1:3000/register')).toThrow(/enrollment-token/)
  })
})

describe('areStoredControlPlaneConfigsEqual', () => {
  it('returns true for identical baseUrl and enrollmentToken', () => {
    expect(
      areStoredControlPlaneConfigsEqual(
        { baseUrl: 'http://cp:3000', enrollmentToken: 'tok-abc' },
        { baseUrl: 'http://cp:3000', enrollmentToken: 'tok-abc' }
      )
    ).toBe(true)
  })

  it('returns false when baseUrl differs', () => {
    expect(
      areStoredControlPlaneConfigsEqual(
        { baseUrl: 'http://cp:3000', enrollmentToken: 'tok-abc' },
        { baseUrl: 'http://cp:4000', enrollmentToken: 'tok-abc' }
      )
    ).toBe(false)
  })

  it('returns false when enrollmentToken differs', () => {
    expect(
      areStoredControlPlaneConfigsEqual(
        { baseUrl: 'http://cp:3000', enrollmentToken: 'tok-abc' },
        { baseUrl: 'http://cp:3000', enrollmentToken: 'tok-xyz' }
      )
    ).toBe(false)
  })
})
