import type { SupportedLocale, TianjiConfig } from '@tianji/shared'

import enMessages from './locales/en.json' with { type: 'json' }
import zhCNMessages from './locales/zh-CN.json' with { type: 'json' }

export type MessageKey = keyof typeof enMessages
export type MessageCatalog = Record<MessageKey, string>

export interface I18n {
  readonly locale: SupportedLocale
  t(key: MessageKey, params?: Record<string, string | number>): string
}

const ZH_CN_VARIANTS = new Set(['zh-cn', 'zh-hans', 'zh-sg'])

/**
 * Interpolates `{name}` placeholders in a translated message.
 *
 * @param template - The message template containing placeholders
 * @param params - Placeholder values used to fill the template
 * @returns The rendered string, preserving unknown placeholders as-is
 */
export function interpolate(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    params[key] !== undefined ? String(params[key]) : `{${key}}`
  )
}

/**
 * Normalizes raw locale strings into the CLI supported locale set.
 *
 * @param locale - The raw locale string from config or Intl
 * @returns A supported locale when recognized, otherwise `undefined`
 */
export function normalizeLocale(locale: string): SupportedLocale | undefined {
  const normalized = locale.replace(/_/g, '-').split('.')[0].toLowerCase()
  if (normalized === 'en' || normalized.startsWith('en-')) {
    return 'en'
  }
  if (ZH_CN_VARIANTS.has(normalized)) {
    return 'zh-CN'
  }

  return undefined
}

/**
 * Resolves the effective CLI locale using config first, then Intl, then English.
 *
 * @param config - Tianji config containing an optional explicit locale
 * @returns The effective supported locale
 */
export function detectLocale(config: Pick<TianjiConfig, 'locale'>): SupportedLocale {
  if (config.locale !== undefined) {
    return config.locale
  }

  const systemLocale = normalizeLocale(Intl.DateTimeFormat().resolvedOptions().locale)
  return systemLocale ?? 'en'
}

function loadCatalog(locale: SupportedLocale): MessageCatalog {
  if (locale === 'en') {
    return enMessages
  }

  return {
    ...enMessages,
    ...zhCNMessages,
  }
}

/**
 * Creates a locale-aware translation helper for CLI user-facing messages.
 *
 * @param locale - The selected supported locale
 * @returns A simple translation interface backed by JSON catalogs
 */
export function createI18n(locale: SupportedLocale): I18n {
  const catalog = loadCatalog(locale)

  return {
    locale,
    t(key, params) {
      const template = catalog[key] ?? enMessages[key]
      return params === undefined ? template : interpolate(template, params)
    },
  }
}
