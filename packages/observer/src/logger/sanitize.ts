import { errorToLogData } from './error-formatter.js'

const DEFAULT_SENSITIVE_KEYS = ['apiKey', 'prompt', 'soul'] as const

/**
 * Returns the default sensitive field names used by the observer logger.
 */
export function getDefaultObserverSensitiveKeys(): readonly string[] {
  return DEFAULT_SENSITIVE_KEYS
}

/**
 * Sanitizes log payloads by redacting configured keys and normalizing errors.
 */
export function sanitizeObserverLogData(
  data: Record<string, unknown> | undefined,
  sensitiveKeys: ReadonlySet<string> = new Set(DEFAULT_SENSITIVE_KEYS)
): Record<string, unknown> | undefined {
  if (data === undefined) {
    return undefined
  }

  return sanitizeRecord(data, sensitiveKeys)
}

function sanitizeValue(value: unknown, sensitiveKeySet: ReadonlySet<string>): unknown {
  if (value instanceof Error) {
    return errorToLogData(value)
  }

  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeValue(item, sensitiveKeySet))
      .filter((item) => item !== undefined)
  }

  if (isPlainObject(value)) {
    return sanitizeRecord(value, sensitiveKeySet)
  }

  return value
}

function sanitizeRecord(
  value: Record<string, unknown>,
  sensitiveKeySet: ReadonlySet<string>
): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {}

  for (const [key, entryValue] of Object.entries(value)) {
    if (sensitiveKeySet.has(key)) {
      continue
    }

    const sanitizedValue = sanitizeValue(entryValue, sensitiveKeySet)
    if (sanitizedValue !== undefined) {
      result[key] = sanitizedValue
    }
  }

  return Object.keys(result).length === 0 ? undefined : result
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]'
}
