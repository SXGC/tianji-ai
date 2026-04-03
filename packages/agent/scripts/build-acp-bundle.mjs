/**
 * 校验 ACP 入口构建产物可用于独立进程分发。
 *
 * 用法：pnpm build:acp
 * 产物：dist/acp-entry.js
 */

import { access } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const entryPath = resolve(root, 'dist/acp-entry.js')

await access(entryPath)

console.log('ACP entry verified: dist/acp-entry.js')
