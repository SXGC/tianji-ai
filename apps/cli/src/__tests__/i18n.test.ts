import { describe, expect, it, vi } from 'vitest'

import { createI18n, detectLocale, interpolate, normalizeLocale } from '../i18n/index.js'

describe('normalizeLocale', () => {
  it.each([
    ['en', 'en'],
    ['en-US', 'en'],
    ['zh_CN', 'zh-CN'],
    ['zh-CN.UTF-8', 'zh-CN'],
    ['zh-Hans', 'zh-CN'],
    ['zh-SG', 'zh-CN'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeLocale(input)).toBe(expected)
  })

  it('returns undefined for unsupported locales', () => {
    expect(normalizeLocale('fr-FR')).toBeUndefined()
  })

  it('does not map traditional chinese variants to zh-CN', () => {
    expect(normalizeLocale('zh-TW')).toBeUndefined()
    expect(normalizeLocale('zh-Hant')).toBeUndefined()
    expect(normalizeLocale('zh-HK')).toBeUndefined()
  })
})

describe('detectLocale', () => {
  it('prefers explicit config locale', () => {
    expect(detectLocale({ locale: 'zh-CN' })).toBe('zh-CN')
  })

  it('falls back to Intl API when config has no locale', () => {
    const spy = vi
      .spyOn(Intl, 'DateTimeFormat')
      .mockReturnValue({ resolvedOptions: () => ({ locale: 'zh-CN' }) } as Intl.DateTimeFormat)

    try {
      expect(detectLocale({})).toBe('zh-CN')
    } finally {
      spy.mockRestore()
    }
  })

  it('defaults to en when no locale signal is available', () => {
    const spy = vi
      .spyOn(Intl, 'DateTimeFormat')
      .mockReturnValue({ resolvedOptions: () => ({ locale: 'fr-FR' }) } as Intl.DateTimeFormat)

    try {
      expect(detectLocale({})).toBe('en')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('createI18n', () => {
  it('renders translated messages with interpolation', () => {
    const i18n = createI18n('zh-CN')

    expect(i18n.t('daemon.started', { pid: 42, port: 8080 })).toBe(
      '守护进程已启动 (pid=42, port=8080)'
    )
  })

  it('falls back to english when locale catalog is missing a key', () => {
    const i18n = createI18n('zh-CN')

    expect(i18n.t('help.flag.version')).toBeTruthy()
  })
})

describe('interpolate', () => {
  it('keeps missing placeholders intact', () => {
    expect(interpolate('hello {name} {missing}', { name: 'cli' })).toBe('hello cli {missing}')
  })
})
