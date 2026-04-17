import { describe, expect, it } from 'vitest'

import { LOG_LEVEL_ORDER, isLevelAtLeast } from '../level.js'

describe('LOG_LEVEL_ORDER', () => {
  it('orders levels from trace (lowest) to fatal (highest)', () => {
    expect(LOG_LEVEL_ORDER.trace).toBeLessThan(LOG_LEVEL_ORDER.debug)
    expect(LOG_LEVEL_ORDER.debug).toBeLessThan(LOG_LEVEL_ORDER.info)
    expect(LOG_LEVEL_ORDER.info).toBeLessThan(LOG_LEVEL_ORDER.warn)
    expect(LOG_LEVEL_ORDER.warn).toBeLessThan(LOG_LEVEL_ORDER.error)
    expect(LOG_LEVEL_ORDER.error).toBeLessThan(LOG_LEVEL_ORDER.fatal)
  })
})

describe('isLevelAtLeast', () => {
  it('returns true when actual level >= threshold', () => {
    expect(isLevelAtLeast('error', 'warn')).toBe(true)
    expect(isLevelAtLeast('fatal', 'error')).toBe(true)
    expect(isLevelAtLeast('info', 'info')).toBe(true)
  })

  it('returns false when actual level < threshold', () => {
    expect(isLevelAtLeast('debug', 'warn')).toBe(false)
    expect(isLevelAtLeast('trace', 'info')).toBe(false)
  })
})
