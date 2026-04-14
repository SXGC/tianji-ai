# 默认编排图提取为包内静态配置 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **本项目提交约定：** 每次 `git commit` 前必须加载 `git commit` skill 生成消息；严禁 `Co-Authored-By`、`--no-verify`、`git add -A/.`。

**Goal:** 把 `packages/agent/src/context.ts` 里硬编码的默认编排图抽到随包发布的 `packages/agent/config/default-orchestration.json`，由 `graph-loader.ts` 以"用户文件优先、ENOENT 才 fallback 到包内"的方式加载，彻底删除首次启动时写入用户目录的逻辑。

**Architecture:** 新增 `packages/agent/config/default-orchestration.json` 随包发布；`loadDefaultOrchestrationGraph` 先读 `<configDir>/default-orchestration.json`，捕获 ENOENT 后 fallback 读包内 bundled 路径（用 `import.meta.url` 解析）；任何其它 IO 错误或 JSON 解析错误直接抛，不做降级。`ensureDefaultUserConfig` 不再写 orchestration 文件。

**Tech Stack:** TypeScript ESM、Node.js `node:fs/promises` / `node:url` / `node:path`、Vitest、pnpm workspace。

---

## File Structure

### 新增

| 文件 | 职责 |
|---|---|
| `packages/agent/config/default-orchestration.json` | 随 `@tianji/agent` 发布的默认编排图静态数据。被 `graph-loader.ts` 以 fallback 读取 |

### 修改

| 文件 | 改动要点 |
|---|---|
| `packages/agent/package.json` | `files` 数组加入 `"config"`，保证 npm publish 打包 |
| `packages/agent/src/orchestration/graph-loader.ts` | 引入 bundled 路径常量；把 `readFile` 调用换成"用户优先 → ENOENT fallback 到 bundled"的两步函数 |
| `packages/agent/src/context.ts` | 删除 `DEFAULT_ORCHESTRATION_GRAPH` 常量（33-56 行）；删除 `ensureDefaultUserConfig` 内写 orchestration 文件的分支（145-160 行）。其它（configDir、SOUL.md、tianji.json 写入）保持原样 |
| `packages/agent/src/orchestration/__tests__/graph-loader.test.ts` | 把原 "不存在时报错" 用例改成 "不存在时 fallback 到 bundled"；新增 "malformed JSON 不 fallback" 用例 |
| `packages/agent/src/__tests__/context.test.ts` | 删除 `expect(fs.writeFile).toHaveBeenCalledWith(... 'default-orchestration.json' ...)` 相关断言；删除 `writes default orchestration with input/output mapping` 整个用例 |

---

## Task 1：添加包内 bundled JSON 并纳入发布清单

**Files:**
- Create: `packages/agent/config/default-orchestration.json`
- Modify: `packages/agent/package.json` 第 17 行

- [ ] **Step 1：创建 `packages/agent/config/default-orchestration.json`**

写入以下内容（末尾带一个换行符）：

```json
{
  "id": "default",
  "name": "default",
  "version": 1,
  "source": "static",
  "locked": false,
  "state": {
    "input": { "type": "string" },
    "output": { "type": "string" }
  },
  "nodes": [
    {
      "id": "agent",
      "type": "agent",
      "agent": "default",
      "input": ["input"],
      "output": ["output"]
    }
  ],
  "edges": [
    { "from": "__start__", "to": "agent" },
    { "from": "agent", "to": "__end__" }
  ]
}
```

- [ ] **Step 2：修改 `packages/agent/package.json` 的 `files` 字段**

把第 17 行：

```json
  "files": ["dist", "src"],
```

改成：

```json
  "files": ["dist", "src", "config"],
```

- [ ] **Step 3：验证 pack 产物确实包含 config**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/agent && pnpm pack --dry-run 2>&1 | grep 'config/default-orchestration.json'`

Expected: 输出包含一行 `npm notice ... config/default-orchestration.json`。

- [ ] **Step 4：提交（使用 `git commit` skill 生成消息）**

加载 `git commit` skill，范围：`packages/agent/config/default-orchestration.json`、`packages/agent/package.json`。

暂存：

```bash
git add packages/agent/config/default-orchestration.json packages/agent/package.json
```

---

## Task 2：graph-loader 支持 bundled fallback（TDD）

**Files:**
- Modify: `packages/agent/src/orchestration/__tests__/graph-loader.test.ts:67-74`（改已有用例）、尾部新增 1 个用例
- Modify: `packages/agent/src/orchestration/graph-loader.ts:1-5` 顶部导入、新增常量、新增 `readUserOrBundled`、改 `loadDefaultOrchestrationGraph` 的 try/catch

- [ ] **Step 1：改测试——把 "不存在时报错" 替换为 "不存在时 fallback 到 bundled"**

替换 `packages/agent/src/orchestration/__tests__/graph-loader.test.ts:67-74` 这段：

```ts
  it('default-orchestration.json 不存在时报错', async () => {
    await expect(
      loadDefaultOrchestrationGraph({
        configDir: tempDir,
        agentConfigs: {},
      })
    ).rejects.toThrow(/default-orchestration\.json/)
  })
```

成：

```ts
  it('用户 configDir 无 default-orchestration.json 时 fallback 到包内 bundled 图', async () => {
    // 注意 tempDir 下没有 default-orchestration.json，但必须提前写好 default agent 的 SOUL.md，
    // 因为 bundled 图里 node.agent === "default"，graph-loader 会走 expandAgentNode 读 SOUL。
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
```

- [ ] **Step 2：同文件尾部 `})` 之前新增 "malformed JSON 不 fallback" 用例**

在 `describe` 块内最后一个 `it` 之后追加：

```ts
  it('用户 default-orchestration.json 格式损坏时直接抛，不 fallback', async () => {
    await writeFile(
      join(tempDir, 'default-orchestration.json'),
      '{ this is not valid json',
      'utf8'
    )

    await expect(
      loadDefaultOrchestrationGraph({
        configDir: tempDir,
        agentConfigs: { default: { model: 'openai/gpt-4' } },
      })
    ).rejects.toThrow(/JSON/i)
  })
```

- [ ] **Step 3：运行测试确认失败**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/agent && pnpm test -- graph-loader`

Expected：
- `用户 configDir 无 default-orchestration.json 时 fallback 到包内 bundled 图` FAIL（现有实现抛 `Default orchestration graph file does not exist`）
- `用户 default-orchestration.json 格式损坏时直接抛，不 fallback` 可能已经 PASS（JSON.parse 本来就抛），不是红色就跳过

- [ ] **Step 4：改实现——`graph-loader.ts` 顶部导入补 `fileURLToPath`**

修改 `packages/agent/src/orchestration/graph-loader.ts` 第 1-2 行：

```ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
```

改为：

```ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
```

- [ ] **Step 5：在 imports 块后、`GraphLoaderOptions` 之前添加 bundled 路径常量**

在 `import { buildSystemPrompt } from './system-prompt-builder.js'` 下一行开始插入：

```ts
/**
 * 随 `@tianji/agent` 发布的包内默认编排图位置。
 *
 * 运行时从 `packages/agent/src/orchestration/graph-loader.ts` 出发，向上两级再进入 `config/`。
 * 发布后结构相同（`dist/orchestration/graph-loader.js` → `config/...`），只要 `package.json`
 * 的 `files` 字段包含 `config` 就能被 npm 打包带走。
 */
const BUNDLED_DEFAULT_ORCHESTRATION_PATH = fileURLToPath(
  new URL('../../config/default-orchestration.json', import.meta.url)
)
```

- [ ] **Step 6：改 `loadDefaultOrchestrationGraph` 里读文件的那段**

把 `packages/agent/src/orchestration/graph-loader.ts:52-59` 这段：

```ts
  const jsonPath = join(options.configDir, 'default-orchestration.json')

  let rawJson: string
  try {
    rawJson = await readFile(jsonPath, 'utf8')
  } catch {
    throw new Error(`Default orchestration graph file does not exist: ${jsonPath}`)
  }
```

替换为：

```ts
  const userJsonPath = join(options.configDir, 'default-orchestration.json')
  const rawJson = await readUserOrBundledOrchestration(userJsonPath)
```

然后在文件末尾（最后一个 `function` 之后、文件底部）追加：

```ts
/**
 * 读 user configDir 的 default-orchestration.json；当且仅当 ENOENT 时 fallback 读包内 bundled。
 *
 * 其它 IO 错误（权限、目录损坏等）必须暴露，不可静默降级。
 *
 * @param userPath - 用户目录下的 JSON 绝对路径
 * @returns 原始 JSON 文本
 */
async function readUserOrBundledOrchestration(userPath: string): Promise<string> {
  try {
    return await readFile(userPath, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      throw err
    }
  }
  return await readFile(BUNDLED_DEFAULT_ORCHESTRATION_PATH, 'utf8')
}
```

- [ ] **Step 7：运行测试确认通过**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/agent && pnpm test -- graph-loader`

Expected：所有 `loadDefaultOrchestrationGraph` 用例 PASS（新增 2 个 + 原有 4 个）。

- [ ] **Step 8：提交（使用 `git commit` skill 生成消息）**

暂存：

```bash
git add packages/agent/src/orchestration/graph-loader.ts packages/agent/src/orchestration/__tests__/graph-loader.test.ts
```

---

## Task 3：context.ts 删除硬编码默认图与首次写入逻辑（TDD）

**Files:**
- Modify: `packages/agent/src/__tests__/context.test.ts:175-179`（删断言）、`packages/agent/src/__tests__/context.test.ts:182-227`（整个用例删除）
- Modify: `packages/agent/src/context.ts:32-56`（删常量）、`packages/agent/src/context.ts:145-160`（删写入块）

- [ ] **Step 1：改测试——删掉"orchestration 写入"相关断言**

打开 `packages/agent/src/__tests__/context.test.ts`，删除第 175-179 行：

```ts
    expect(fs.writeFile).toHaveBeenCalledWith(
      '/tmp/tianji-ctx-test/default-orchestration.json',
      expect.stringContaining('"input"'),
      'utf8'
    )
```

这 5 行删掉，后面的 `})` 留着，`it('creates directories...')` 仍只断言 mkdir + config 文件 + SOUL 文件。

- [ ] **Step 2：改测试——整段删除 `writes default orchestration with input/output mapping` 用例**

删除 `packages/agent/src/__tests__/context.test.ts:182-227` 整个 `it('writes default orchestration with input/output mapping', async () => { ... })`（从 `  it('writes default orchestration` 一直到匹配的 `  })`）。

删除后，`describe('ensureDefaultUserConfig', ...)` 块应剩 3 个用例：
1. `creates directories and writes config when files do not exist`（仅 config/SOUL）
2. `skips writing files when they already exist`
3. `reads defaultAgent name from config`

- [ ] **Step 3：运行测试确认失败**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/agent && pnpm test -- context`

Expected：`creates directories and writes config when files do not exist` 仍 PASS（因为实现里还在写 orchestration 文件，writeFile 调用次数依然满足被断言的那些；但检查语义——实际上它只会"多调"一次，不会让剩下的断言失败）。这意味着 Step 4 的实现删除不会因为这一步测试回归。

> 注：这个 Task 的 TDD 顺序与常规相反——先调整测试符合新行为，再删实现。因为删代码不可能"新增失败用例"，只可能"减少某些被调用"。所以 Step 3 的作用是确保改完测试后仍 PASS（基线），Step 4 删代码后再跑一次验证"仍然 PASS"即可。

- [ ] **Step 4：改实现——删除 `DEFAULT_ORCHESTRATION_GRAPH` 常量**

删除 `packages/agent/src/context.ts:32-56` 的：

```ts
/** 单节点默认编排图：一个 agent 节点引用 defaultAgent，__start__ → agent → __end__ */
const DEFAULT_ORCHESTRATION_GRAPH = {
  id: 'default',
  name: 'default',
  version: 1,
  source: 'static',
  locked: false,
  state: {
    input: { type: 'string' },
    output: { type: 'string' },
  },
  nodes: [
    {
      id: 'agent',
      type: 'agent',
      agent: 'default',
      input: ['input'],
      output: ['output'],
    },
  ],
  edges: [
    { from: '__start__', to: 'agent' },
    { from: 'agent', to: '__end__' },
  ],
} as const
```

整段（含前面的注释行）都删掉。

- [ ] **Step 5：改实现——删除 `ensureDefaultUserConfig` 内写 orchestration 文件的分支**

删除 `packages/agent/src/context.ts:145-160` 的：

```ts
  const orchestrationPath = join(paths.configDir, 'default-orchestration.json')
  if (!(await pathExists(orchestrationPath))) {
    const graph = {
      ...DEFAULT_ORCHESTRATION_GRAPH,
      nodes: [
        {
          id: 'agent',
          type: 'agent',
          agent: defaultAgentName,
          input: ['input'],
          output: ['output'],
        },
      ],
    }
    await writeFile(orchestrationPath, `${JSON.stringify(graph, null, 2)}\n`, 'utf8')
  }
```

整段（含前面的空行）删掉。`ensureDefaultUserConfig` 函数最后应止于写完 SOUL.md 后的 `return paths`。

- [ ] **Step 6：运行测试确认通过**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/agent && pnpm test -- context`

Expected：`ensureDefaultUserConfig` 的 3 个用例全部 PASS。

- [ ] **Step 7：提交（使用 `git commit` skill 生成消息）**

暂存：

```bash
git add packages/agent/src/context.ts packages/agent/src/__tests__/context.test.ts
```

---

## Task 4：全仓 `pnpm check` 与集成回归

**Files:** 无代码改动；仅运行验证命令。

- [ ] **Step 1：跑全仓 `pnpm check`**

Run: `cd /workspaces/dev_docker/tianji-ai && pnpm check 2>&1 | tee /tmp/check.log`

Expected：退出码 0，无 error/warning。按 CLAUDE.md 规则所有错误/警告/信息都必须修复。

- [ ] **Step 2：跑 agent 包全量测试**

Run: `cd /workspaces/dev_docker/tianji-ai/packages/agent && pnpm test`

Expected：全部 PASS。重点关注是否有其它依赖 `DEFAULT_ORCHESTRATION_GRAPH` 或 orchestration 写入副作用的用例。若有失败，追溯失败栈，按"Let it crash"原则修复（例如测试自己造 fixture 而不是依赖首次启动副作用），不要回填被删代码。

- [ ] **Step 3：跑 apps/node 全量测试（验证 daemon 路径没回归）**

Run: `cd /workspaces/dev_docker/tianji-ai/apps/node && pnpm test`

Expected：全部 PASS。若 `daemon-e2e.test.ts` 或 `daemon-entry.test.ts` 失败，检查它们是否把 "需要 orchestration 文件存在" 当先决条件——如果是，测试本身会在 runtimeConfigDir 里主动写入 fixture（见 `apps/node/src/__tests__/daemon-e2e.test.ts:271`），不受本 Task 影响。

- [ ] **Step 4：手工回归——删除用户旧配置，确认 fallback 生效**

这一步是对真实 bug 的端到端验证：

```bash
mv ~/.config/tianji-ai/default-orchestration.json ~/.config/tianji-ai/default-orchestration.json.bak
```

然后复现原 bug 触发路径：通过 controlplane UI 或测试脚本发一条用户消息，确认：
- daemon 进程不再向 `~/.config/tianji-ai/default-orchestration.json` 写文件（该路径保持不存在）
- agent 实际收到的 user message 内容 = 你发的内容（不是空串）

若确认 OK，还原（或让它保持不存在状态）：

```bash
# 让 fallback 持续生效：保持文件不存在即可
# 或若想回到原状态： mv ~/.config/tianji-ai/default-orchestration.json.bak ~/.config/tianji-ai/default-orchestration.json
```

- [ ] **Step 5：最终提交（如有剩余改动）**

若 Step 1-3 过程中修了额外问题，使用 `git commit` skill 生成消息后提交；否则跳过。

---

## 自检

| 检查项 | 结果 |
|---|---|
| 新增 `packages/agent/config/default-orchestration.json` → Task 1 Step 1 | ✓ |
| `package.json` `files` 字段包含 `config` → Task 1 Step 2 | ✓ |
| `graph-loader.ts` ENOENT fallback + 其它错误不兜底 → Task 2 Step 4-6 | ✓ |
| `context.ts` 删除硬编码常量 → Task 3 Step 4 | ✓ |
| `context.ts` 删除 orchestration 首次写入 → Task 3 Step 5 | ✓ |
| 测试覆盖 fallback 正常路径 → Task 2 Step 1 | ✓ |
| 测试覆盖 malformed JSON 不 fallback → Task 2 Step 2 | ✓ |
| 测试移除过期断言 → Task 3 Step 1-2 | ✓ |
| 全仓 `pnpm check` → Task 4 Step 1 | ✓ |
| 端到端确认原 bug 被修 → Task 4 Step 4 | ✓ |
