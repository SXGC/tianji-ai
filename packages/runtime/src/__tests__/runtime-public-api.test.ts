/**
 * runtime 公共 API 边界测试。
 *
 * 业务职责：
 * - 校验 public API v2 仅暴露 deepagents 配置面，同时保持 SessionRuntime 方法签名稳定。
 * - 验证源码与 README 对 legacy 兼容策略的文档约束未被破坏。
 *
 * 对外触点：
 * - 直接消费 ../index.js 公开类型与工厂函数。
 * - 读取 ../runtime.ts、../index.ts、../../README.md 校验文档化边界。
 */
import { readFile } from 'node:fs/promises'

import { MemorySaver } from '@langchain/langgraph'
import { TianjiError } from '@tianji/shared'
import { describe, expect, expectTypeOf, it } from 'vitest'

import {
  InMemorySnapshotStore,
  type SessionRuntime,
  type SessionRuntimeDeepagentsConfig,
  type SessionRuntimeEngine,
  type SessionRuntimeOptions,
  ToolRegistry,
  createSessionRuntime,
} from '../index.js'

describe('runtime public API v2 boundary', () => {
  it('accepts the deepagents config block while keeping SessionRuntime methods stable', () => {
    const deepagentsConfig: SessionRuntimeDeepagentsConfig = {
      model: 'openai:gpt-5.1',
      middleware: [],
      backend: { kind: 'state-backend' },
      checkpointer: { kind: 'memory-saver' },
      store: { kind: 'memory-store' },
      subagents: [{ name: 'planner' }],
      skills: ['/skills/'],
      interruptOn: {
        write_file: true,
        edit_file: { allowedDecisions: ['approve', 'reject'] },
      },
    }
    const runtime: SessionRuntime = createSessionRuntime({
      deepagents: {
        model: deepagentsConfig.model,
        middleware: deepagentsConfig.middleware,
        backend: deepagentsConfig.backend,
        checkpointer: new MemorySaver(),
        store: deepagentsConfig.store,
        subagents: deepagentsConfig.subagents,
        skills: deepagentsConfig.skills,
        interruptOn: deepagentsConfig.interruptOn,
      },
      snapshotStore: new InMemorySnapshotStore(),
      toolCatalog: new ToolRegistry(),
    })

    expectTypeOf<SessionRuntimeEngine>().toEqualTypeOf<'legacy' | 'deepagents'>()
    expectTypeOf<SessionRuntimeOptions['engine']>().toEqualTypeOf<'deepagents' | undefined>()
    expectTypeOf<SessionRuntimeOptions['deepagents']>().toEqualTypeOf<
      SessionRuntimeDeepagentsConfig | undefined
    >()
    expect(runtime.createSession).toBeDefined()
    expect(runtime.closeSession).toBeDefined()
    expect(runtime.getSessionSnapshot).toBeDefined()
    expect(runtime.getRunSnapshot).toBeDefined()
    expect(runtime.runTurn).toBeDefined()
    expect(runtime.resumeRun).toBeDefined()
    expect(runtime.streamEvents).toBeDefined()
    expect(runtime.cancelRun).toBeDefined()
  })

  it('requires a checkpointer when interruptOn is configured', () => {
    expect(() =>
      createSessionRuntime({
        deepagents: {
          model: 'openai:gpt-5.1',
          interruptOn: {
            edit_file: { allowedDecisions: ['approve', 'reject'] },
          },
        },
        snapshotStore: new InMemorySnapshotStore(),
        toolCatalog: new ToolRegistry(),
      })
    ).toThrow(TianjiError)
  })

  it('removes the legacy config surface while keeping legacy metadata compatibility documented', async () => {
    const runtimeSource = await readFile(new URL('../runtime.ts', import.meta.url), 'utf8')
    const indexSource = await readFile(new URL('../index.ts', import.meta.url), 'utf8')
    const readme = await readFile(new URL('../../README.md', import.meta.url), 'utf8')

    expect(runtimeSource).not.toContain('SessionRuntimeLegacyOptions')
    expect(runtimeSource).not.toContain('llmGateway')
    expect(indexSource).not.toContain('SessionRuntimeLegacyOptions')
    expect(readme).toContain('deepagents-only')
    expect(readme).toContain('legacy session/run snapshot')
    expect(readme).toContain('readSessionRuntimeMetadata')
    expect(readme).toContain('readRunRuntimeMetadata')
  })
})
