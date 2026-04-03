import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 在 smoke e2e 模式下显式加载仓库根目录的 .env.test，
 * 并覆盖当前 shell 中同名变量，保证测试环境一致。
 */
function loadSmokeEnv(): void {
  if (process.env.SMOKE_E2E !== '1') {
    return
  }

  const envFilePath = resolve(import.meta.dirname, '../../../../.env.test')
  const envFileContent = readFileSync(envFilePath, 'utf8')

  for (const line of envFileContent.split(/\r?\n/u)) {
    const trimmedLine = line.trim()
    if (trimmedLine.length === 0 || trimmedLine.startsWith('#')) {
      continue
    }

    const separatorIndex = trimmedLine.indexOf('=')
    if (separatorIndex <= 0) {
      continue
    }

    const key = trimmedLine.slice(0, separatorIndex).trim()
    const value = trimmedLine.slice(separatorIndex + 1)
    process.env[key] = value
  }
}

loadSmokeEnv()
