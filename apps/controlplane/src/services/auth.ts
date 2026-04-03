import { createHash, randomBytes } from 'node:crypto'

/** 90 天有效期（毫秒）。 */
export const ACCESS_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000

/**
 * 对 access token 做 SHA-256 哈希以便安全存储。
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * 生成随机 access token。
 */
export function generateAccessToken(): string {
  return randomBytes(48).toString('base64url')
}

/**
 * 验证 access token 是否匹配已存储 hash。
 */
export function verifyAccessToken(token: string, hash: string): boolean {
  return hashToken(token) === hash
}
