import { describe, expect, it } from 'vitest'

import {
  createGraphRunCapabilityUpperBound,
  resolveNodeCapabilities,
} from '../capability-resolver.js'
import type { AgentNode } from '../graph-schema.js'

function makeAgentNode(overrides: Partial<AgentNode> = {}): AgentNode {
  return {
    id: 'node1',
    type: 'agent',
    agent: {
      model: 'fake',
      systemPrompt: 'You are helpful.',
    },
    ...overrides,
  }
}

describe('capability-resolver', () => {
  it('graph-run 能力上限默认是空 allowlist', () => {
    expect(createGraphRunCapabilityUpperBound()).toEqual({
      skills: [],
      tools: [],
      mcpTargets: [],
    })
  })

  it('节点声明的 skills / tools / mcpTargets 必须是 graph-run 能力上限的子集', () => {
    const upperBound = createGraphRunCapabilityUpperBound({
      skills: ['summarize', 'translate'],
      tools: ['search', 'calc'],
      mcpTargets: ['github', 'slack'],
    })
    const node = makeAgentNode({
      agent: {
        model: 'fake',
        systemPrompt: 'You are helpful.',
        skills: ['summarize'],
        tools: ['search'],
        mcpTargets: ['github'],
      },
    })

    expect(resolveNodeCapabilities(node, upperBound)).toEqual({
      skills: ['summarize'],
      tools: ['search'],
      mcpTargets: ['github'],
    })

    const invalidNode = makeAgentNode({
      agent: {
        model: 'fake',
        systemPrompt: 'You are helpful.',
        skills: ['summarize', 'code'],
      },
    })

    expect(() => resolveNodeCapabilities(invalidNode, upperBound)).toThrow(
      /Capability skills is outside graph-run upper bound: code/
    )
  })

  it('节点声明未知能力时通过 resolveNodeCapabilities 直接抛错', () => {
    const upperBound = createGraphRunCapabilityUpperBound({
      skills: ['summarize'],
    })
    const node = {
      ...makeAgentNode(),
      agent: {
        ...makeAgentNode().agent,
        experimental: ['x'],
      },
    } as AgentNode

    expect(() => resolveNodeCapabilities(node, upperBound)).toThrow(
      /Unknown capability declaration: experimental/
    )
  })

  it('skills 越权时直接抛错', () => {
    const upperBound = createGraphRunCapabilityUpperBound({
      skills: ['summarize'],
    })
    const node = makeAgentNode({
      agent: {
        model: 'fake',
        systemPrompt: 'You are helpful.',
        skills: ['summarize', 'code'],
      },
    })

    expect(() => resolveNodeCapabilities(node, upperBound)).toThrow(
      /Capability skills is outside graph-run upper bound: code/
    )
  })

  it('tools 越权时直接抛错', () => {
    const upperBound = createGraphRunCapabilityUpperBound({
      tools: ['search'],
    })
    const node = makeAgentNode({
      agent: {
        model: 'fake',
        systemPrompt: 'You are helpful.',
        tools: ['search', 'shell'],
      },
    })

    expect(() => resolveNodeCapabilities(node, upperBound)).toThrow(
      /Capability tools is outside graph-run upper bound: shell/
    )
  })

  it('mcpTargets 越权时直接抛错', () => {
    const upperBound = createGraphRunCapabilityUpperBound({
      mcpTargets: ['github'],
    })
    const node = makeAgentNode({
      agent: {
        model: 'fake',
        systemPrompt: 'You are helpful.',
        mcpTargets: ['github', 'slack'],
      },
    })

    expect(() => resolveNodeCapabilities(node, upperBound)).toThrow(
      /Capability mcpTargets is outside graph-run upper bound: slack/
    )
  })

  it('节点默认空能力，不继承全部', () => {
    const upperBound = createGraphRunCapabilityUpperBound({
      skills: ['summarize'],
      tools: ['search'],
      mcpTargets: ['github'],
    })
    const node = makeAgentNode()

    expect(resolveNodeCapabilities(node, upperBound)).toEqual({
      skills: [],
      tools: [],
      mcpTargets: [],
    })
  })

  it('合法的非能力字段不会被误判为未知 capability', () => {
    const upperBound = createGraphRunCapabilityUpperBound()
    const node = makeAgentNode({
      agent: {
        model: 'fake',
        systemPrompt: 'You are helpful.',
        subagents: [
          {
            name: 'helper',
            description: 'assist with mechanical work',
          },
        ],
      },
    })

    expect(resolveNodeCapabilities(node, upperBound)).toEqual({
      skills: [],
      tools: [],
      mcpTargets: [],
    })
  })
})
