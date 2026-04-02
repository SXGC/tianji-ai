# Daemon Subcommand E2E Test Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `@tianji/cli` 的 daemon 子命令模式补齐真实集成链路测试，覆盖 daemon start/status/stop/restart/chat 的关键联动场景，并修复测试基础设施缺口。

**Architecture:** 保持现有分层：CLI 参数解析和分支调度继续由 `main-daemon.test.ts` 覆盖，新的 `daemon-e2e.test.ts` 只验证 `DaemonServer`、`DaemonClient`、临时路径文件和 `runCli` 命令处理之间的集成行为。对 `--fg` 与 restart 的可测试性，只做最小依赖注入改造，避免为测试重构整套 daemon 启动路径。

**Tech Stack:** TypeScript, Vitest, Node.js fs/promises, `@tianji/agent` daemon client/server, `pnpm`, existing CLI test helpers

---

### 文件结构

**Create:**
- `apps/cli/src/__tests__/daemon-e2e.test.ts`: daemon 子命令模式的集成测试，包含真实 `DaemonServer`/`DaemonClient` 联动、CLI stop/status/chat 入口覆盖、restart 前台模式覆盖。

**Modify:**
- `apps/cli/src/__tests__/helpers/cli-test-utils.ts`: 补充 `createTempCliPaths()` 返回的 `daemonPortPath`、`daemonPidPath`，并在必要时复用 stdout 捕获辅助函数。
- `apps/cli/src/main.ts`: 为 `daemon restart --fg` 补齐参数解析；将 `runDaemonEntry()` 的关键依赖通过 `RunCommandDependencies` 暴露最小注入点，确保 e2e 可在不 fork 的情况下验证 restart/start 前台行为。
- `apps/cli/README.md`: 如果 README 已描述旧 daemon 用法或测试命令，更新为子命令模式和新增 e2e 测试说明；若没有相关内容，仅确认无需修改。

**Verify Existing Coverage Before Editing:**
- `apps/cli/src/__tests__/main-daemon.test.ts`: 保持为解析与基础 CLI 错误分支测试，不把真实 server/client 联动塞回该文件。
- `apps/cli/src/daemon-entry.ts`: 读取现有 daemon 启动签名，确保计划中的依赖注入名称和参数与实际实现一致。
- `apps/cli/src/__tests__/daemon-server.test.ts`
- `apps/cli/src/__tests__/daemon-client.test.ts`

### Task 1: 修复测试基础设施路径缺口

**Files:**
- Modify: `apps/cli/src/__tests__/helpers/cli-test-utils.ts`
- Test: `apps/cli/src/__tests__/main-daemon.test.ts`

- [ ] **Step 1: 写失败测试，锁定 createTempCliPaths 的 daemon 路径契约**

```ts
it('creates daemon pid and port paths for daemon CLI tests', async () => {
  const { paths, cleanup } = await createTempCliPaths()

  try {
    expect(paths.daemonPortPath).toContain('daemon.port')
    expect(paths.daemonPidPath).toContain('daemon.pid')
  } finally {
    await cleanup()
  }
})
```

- [ ] **Step 2: 运行单测，确认当前实现失败**

Run: `pnpm --filter @tianji/cli test -- apps/cli/src/__tests__/main-daemon.test.ts`
Expected: FAIL，提示 `daemonPortPath` 或 `daemonPidPath` 缺失/类型不满足 `UserConfigPaths`

- [ ] **Step 3: 在 createTempCliPaths 中补齐 daemon 路径字段**

```ts
const paths: UserConfigPaths = {
  configDir,
  agentsDir: join(configDir, 'agents'),
  logsDir: join(configDir, 'logs'),
  configFilePath: join(configDir, 'tianji.json'),
  cliLogFilePath: join(configDir, 'logs', 'tianji.log'),
  daemonPortPath: join(configDir, 'daemon.port'),
  daemonPidPath: join(configDir, 'daemon.pid'),
}
```

- [ ] **Step 4: 重跑单测，确认基础设施契约成立**

Run: `pnpm --filter @tianji/cli test -- apps/cli/src/__tests__/main-daemon.test.ts`
Expected: PASS

- [ ] **Step 5: 提交该最小修复**

```bash
git add apps/cli/src/__tests__/helpers/cli-test-utils.ts apps/cli/src/__tests__/main-daemon.test.ts
git commit -m "test(cli): add daemon temp path fixtures"
```

### Task 2: 补齐 daemon restart/start 前台模式的可测试性

**Files:**
- Modify: `apps/cli/src/main.ts`
- Verify: `apps/cli/src/daemon-entry.ts`
- Test: `apps/cli/src/__tests__/main-daemon.test.ts`

- [ ] **Step 1: 先为 restart --fg 和前台依赖注入写失败测试**

```ts
it('parses daemon restart --fg command', () => {
  expect(parseCliArgs(['daemon', 'restart', '--fg'])).toEqual({
    kind: 'daemon',
    subcommand: 'restart',
    foreground: true,
  })
})

it('runs daemon restart in foreground through injected daemon entry', async () => {
  const runDaemonEntry = vi.fn(async () => undefined)

  const exitCode = await runCli(['daemon', 'restart', '--fg'], {
    getUserConfigPaths: () => fakePaths,
    runDaemonEntry,
  })

  expect(exitCode).toBe(0)
  expect(runDaemonEntry).toHaveBeenCalledOnce()
})
```

- [ ] **Step 2: 运行 daemon CLI 测试，确认新场景当前失败**

Run: `pnpm --filter @tianji/cli test -- apps/cli/src/__tests__/main-daemon.test.ts`
Expected: FAIL，原因是 `restart` 当前不接受 `--fg`，且 `RunCommandDependencies` 没有 `runDaemonEntry` 注入点

- [ ] **Step 3: 对 main.ts 做最小改造，只开放前台启动需要的依赖**

```ts
export interface RunCommandDependencies {
  readonly loadContext?: () => Promise<LoadedAgentContext>
  readonly createSession?: (context: LoadedAgentContext) => AgentSession
  readonly getUserConfigPaths?: () => UserConfigPaths
  readonly followCliLog?: (logFilePath: string, options?: FollowCliLogOptions) => Promise<void>
  readonly writeStdout?: (message: string) => void
  readonly runDaemonEntry?: () => Promise<void>
}

function parseDaemonCommandArgs(args: readonly string[]): DaemonCommand {
  // start 与 restart 都允许 --fg
}

async function handleDaemonStartCommand(command: DaemonCommand, deps?: RunCommandDependencies) {
  const runDaemonEntryCommand = deps?.runDaemonEntry ?? runDaemonEntry
  if (command.foreground) {
    await runDaemonEntryCommand()
    return 0
  }
}

async function handleDaemonRestartCommand(command: DaemonCommand, deps?: RunCommandDependencies) {
  const runDaemonEntryCommand = deps?.runDaemonEntry ?? runDaemonEntry
  if (command.foreground) {
    await runDaemonEntryCommand()
    return 0
  }
}
```

- [ ] **Step 4: 重跑 daemon CLI 测试，确认解析与前台入口都通过**

Run: `pnpm --filter @tianji/cli test -- apps/cli/src/__tests__/main-daemon.test.ts`
Expected: PASS

- [ ] **Step 5: 提交前台模式可测试性改造**

```bash
git add apps/cli/src/main.ts apps/cli/src/__tests__/main-daemon.test.ts
git commit -m "test(cli): make daemon foreground entry injectable"
```

### Task 3: 搭建 daemon e2e 测试骨架与辅助工具

**Files:**
- Create: `apps/cli/src/__tests__/daemon-e2e.test.ts`
- Verify: `apps/cli/src/__tests__/daemon-server.test.ts`
- Verify: `apps/cli/src/__tests__/daemon-client.test.ts`
- Verify: `apps/cli/src/__tests__/helpers/cli-test-utils.ts`

- [ ] **Step 1: 创建测试文件，先写最小 failing smoke test 和辅助工具签名**

```ts
describe('daemon e2e', () => {
  it('boots a live daemon and responds to ping', async () => {
    const live = await setupLiveDaemon(createStubSession(['hello']))

    try {
      const ping = await live.client.ping()
      expect(ping.pid).toBeGreaterThan(0)
    } finally {
      await live.cleanup()
    }
  }, 15_000)
})

async function setupLiveDaemon(session: AgentSession, paths?: UserConfigPaths) {
  // 先声明签名，后续步骤补实现
}
```

- [ ] **Step 2: 运行新测试文件，确认骨架测试失败**

Run: `pnpm --filter @tianji/cli test -- apps/cli/src/__tests__/daemon-e2e.test.ts`
Expected: FAIL，`setupLiveDaemon` 未实现或返回值不完整

- [ ] **Step 3: 实现统一辅助工具，避免后续测试重复拼装 server/client/path**

```ts
interface LiveDaemonHandle {
  readonly client: DaemonClient
  readonly paths: UserConfigPaths
  readonly cleanup: () => Promise<void>
}

async function setupLiveDaemon(
  session: AgentSession,
  providedPaths?: UserConfigPaths
): Promise<LiveDaemonHandle> {
  const temp = providedPaths === undefined ? await createTempCliPaths() : undefined
  const paths = providedPaths ?? temp!.paths
  const server = new DaemonServer({ host: '127.0.0.1', port: 0, session, paths })
  await server.listen()
  const port = await readPortFromFile(paths.daemonPortPath)
  const client = new DaemonClient({ host: '127.0.0.1', port })

  return {
    client,
    paths,
    cleanup: async () => {
      await server.shutdown()
      await temp?.cleanup()
    },
  }
}

function createStubSession(chunks: readonly string[]): AgentSession {
  // 复用已有 runtime event 形状，固定 sessionId，按顺序输出 message.delta -> run.completed
}

async function runCommand(argv: readonly string[], deps: RunCommandDependencies) {
  let exitCode = 0
  const stdout = await captureStdout(async () => {
    exitCode = await runCli(argv, deps)
  })
  return { exitCode, stdout }
}
```

- [ ] **Step 4: 重跑骨架测试，确认基础联动可用**

Run: `pnpm --filter @tianji/cli test -- apps/cli/src/__tests__/daemon-e2e.test.ts`
Expected: PASS 至少 1 个 smoke test

- [ ] **Step 5: 提交 e2e 测试骨架**

```bash
git add apps/cli/src/__tests__/daemon-e2e.test.ts
git commit -m "test(cli): scaffold daemon e2e coverage"
```

### Task 4: 实现 daemon start/status/stop 的 P0 集成场景

**Files:**
- Modify: `apps/cli/src/__tests__/daemon-e2e.test.ts`
- Verify: `apps/cli/src/main.ts`

- [ ] **Step 1: 先写 start/status/stop 失败测试**

```ts
describe('daemon start/status/stop', () => {
  it('completes foreground daemon lifecycle', async () => {
    const live = await setupLiveDaemon(createStubSession(['hello from daemon']))

    try {
      const ping = await live.client.ping()
      expect(ping.sessionId).toBeTruthy()

      const events: RuntimeEvent[] = []
      for await (const event of live.client.sendChat('hello')) {
        events.push(event)
      }

      expect(events.some((event) => event.type === 'message.delta')).toBe(true)
    } finally {
      await live.cleanup()
    }
  }, 15_000)

  it('prints daemon running info for daemon status', async () => {
    const live = await setupLiveDaemon(createStubSession(['status ok']))
    try {
      const result = await runCommand(['daemon', 'status'], {
        getUserConfigPaths: () => live.paths,
      })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('Daemon running')
      expect(result.stdout).toContain('sessionId=')
    } finally {
      await live.cleanup()
    }
  }, 15_000)

  it('stops a running daemon through daemon stop', async () => {
    const live = await setupLiveDaemon(createStubSession(['bye']))

    const result = await runCommand(['daemon', 'stop'], {
      getUserConfigPaths: () => live.paths,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Daemon stopped')
  }, 15_000)
})
```

- [ ] **Step 2: 跑新测试组，确认失败点只在缺失实现或断言差异，不是辅助工具损坏**

Run: `pnpm --filter @tianji/cli test -- apps/cli/src/__tests__/daemon-e2e.test.ts`
Expected: 若有失败，应集中在 stdout 断言、server cleanup 时序或 pid/port 文件清理验证

- [ ] **Step 3: 补充最小实现与断言稳定器**

```ts
async function expectDaemonFilesRemoved(paths: UserConfigPaths): Promise<void> {
  await expect(access(paths.daemonPortPath)).rejects.toThrow()
  await expect(access(paths.daemonPidPath)).rejects.toThrow()
}

it('stops a running daemon through daemon stop', async () => {
  const live = await setupLiveDaemon(createStubSession(['bye']))
  try {
    const result = await runCommand(['daemon', 'stop'], {
      getUserConfigPaths: () => live.paths,
    })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('Daemon stopped')
    await expectDaemonFilesRemoved(live.paths)
  } finally {
    await live.cleanup()
  }
})
```

- [ ] **Step 4: 重跑该测试文件，确认 P0 lifecycle 场景通过**

Run: `pnpm --filter @tianji/cli test -- apps/cli/src/__tests__/daemon-e2e.test.ts`
Expected: PASS

- [ ] **Step 5: 提交 daemon 基础生命周期集成测试**

```bash
git add apps/cli/src/__tests__/daemon-e2e.test.ts
git commit -m "test(cli): cover daemon lifecycle integration"
```

### Task 5: 实现 restart 与 stale 文件场景

**Files:**
- Modify: `apps/cli/src/__tests__/daemon-e2e.test.ts`
- Verify: `apps/cli/src/main.ts`

- [ ] **Step 1: 先写 restart/stale 失败测试**

```ts
describe('daemon restart', () => {
  it('restarts a running daemon in foreground mode', async () => {
    const first = await setupLiveDaemon(createStubSession(['first']))
    const replacement = vi.fn(async () => {
      await setupLiveDaemon(createStubSession(['second']), first.paths)
    })

    const result = await runCommand(['daemon', 'restart', '--fg'], {
      getUserConfigPaths: () => first.paths,
      runDaemonEntry: replacement,
    })

    expect(result.exitCode).toBe(0)
    expect(replacement).toHaveBeenCalledOnce()
  }, 15_000)

  it('cleans stale daemon files before foreground start', async () => {
    const { paths, cleanup } = await createTempCliPaths()
    try {
      await writeFile(paths.daemonPortPath, '9999', 'utf8')
      await writeFile(paths.daemonPidPath, '123456', 'utf8')

      const result = await runCommand(['daemon', 'daemon', 'start', '--fg'], {
        getUserConfigPaths: () => paths,
        runDaemonEntry: vi.fn(async () => undefined),
      })

      expect(result.exitCode).toBe(0)
    } finally {
      await cleanup()
    }
  }, 15_000)
})
```

- [ ] **Step 2: 运行 restart/stale 组，确认测试真实暴露当前行为缺口**

Run: `pnpm --filter @tianji/cli test -- apps/cli/src/__tests__/daemon-e2e.test.ts`
Expected: FAIL，可能出现在命令参数拼写、stdout 文案或 stale 文件未被清理后的启动路径

- [ ] **Step 3: 修正测试并补足最小实现差异**

```ts
it('cleans stale daemon files before foreground start', async () => {
  const { paths, cleanup } = await createTempCliPaths()
  try {
    await writeFile(paths.daemonPortPath, '9999', 'utf8')
    await writeFile(paths.daemonPidPath, '123456', 'utf8')

    const runDaemonEntry = vi.fn(async () => {
      expect(await pathExists(paths.daemonPortPath)).toBe(false)
      expect(await pathExists(paths.daemonPidPath)).toBe(false)
    })

    const result = await runCommand(['daemon', 'start', '--fg'], {
      getUserConfigPaths: () => paths,
      runDaemonEntry,
    })

    expect(result.exitCode).toBe(0)
    expect(runDaemonEntry).toHaveBeenCalledOnce()
  } finally {
    await cleanup()
  }
})
```

- [ ] **Step 4: 重跑 e2e 文件，确认 restart 与 stale 清理场景通过**

Run: `pnpm --filter @tianji/cli test -- apps/cli/src/__tests__/daemon-e2e.test.ts`
Expected: PASS

- [ ] **Step 5: 提交 restart 集成覆盖**

```bash
git add apps/cli/src/__tests__/daemon-e2e.test.ts apps/cli/src/main.ts
git commit -m "test(cli): cover daemon restart integration"
```

### Task 6: 实现 chat 与完整旅程场景

**Files:**
- Modify: `apps/cli/src/__tests__/daemon-e2e.test.ts`
- Verify: `apps/cli/src/main.ts`

- [ ] **Step 1: 为 chat 错误分支、单轮、多轮和完整旅程写失败测试**

```ts
describe('chat and end-to-end flow', () => {
  it('returns non-zero when chat runs without daemon', async () => {
    const { paths, cleanup } = await createTempCliPaths()
    try {
      const exitCode = await runCli(['chat'], {
        getUserConfigPaths: () => paths,
      })
      expect(exitCode).toBe(1)
    } finally {
      await cleanup()
    }
  })

  it('streams one chat turn through the live daemon client', async () => {
    const live = await setupLiveDaemon(createStubSession(['hello', ' world']))
    try {
      const events = await collectEvents(live.client.sendChat('hello'))
      expect(events.filter((event) => event.type === 'message.delta')).toHaveLength(2)
    } finally {
      await live.cleanup()
    }
  }, 15_000)

  it('preserves the same daemon session across multiple chat turns', async () => {
    const prompts: string[] = []
    const live = await setupLiveDaemon(createRecordingSession(prompts))
    try {
      await collectEvents(live.client.sendChat('first'))
      await collectEvents(live.client.sendChat('second'))
      expect(prompts).toEqual(['first', 'second'])
    } finally {
      await live.cleanup()
    }
  }, 15_000)

  it('completes start -> status -> chat -> stop -> status failed journey', async () => {
    const live = await setupLiveDaemon(createStubSession(['journey ok']))
    try {
      const status1 = await runCommand(['daemon', 'status'], {
        getUserConfigPaths: () => live.paths,
      })
      expect(status1.exitCode).toBe(0)

      const events = await collectEvents(live.client.sendChat('hello'))
      expect(events.some((event) => event.type === 'run.completed')).toBe(true)

      const stop = await runCommand(['daemon', 'stop'], {
        getUserConfigPaths: () => live.paths,
      })
      expect(stop.exitCode).toBe(0)

      const status2 = await runCli(['daemon', 'status'], {
        getUserConfigPaths: () => live.paths,
      })
      expect(status2).toBe(1)
    } finally {
      await live.cleanup()
    }
  }, 15_000)
})
```

- [ ] **Step 2: 运行 e2e 文件，确认 chat 与旅程场景的失败原因明确**

Run: `pnpm --filter @tianji/cli test -- apps/cli/src/__tests__/daemon-e2e.test.ts`
Expected: FAIL 集中在 chat 输出收集、session 记录或 status after stop 时序问题

- [ ] **Step 3: 补充辅助函数与必要断言，消除时序抖动**

```ts
async function collectEvents(stream: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = []
  for await (const event of stream) {
    events.push(event)
  }
  return events
}

function createRecordingSession(prompts: string[]): AgentSession {
  return {
    sessionId: 'recording-session' as AgentSession['sessionId'],
    async *chat(prompt: string) {
      prompts.push(prompt)
      yield createTextDeltaEvent(prompt)
      yield createCompletedEvent()
    },
  }
}
```

- [ ] **Step 4: 重跑整个 e2e 文件，确认 chat 与完整旅程通过**

Run: `pnpm --filter @tianji/cli test -- apps/cli/src/__tests__/daemon-e2e.test.ts`
Expected: PASS

- [ ] **Step 5: 提交 chat 和完整旅程测试**

```bash
git add apps/cli/src/__tests__/daemon-e2e.test.ts
git commit -m "test(cli): cover daemon chat end-to-end flow"
```

### Task 7: 文档检查、回归验证与最终质量门

**Files:**
- Modify if needed: `apps/cli/README.md`
- Verify: `apps/cli/src/main.ts`
- Verify: `apps/cli/src/__tests__/main-daemon.test.ts`
- Verify: `apps/cli/src/__tests__/daemon-e2e.test.ts`

- [ ] **Step 1: 检查 README 是否描述旧 daemon 命令；如有则先写文档变更**

```md
## Daemon Commands

- `tianji daemon start [--fg]`
- `tianji daemon status`
- `tianji daemon stop`
- `tianji daemon restart [--fg]`
```

- [ ] **Step 2: 运行 CLI 包测试回归，确保单测和 e2e 全通过**

Run: `pnpm --filter @tianji/cli test`
Expected: PASS，包含 `main-daemon.test.ts` 与 `daemon-e2e.test.ts`

- [ ] **Step 3: 运行仓库强制校验命令并修复所有输出**

Run: `pnpm check`
Expected: PASS，无 error、warning、info 遗留

- [ ] **Step 4: 自查计划目标与 spec 一致性**

Checklist:
- `createTempCliPaths()` 已补 `daemonPortPath`/`daemonPidPath`
- `daemon start/status/stop/restart/chat` 关键 P0 场景均有自动化覆盖
- `restart --fg` 已有解析与执行测试
- stale 文件清理和完整旅程已覆盖
- README 若受影响已更新

- [ ] **Step 5: 提交最终整合结果**

```bash
git add apps/cli/src/main.ts apps/cli/src/__tests__/helpers/cli-test-utils.ts apps/cli/src/__tests__/main-daemon.test.ts apps/cli/src/__tests__/daemon-e2e.test.ts apps/cli/README.md
git commit -m "test(cli): add daemon subcommand integration coverage"
```

### Spec 覆盖自检

- 变更范围：Task 2 负责 `restart --fg` 和前台入口可测性，Task 4-6 覆盖新子命令模式的集成链路。
- 基础设施修复：Task 1 单独锁定 `createTempCliPaths()` 缺口。
- A/B/C/D/E/F 测试组：Task 4 对应 A1/B1/C1，Task 5 对应 A3/D1/D2/D3/D4，Task 6 对应 E1/E2/E3/F1，并保留 F2 可作为同组补充断言实现。
- 依赖注入策略：Task 2 明确采用“最小注入 + 前台模式”，Task 3-6 以真实 `DaemonServer`/`DaemonClient` 为主，不重新覆盖 CLI 参数解析层。
- 注意事项：每个真实通信测试都要求 15s timeout，随机端口由 live daemon helper 统一处理，清理在 `cleanup()` 中闭环。

### 计划修正说明

- spec 中 `runCommand(['daemon', 'daemon', 'start', '--fg'])` 明显是笔误，计划已修正为 `runCommand(['daemon', 'start', '--fg'])`。
- spec 推荐“策略 2：直接使用 DaemonServer + DaemonClient”，但 `restart --fg` 和 `stop/status/chat` 的 CLI 行为仍需要少量 `runCli` 覆盖，因此计划采用“集成层直连 server/client + CLI 入口最小验证”的混合方案。
- `F2 restart 后新 daemon 可用` 没有单独拆 task，建议在 Task 5 的 restart 测试中追加 sessionId 变化断言，避免重复建环境。
