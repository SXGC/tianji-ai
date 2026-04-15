/**
 * Checkpoint + HITL 恢复集成测试。
 *
 * 业务职责：
 * - 验证 deepagents interruptOn 机制产生正确的 cancelled run 与 HITL 元数据。
 * - 验证 resumeRun 在有/无 resumeValue、对非 cancelled run 调用时的错误语义。
 * - 验证恢复后工具执行、triggerType、parentRunId 与 metadata 契约。
 *
 * 对外触点：
 * - 通过 createSessionRuntime + MemorySaver + fakeModel 构建确定性 checkpoint 场景。
 * - 依赖 helpers/runtime-test-utils 完成事件采集与状态轮询。
 */
import { AIMessage } from '@langchain/core/messages'
import { fakeModel } from '@langchain/core/testing'
import { MemorySaver } from '@langchain/langgraph'
import { createSessionId } from '@tianji/shared'

import { readDeepagentsRunWorkflowState, readRunRuntimeMetadata } from '../../runtime.js'
import { InMemorySnapshotStore } from '../../snapshot-store.js'
import { ToolRegistry } from '../../tool-catalog.js'
import {
  collectRuntimeEvents,
  createTestRuntime,
  createUserMessage,
  readTextContent,
  waitForRunStatus,
} from '../helpers/runtime-test-utils.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function createSumTool() {
  let executions = 0
  const tool = {
    spec: {
      name: 'sum',
      description: 'Add two numbers',
      parameters: {
        type: 'object' as const,
        properties: {
          a: { type: 'number' },
          b: { type: 'number' },
        },
        required: ['a', 'b'],
      },
    },
    execute: async (args: unknown) => {
      if (!isRecord(args) || typeof args.a !== 'number' || typeof args.b !== 'number') {
        throw new Error('Expected numeric args')
      }

      executions += 1
      return args.a + args.b
    },
    sideEffect: 'idempotent' as const,
  }
  return { tool, getExecutions: () => executions }
}

describe('suite/checkpoint-resume', () => {
  it('interrupt 产生 cancelled run + HITL 元数据', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const checkpointer = new MemorySaver()
    const { tool: sumTool, getExecutions } = createSumTool()
    const toolCatalog = new ToolRegistry().registerTool(sumTool)

    const runtime = createTestRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'sum', args: { a: 2, b: 5 }, id: 'tool-hitl-1' },
        ]),
        checkpointer,
        interruptOn: {
          sum: { allowedDecisions: ['approve', 'reject'] },
        },
      },
      snapshotStore,
      toolCatalog,
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('ckpt-interrupt-basic'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-ckpt-1', 'sum 2+5'),
    })
    const events = await collectRuntimeEvents(runId, runtime)
    const runSnapshot = await waitForRunStatus(runtime, runId, 'cancelled')

    expect(events.map((e) => e.type)).toContain('RunCancelled')
    expect(runSnapshot.status).toBe('cancelled')
    expect(runSnapshot.cancelPoint).toBe('human-in-the-loop')
    expect(runSnapshot.resumeHint).toBe('require-user-confirmation')
    expect(getExecutions()).toBe(0)
  })

  it('interrupt 后 workflowState 包含 deepagents-interrupt', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const checkpointer = new MemorySaver()
    const { tool: sumTool } = createSumTool()
    const toolCatalog = new ToolRegistry().registerTool(sumTool)

    const runtime = createTestRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'sum', args: { a: 3, b: 4 }, id: 'tool-hitl-2' },
        ]),
        checkpointer,
        interruptOn: {
          sum: { allowedDecisions: ['approve', 'reject'] },
        },
      },
      snapshotStore,
      toolCatalog,
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('ckpt-workflow-state'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-ckpt-2', 'sum 3+4'),
    })
    await collectRuntimeEvents(runId, runtime)
    const runSnapshot = await waitForRunStatus(runtime, runId, 'cancelled')
    const workflowState = readDeepagentsRunWorkflowState(runSnapshot.workflowState)

    expect(workflowState).toBeDefined()
    expect(workflowState?.kind).toBe('deepagents-interrupt')
    expect(workflowState?.threadId).toBe(session.sessionId)
    expect(workflowState?.checkpointId).toEqual(expect.any(String))
    expect(workflowState?.interrupts.length).toBeGreaterThan(0)
  })

  it('resumeRun 成功恢复', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const checkpointer = new MemorySaver()
    const { tool: sumTool, getExecutions } = createSumTool()
    const toolCatalog = new ToolRegistry().registerTool(sumTool)

    const interruptingRuntime = createTestRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'sum', args: { a: 2, b: 5 }, id: 'tool-hitl-3' },
        ]),
        checkpointer,
        interruptOn: {
          sum: { allowedDecisions: ['approve', 'reject'] },
        },
      },
      snapshotStore,
      toolCatalog,
    })
    const resumeRuntime = createTestRuntime({
      deepagents: {
        model: fakeModel().respond(new AIMessage('approved sum 7')),
        checkpointer,
        interruptOn: {
          sum: { allowedDecisions: ['approve', 'reject'] },
        },
      },
      snapshotStore,
      toolCatalog,
    })

    const session = await interruptingRuntime.createSession({
      sessionId: createSessionId('ckpt-resume-success'),
    })
    const interruptedRunId = await interruptingRuntime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-ckpt-3', 'sum 2+5 please'),
    })
    await collectRuntimeEvents(interruptedRunId, interruptingRuntime)
    await waitForRunStatus(interruptingRuntime, interruptedRunId, 'cancelled')

    const resumedRunId = await resumeRuntime.resumeRun({
      runId: interruptedRunId,
      resumeValue: { decisions: [{ type: 'approve' }] },
    })
    const resumedEvents = await collectRuntimeEvents(resumedRunId, resumeRuntime)
    const resumedRun = await waitForRunStatus(resumeRuntime, resumedRunId, 'completed')

    expect(resumedRun.triggerType).toBe('resume')
    expect(resumedRun.parentRunId).toBe(interruptedRunId)
    expect(resumedEvents.map((e) => e.type)).toContain('RunCompleted')
    expect(getExecutions()).toBe(1)

    const sessionSnapshot = await resumeRuntime.getSessionSnapshot(session.sessionId)
    expect(readTextContent(sessionSnapshot?.messages.at(-1))).toBe('approved sum 7')
  })

  it('resumeRun 缺少 resumeValue 时报 MISSING_RESUME_VALUE', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const checkpointer = new MemorySaver()
    const { tool: sumTool } = createSumTool()
    const toolCatalog = new ToolRegistry().registerTool(sumTool)

    const runtime = createTestRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'sum', args: { a: 1, b: 1 }, id: 'tool-hitl-4' },
        ]),
        checkpointer,
        interruptOn: {
          sum: { allowedDecisions: ['approve', 'reject'] },
        },
      },
      snapshotStore,
      toolCatalog,
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('ckpt-missing-value'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-ckpt-4', 'sum 1+1'),
    })
    await collectRuntimeEvents(runId, runtime)
    await waitForRunStatus(runtime, runId, 'cancelled')

    await expect(runtime.resumeRun({ runId })).rejects.toMatchObject({
      code: 'MISSING_RESUME_VALUE',
    })
  })

  it('resumeRun 对非 cancelled run 报 RUN_NOT_CANCELLABLE', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const runtime = createTestRuntime({
      deepagents: {
        model: fakeModel().respond(new AIMessage('done')),
      },
      snapshotStore,
      toolCatalog: new ToolRegistry(),
    })

    const session = await runtime.createSession({
      sessionId: createSessionId('ckpt-not-cancelled'),
    })
    const runId = await runtime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-ckpt-5', 'hello'),
    })
    await collectRuntimeEvents(runId, runtime)
    await waitForRunStatus(runtime, runId, 'completed')

    await expect(runtime.resumeRun({ runId })).rejects.toMatchObject({
      code: 'RUN_NOT_CANCELLABLE',
    })
  })

  it('resume 后 metadata 记录 resumedFromRunId', async () => {
    const snapshotStore = new InMemorySnapshotStore()
    const checkpointer = new MemorySaver()
    const { tool: sumTool } = createSumTool()
    const toolCatalog = new ToolRegistry().registerTool(sumTool)

    const interruptingRuntime = createTestRuntime({
      deepagents: {
        model: fakeModel().respondWithTools([
          { name: 'sum', args: { a: 10, b: 20 }, id: 'tool-hitl-6' },
        ]),
        checkpointer,
        interruptOn: {
          sum: { allowedDecisions: ['approve', 'reject'] },
        },
      },
      snapshotStore,
      toolCatalog,
    })
    const resumeRuntime = createTestRuntime({
      deepagents: {
        model: fakeModel().respond(new AIMessage('sum is 30')),
        checkpointer,
        interruptOn: {
          sum: { allowedDecisions: ['approve', 'reject'] },
        },
      },
      snapshotStore,
      toolCatalog,
    })

    const session = await interruptingRuntime.createSession({
      sessionId: createSessionId('ckpt-metadata-resume'),
    })
    const interruptedRunId = await interruptingRuntime.runTurn({
      sessionId: session.sessionId,
      message: createUserMessage('msg-ckpt-6', 'sum 10+20'),
    })
    await collectRuntimeEvents(interruptedRunId, interruptingRuntime)
    await waitForRunStatus(interruptingRuntime, interruptedRunId, 'cancelled')

    const resumedRunId = await resumeRuntime.resumeRun({
      runId: interruptedRunId,
      resumeValue: { decisions: [{ type: 'approve' }] },
    })
    await collectRuntimeEvents(resumedRunId, resumeRuntime)
    const resumedRun = await waitForRunStatus(resumeRuntime, resumedRunId, 'completed')
    const resumedMetadata = readRunRuntimeMetadata(resumedRun.metadata)

    expect(resumedRun.metadata).toMatchObject({
      resumedFromRunId: interruptedRunId,
    })
    expect(resumedMetadata?.threadId).toBe(session.sessionId)
    expect(resumedMetadata?.checkpointId).toEqual(expect.any(String))
  })
})
