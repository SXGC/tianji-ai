import { hostname, platform } from 'node:os'

import { createNodeId } from '@tianji/shared'

import { createControlPlaneRuntime } from '../node-runtime/controlplane-runtime.js'

import type { CommandDefinition } from './types.js'

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

/**
 * `register` 命令定义，连接 controlplane 并保持 node 在线。
 */
export const registerCommand: CommandDefinition = {
  name: 'register',
  description: 'cmd.register.description',
  args: [{ name: 'url', description: 'cmd.register.arg.url', required: true }],
  handler: async ({ args, deps }) => {
    const { baseUrl, enrollmentToken } = parseRegisterUrl(args.url)
    const resolveRuntime = deps?.createControlPlaneRuntime ?? createControlPlaneRuntime
    const nodeId = createNodeId(process.env.TIANJI_NODE_ID ?? hostname())

    const runtime = resolveRuntime({
      baseUrl,
      enrollmentToken,
      nodeId,
      hostname: process.env.TIANJI_NODE_HOSTNAME ?? hostname(),
      platform: process.env.TIANJI_NODE_PLATFORM ?? platform(),
      version: process.env.TIANJI_NODE_VERSION ?? '0.0.1',
      agentList: [],
    })

    process.stdout.write(
      `Registering node nodeId=${String(nodeId)} baseUrl=${baseUrl} status=connecting\n`
    )
    await runtime.connection.start()
    process.stdout.write(
      `Registering node nodeId=${String(nodeId)} baseUrl=${baseUrl} status=connected\n`
    )
    process.on('SIGTERM', () => runtime.connection.stop())
    process.on('SIGINT', () => runtime.connection.stop())
    await new Promise(() => undefined)

    return 0
  },
}
