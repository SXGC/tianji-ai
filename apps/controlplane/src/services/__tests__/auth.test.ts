import { describe, expect, it } from 'vitest'

import { generateAccessToken, hashToken, verifyAccessToken } from '../auth.js'

describe('auth service', () => {
  it('should hash token deterministically', () => {
    const hash1 = hashToken('test-token')
    const hash2 = hashToken('test-token')

    expect(hash1).toBe(hash2)
  })

  it('should produce different hashes for different tokens', () => {
    const hash1 = hashToken('token-a')
    const hash2 = hashToken('token-b')

    expect(hash1).not.toBe(hash2)
  })

  it('should generate a non-empty access token', () => {
    const token = generateAccessToken()

    expect(token.length).toBeGreaterThan(20)
  })

  it('should verify a valid token against its hash', () => {
    const token = generateAccessToken()
    const hash = hashToken(token)

    expect(verifyAccessToken(token, hash)).toBe(true)
  })

  it('should reject an invalid token', () => {
    const hash = hashToken('real-token')

    expect(verifyAccessToken('wrong-token', hash)).toBe(false)
  })
})
