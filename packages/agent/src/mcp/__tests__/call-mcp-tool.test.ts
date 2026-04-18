/**
 * call_mcp 工具单元测试。
 *
 * 这里先把协议边界钉死:
 * - discover / invoke 的 target 语义必须分开
 * - arguments 必须是结构化对象
 * - 节点工具能力、node mcpTargets、graph-run 上限和只读白名单都必须参与校验
 */
import type { RuntimeToolExecutionContext } from '@tianji/runtime'
import { createRunId, createSessionId } from '@tianji/shared'
import type {
  CallMcpDiscoverResult,
  CallMcpInvokeResult,
  McpServerSummary,
  ResolvedNodeCapabilities,
} from '@tianji/shared'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type CallMcpToolOptions, createCallMcpTool } from '../../mcp/call-mcp-tool.js'

const baseContext: RuntimeToolExecutionContext = {
  sessionId: createSessionId('sess_call_mcp_test'),
  runId: createRunId('run_call_mcp_test'),
  toolCallId: 'call_call_mcp_test',
}

const githubServers: readonly McpServerSummary[] = [
  {
    target: 'github',
    name: 'GitHub',
    description: 'GitHub MCP server',
    tools: [
      {
        name: 'list_pull_requests',
        qualifiedName: 'github.list_pull_requests',
        requiredParameters: [],
        optionalParameterCount: 0,
      },
      {
        name: 'create_issue',
        qualifiedName: 'github.create_issue',
        requiredParameters: ['title'],
        optionalParameterCount: 0,
      },
    ],
  },
]

function createHarness(
  overrides: Partial<CallMcpToolOptions> & {
    readonly nodeCapabilities?: Partial<ResolvedNodeCapabilities>
    readonly readonlyInvokeTargets?: readonly string[]
    readonly includeCallMcpTool?: boolean
  } = {}
): {
  readonly tool: ReturnType<typeof createCallMcpTool>
  readonly discover: ReturnType<
    typeof vi.fn<CallMcpDiscoverResult, [string, { schema?: boolean; allParameters?: boolean }]>
  >
  readonly invoke: ReturnType<
    typeof vi.fn<CallMcpInvokeResult, [string, Record<string, unknown>, { timeoutMs?: number }]>
  >
} {
  const discover = vi.fn<
    CallMcpDiscoverResult,
    [string, { schema?: boolean; allParameters?: boolean }]
  >(async (target) => ({
    target,
    server: target,
    tools: [],
  }))
  const invoke = vi.fn<
    CallMcpInvokeResult,
    [string, Record<string, unknown>, { timeoutMs?: number }]
  >(async (target) => ({
    target,
    server:
      githubServers.find((server) => server.tools.some((tool) => tool.qualifiedName === target))
        ?.target ?? target,
    tool: target,
    content: { ok: true },
    isError: false,
  }))

  const tool = createCallMcpTool({
    listServers: () => githubServers,
    discoverMcp: overrides.discoverMcp ?? discover,
    invokeMcp: overrides.invokeMcp ?? invoke,
    getCapabilities: () => ({
      nodeCapabilities: {
        tools: [
          ...(overrides.includeCallMcpTool === false ? [] : ['call_mcp']),
          ...(overrides.nodeCapabilities?.tools ?? []),
        ],
        mcpTargets: overrides.nodeCapabilities?.mcpTargets ?? ['github'],
        skills: overrides.nodeCapabilities?.skills ?? [],
      },
      graphRunUpperBound: {
        skills: [],
        tools: ['call_mcp'],
        mcpTargets: ['github', 'github.list_pull_requests', 'github.create_issue'],
      },
      readonlyInvokeTargets: overrides.readonlyInvokeTargets ?? ['github.list_pull_requests'],
      targetPolicies: overrides.targetPolicies,
    }),
  })

  return { tool, discover, invoke }
}

describe('createCallMcpTool', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rejects discover when target is a server.tool string', async () => {
    const { tool, discover } = createHarness()

    await expect(
      tool.execute({ action: 'discover', target: 'github.list_pull_requests' }, baseContext)
    ).rejects.toThrow(/discover.*server/i)
    expect(discover).not.toHaveBeenCalled()
  })

  it('rejects invoke when target is only a server', async () => {
    const { tool, invoke } = createHarness()

    await expect(
      tool.execute({ action: 'invoke', target: 'github', arguments: {} }, baseContext)
    ).rejects.toThrow(/invoke.*server\.tool/i)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('rejects invoke when arguments is not a structured object', async () => {
    const { tool, invoke } = createHarness()

    for (const argumentsValue of ['key=value', new Date(), new Map(), new Set()]) {
      await expect(
        tool.execute(
          {
            action: 'invoke',
            target: 'github.list_pull_requests',
            arguments: argumentsValue as never,
          },
          baseContext
        )
      ).rejects.toThrow(/structured object/i)
    }
    expect(invoke).not.toHaveBeenCalled()
  })

  it('rejects CLI-style target strings without trying to parse them', async () => {
    const { tool, invoke } = createHarness()

    for (const target of ['key=value', 'foo:bar', 'github.list_pull_requests(...)']) {
      await expect(
        tool.execute({ action: 'invoke', target, arguments: {} }, baseContext)
      ).rejects.toThrow()
    }
    expect(invoke).not.toHaveBeenCalled()
  })

  it('rejects when node does not expose call_mcp', async () => {
    const { tool } = createHarness({
      includeCallMcpTool: false,
      nodeCapabilities: {
        tools: [],
        mcpTargets: ['github'],
        skills: [],
      },
    })

    await expect(
      tool.execute({ action: 'discover', target: 'github' }, baseContext)
    ).rejects.toThrow(/call_mcp/i)
  })

  it('rejects when node mcpTargets are not authorized', async () => {
    const { tool } = createHarness({
      nodeCapabilities: {
        mcpTargets: [],
        tools: ['call_mcp'],
        skills: [],
      },
    })

    await expect(
      tool.execute({ action: 'discover', target: 'github' }, baseContext)
    ).rejects.toThrow(/mcpTargets/i)
  })

  it('allows a read-only whitelist target to invoke', async () => {
    const { tool, invoke } = createHarness({
      readonlyInvokeTargets: ['github.list_pull_requests'],
    })

    await expect(
      tool.execute(
        {
          action: 'invoke',
          target: 'github.list_pull_requests',
          arguments: { state: 'open' },
        },
        baseContext
      )
    ).resolves.toMatchObject({
      target: 'github.list_pull_requests',
      server: 'github',
      tool: 'github.list_pull_requests',
      isError: false,
    })
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('rejects a non-whitelist write target directly', async () => {
    const { tool, invoke } = createHarness({
      readonlyInvokeTargets: ['github.list_pull_requests'],
      targetPolicies: {
        'github.create_issue': {
          sideEffect: 'destructive',
        },
      },
    })

    await expect(
      tool.execute(
        {
          action: 'invoke',
          target: 'github.create_issue',
          arguments: { title: 'bug' },
        },
        baseContext
      )
    ).rejects.toThrow(/read-only|destructive|blocked/i)
    expect(invoke).not.toHaveBeenCalled()
  })
})
