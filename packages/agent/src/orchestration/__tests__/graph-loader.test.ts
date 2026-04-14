import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TianjiAgentConfig } from '@tianji/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadDefaultOrchestrationGraph } from '../graph-loader.js'

describe('loadDefaultOrchestrationGraph', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'tianji-graph-loader-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  /** 写好一份最小可用的 configDir 文件集：JSON + SOUL.md */
  async function writeMinimalConfig(
    graphJson: Record<string, unknown>,
    agentName = 'default'
  ): Promise<void> {
    await writeFile(join(tempDir, 'default-orchestration.json'), JSON.stringify(graphJson), 'utf8')
    const agentDir = join(tempDir, 'agents', agentName)
    await mkdir(agentDir, { recursive: true })
    await writeFile(join(agentDir, 'SOUL.md'), 'You are a test agent.\n', 'utf8')
  }

  it('正常加载并展开 native agent 节点', async () => {
    await writeMinimalConfig({
      id: 'test',
      name: 'test-graph',
      version: 1,
      source: 'static',
      locked: false,
      state: { input: { type: 'string' }, output: { type: 'string' } },
      nodes: [
        { id: 'worker', type: 'agent', agent: 'default', input: ['input'], output: ['output'] },
      ],
      edges: [
        { from: '__start__', to: 'worker' },
        { from: 'worker', to: '__end__' },
      ],
    })

    const configs: Record<string, TianjiAgentConfig> = {
      default: { model: 'openai/gpt-4' },
    }

    const graph = await loadDefaultOrchestrationGraph({
      configDir: tempDir,
      agentConfigs: configs,
    })

    expect(graph.id).toBe('test')
    const agentNode = graph.nodes.find((n) => n.id === 'worker')
    expect(agentNode).toBeDefined()
    expect(agentNode!.type).toBe('agent')
    if (agentNode!.type === 'agent') {
      expect(agentNode!.agent.model).toBe('openai/gpt-4')
      expect(agentNode!.agent.systemPrompt).toContain('You are a test agent.')
    }
  })

  it('用户 configDir 无 default-orchestration.json 时 fallback 到包内 bundled 图', async () => {
    const agentDir = join(tempDir, 'agents', 'default')
    await mkdir(agentDir, { recursive: true })
    await writeFile(join(agentDir, 'SOUL.md'), 'bundled fallback soul.\n', 'utf8')

    const graph = await loadDefaultOrchestrationGraph({
      configDir: tempDir,
      agentConfigs: { default: { model: 'openai/gpt-4' } },
    })

    expect(graph.id).toBe('default')
    expect(graph.state).toEqual({
      input: { type: 'string' },
      output: { type: 'string' },
    })
    const agentNode = graph.nodes.find((n) => n.id === 'agent')
    expect(agentNode).toBeDefined()
    if (agentNode!.type === 'agent') {
      expect(agentNode!.input).toEqual(['input'])
      expect(agentNode!.output).toEqual(['output'])
      expect(agentNode!.agent.model).toBe('openai/gpt-4')
    }
  })

  it('引用不存在的 agent name 时报错', async () => {
    await writeMinimalConfig({
      id: 'test',
      name: 'test',
      version: 1,
      source: 'static',
      locked: false,
      state: {},
      nodes: [{ id: 'w', type: 'agent', agent: 'nonexistent' }],
      edges: [
        { from: '__start__', to: 'w' },
        { from: 'w', to: '__end__' },
      ],
    })

    await expect(
      loadDefaultOrchestrationGraph({
        configDir: tempDir,
        agentConfigs: { default: { model: 'openai/gpt-4' } },
      })
    ).rejects.toThrow(/nonexistent/)
  })

  it('引用 external agent 时报错', async () => {
    await writeMinimalConfig({
      id: 'test',
      name: 'test',
      version: 1,
      source: 'static',
      locked: false,
      state: {},
      nodes: [{ id: 'w', type: 'agent', agent: 'ext' }],
      edges: [
        { from: '__start__', to: 'w' },
        { from: 'w', to: '__end__' },
      ],
    })

    const configs: Record<string, TianjiAgentConfig> = {
      ext: { command: 'claude' },
    }

    await expect(
      loadDefaultOrchestrationGraph({
        configDir: tempDir,
        agentConfigs: configs,
      })
    ).rejects.toThrow(/external.*acp-agent/i)
  })

  it('用户 default-orchestration.json 格式损坏时直接抛，不 fallback', async () => {
    await writeFile(join(tempDir, 'default-orchestration.json'), '{ this is not valid json', 'utf8')

    await expect(
      loadDefaultOrchestrationGraph({
        configDir: tempDir,
        agentConfigs: { default: { model: 'openai/gpt-4' } },
      })
    ).rejects.toThrow(/JSON/i)
  })

  it('非 agent 节点原样透传', async () => {
    await writeMinimalConfig({
      id: 'test',
      name: 'test',
      version: 1,
      source: 'static',
      locked: false,
      state: { input: { type: 'string' }, output: { type: 'string' } },
      nodes: [
        { id: 'worker', type: 'agent', agent: 'default', input: ['input'], output: ['output'] },
        { id: 'gate', type: 'human-gate', prompt: 'approve?' },
      ],
      edges: [
        { from: '__start__', to: 'worker' },
        { from: 'worker', to: 'gate' },
        { from: 'gate', to: '__end__' },
      ],
    })

    const graph = await loadDefaultOrchestrationGraph({
      configDir: tempDir,
      agentConfigs: { default: { model: 'openai/gpt-4' } },
    })

    const gateNode = graph.nodes.find((n) => n.id === 'gate')
    expect(gateNode).toBeDefined()
    expect(gateNode!.type).toBe('human-gate')
    if (gateNode!.type === 'human-gate') {
      expect(gateNode!.prompt).toBe('approve?')
    }
  })
})
