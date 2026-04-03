import { hostname, platform } from 'node:os'

import { type AgentInfo, createNodeId } from '@tianji/shared'

import type { ControlPlaneRuntimeConfig } from './controlplane-runtime.js'

export function readControlPlaneRuntimeConfigFromEnv(): ControlPlaneRuntimeConfig | null {
  const baseUrl = process.env.TIANJI_CP_BASE_URL
  const nodeId = process.env.TIANJI_NODE_ID
  const enrollmentToken = process.env.TIANJI_CP_ENROLLMENT_TOKEN

  if (!baseUrl || !nodeId || !enrollmentToken) {
    return null
  }

  const agentList = parseAgentList(process.env.TIANJI_NODE_AGENT_LIST)

  return {
    baseUrl,
    nodeId: createNodeId(nodeId),
    enrollmentToken,
    hostname: process.env.TIANJI_NODE_HOSTNAME ?? hostname(),
    platform: process.env.TIANJI_NODE_PLATFORM ?? platform(),
    version: process.env.TIANJI_NODE_VERSION ?? '0.0.1',
    agentList,
  }
}

function parseAgentList(raw: string | undefined): readonly AgentInfo[] {
  if (!raw) {
    return []
  }

  return JSON.parse(raw) as AgentInfo[]
}
