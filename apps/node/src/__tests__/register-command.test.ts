import { describe, expect, it } from 'vitest'

import * as registerModule from '../commands/register.js'
import { areStoredControlPlaneConfigsEqual } from '../node-runtime/controlplane-config.js'

describe('parseRegisterUrl', () => {
  it('extracts baseUrl and enrollment token', () => {
    expect(
      registerModule.parseRegisterUrl('http://127.0.0.1:3000/register?enrollment-token=test-token')
    ).toEqual({
      baseUrl: 'http://127.0.0.1:3000',
      enrollmentToken: 'test-token',
    })
  })

  it('rejects urls without enrollment token', () => {
    expect(() => registerModule.parseRegisterUrl('http://127.0.0.1:3000/register')).toThrow(
      /enrollment-token/
    )
  })

  it('rejects urls outside register path', () => {
    expect(() =>
      registerModule.parseRegisterUrl('http://127.0.0.1:3000/api/nodes/register?enrollment-token=x')
    ).toThrow(/Register URL must use \/register path/)
  })

  it('does not export legacy register command', () => {
    expect(registerModule).not.toHaveProperty('registerCommand')
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
