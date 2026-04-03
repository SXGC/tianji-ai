import { accessSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const DEV_ENV_CANDIDATES = ['.env.local', '.env'] as const

/**
 * 在开发态从仓库根加载环境变量文件。
 *
 * 加载顺序为 `.env.local` 优先，找不到时回退到 `.env`。已存在于
 * `process.env` 的变量不会被覆盖，避免污染显式传入的 shell 环境。
 *
 * @param repoRoot - 可选的仓库根目录覆盖，仅用于测试
 */
export function loadDevelopmentEnv(repoRoot = resolve(import.meta.dirname, '../../..')): void {
  for (const fileName of DEV_ENV_CANDIDATES) {
    const filePath = join(repoRoot, fileName)

    try {
      accessSync(filePath)
      loadEnvFile(filePath)
      return
    } catch {
      // Try the next development env candidate.
    }
  }
}

function loadEnvFile(filePath: string): void {
  const envFileContent = readFileSync(filePath, 'utf8')

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
    if (process.env[key] !== undefined) {
      continue
    }

    process.env[key] = trimmedLine.slice(separatorIndex + 1)
  }
}
