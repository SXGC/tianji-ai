/**
 * 解析 register URL，提取 controlplane 基础地址与 enrollment token。
 */
export function parseRegisterUrl(input: string): {
  readonly baseUrl: string
  readonly enrollmentToken: string
} {
  const url = new URL(input)
  const enrollmentToken = url.searchParams.get('enrollment-token')?.trim()

  if (url.pathname !== '/register') {
    throw new Error('Register URL must use /register path')
  }

  if (!enrollmentToken) {
    throw new Error('Register URL must include enrollment-token query parameter')
  }

  return {
    baseUrl: url.origin,
    enrollmentToken,
  }
}
