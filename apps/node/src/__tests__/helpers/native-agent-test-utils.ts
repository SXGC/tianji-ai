/**
 * Native agent 集成测试共享辅助工具。
 *
 * 提供 fake context、command 构造、NDJSON writer stub 以及常用事件工厂，
 * 避免各测试文件重复定义相同的测试数据构造逻辑。
 */
import type { LoadedAgentContext } from '@tianji/agent'
import type { Command, DomainEvent } from '@tianji/shared'
import { createNodeId, type createTaskId } from '@tianji/shared'

export const RUN_ID = 'run-001' as never
export const SESSION_ID = 'session-001' as never

/**
 * 构造最小可用的 LoadedAgentContext，用于 native agent 测试。
 */
export function createFakeContext(): LoadedAgentContext {
  return {
    paths: {
      configDir: '/tmp/config',
      agentsDir: '/tmp/agents',
      logsDir: '/tmp/logs',
      configFilePath: '/tmp/config/config.json',
      cliLogFilePath: '/tmp/logs/cli.log',
      daemonPortPath: '/tmp/config/daemon.port',
      daemonPidPath: '/tmp/config/daemon.pid',
    },
    config: {},
    agent: {
      agentName: 'test-agent',
      modelRef: 'test:model',
      provider: 'test',
      modelName: 'model',
      providerConfig: undefined,
      soulPath: '/tmp/agents/test-agent/soul.md',
      soul: '',
      workspace: undefined,
    },
    resolvedEnvVars: [],
    snapshotStore: {} as never,
  }
}

/**
 * 构造测试用 Command 对象。
 *
 * @param taskId - 任务 ID
 * @param goal - 任务目标描述
 */
export function createCommand(taskId: ReturnType<typeof createTaskId>, goal: string): Command {
  return {
    commandId: `cmd-${taskId}` as never,
    nodeId: createNodeId('node-test'),
    type: 'task.run',
    state: 'pending',
    createdAt: Date.now(),
    payload: { taskId, agentId: 'test-agent', goal },
  }
}

/** 构造 MessageDelta 事件。 */
export function messageDeltaEvent(): DomainEvent {
  return {
    type: 'MessageDelta',
    runId: RUN_ID,
    messageId: 'msg-001',
    sequence: 1,
    channel: 'text',
    payload: { content: 'hello' },
    timestamp: Date.now(),
  }
}

/** 构造 RunCompleted 事件。 */
export function runCompletedEvent(): DomainEvent {
  return {
    type: 'RunCompleted',
    runId: RUN_ID,
    sessionId: SESSION_ID,
    triggerType: 'new',
    timestamp: Date.now(),
  }
}

/** 构造 ToolStarted 事件。 */
export function toolStartedEvent(): DomainEvent {
  return {
    type: 'ToolStarted',
    runId: RUN_ID,
    toolCallId: 'tc-001',
    invocation: { toolCallId: 'tc-001', toolName: 'readFile', args: { path: '/tmp/x' } },
    timestamp: Date.now(),
  }
}

/** 构造 ToolCompleted 事件。 */
export function toolCompletedEvent(): DomainEvent {
  return {
    type: 'ToolCompleted',
    runId: RUN_ID,
    toolCallId: 'tc-001',
    invocation: { toolCallId: 'tc-001', toolName: 'readFile', args: { path: '/tmp/x' } },
    result: { toolCallId: 'tc-001', result: 'file contents' },
    timestamp: Date.now(),
  }
}
