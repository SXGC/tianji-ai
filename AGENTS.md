# 输出规范

- 必须深度思考。
- 所有最终回答必须使用中文。
- 回答必须直白，把用户当做普通高中生，禁止用办公室黑话套话。不使用表情符号。不写无信息量的客套话或填充内容。
- 编码、分析等具体步骤需要从细节入手。回复用户需要从大处着手。用户不需要了解每个细节。例如用户认为 session 创建有问题，你找到问题原因后需要结合整个 session 生命周期简洁的和用户讲清楚。w
- 默认不要输出具体代码，除非用户明确要求。优先用架构、职责、边界、数据流和设计权衡来回答。必须举例时也只用伪代码或最小骨架。
- 强制收口。结束对话必须要在下一步的计划前，总结本次对话行为，并列出使用的 skill 和 tool。

# 核心原则

- 需求必须清晰。如果指令动机不清立即停止并反馈。
- Let it crash。发现问题尽早暴露。严禁使用任何降级兜底、启发式补丁或非严谨通用算法的后处理补救。如果你觉得这里有问题，就让他暴露。

# 软件工程规则

## 架构原则
- 遵循KISS原则（Keep It Simple and Stupid）和奥卡姆剃刀原理（如无必要，勿增实体）
- 所有实现不能仅仅考虑实现，而要考虑到未来的可维护性、可读性。

## 执行计划原则

- 没有明确要求，默认使用 subagent-driven 进行执行.
- 使用 opus 进行 review 代码，使用 sonnet 进行编写代码.

## 代码风格
- 绝对不允许在一个文件中放入超过 800 行代码
- 除非绝对必要，禁止使用 `any`。
- 外部 API 的类型定义必须先在 `node_modules` 中确认，禁止猜测。
- 始终使用顶部导入（top-level import）。
- 禁止使用内联导入或动态类型导入：
  - 禁止 `await import("./foo.js")`
  - 禁止 `import("pkg").Type`
  - 禁止任何类型层面的动态导入
- 不得通过删除代码、降级能力或绕过逻辑来规避由依赖过时引起的类型错误；应优先升级依赖。
- 删除看起来是有意设计的功能或代码前，必须先询问用户。
- 禁止硬编码快捷键判断，例如 `matchesKey(keyData, "ctrl+x")`。
- 所有 build 产物必须放到对应包的 dist 目录中，并且在 .gitignore 中忽视。
- 所有快捷键都必须可配置，并在默认配置中声明，例如：
  - `DEFAULT_EDITOR_KEYBINDINGS`
  - `DEFAULT_APP_KEYBINDINGS`
- 任何环境变量的添加都需要明确让用户同意.
- 禁止递归
- 业务代码不要过多考虑边界判断
- 所有隐式全局变量的功能（类似 als）都不允许放过多变量，只允许放基础变量

## 日志
- 日志需要分层，不能只用一个 log level。catch 异常时，请使用 error level 日志。

## 测试编写原则

- 需要先理解业务流程在写测试。验证正确的业务行为，而非代码逻辑的正确性。
- 测试代码必须要考虑业务边界情况
- 变量名以及测试逻辑高可读性
- 日志代码不允许添加任何测试。如果按照 TDD 原则，跳过写测试步骤，直接开始实现。
- 需要有单元测试和集成测试

### 文档与注释

- 在创建新方法或编写复杂逻辑时，添加必要注释, 注释格式使用 tsdoc。
- 主要方法需要详细的注释，而边界判断代码的注释只需要一句话解释
- 在进行功能修改后，需要更新受影响的 README.md。例如你修改了 runtime 包里的功能，需要看看是否需要更新 README.md

## 命令执行规则

### 必须遵守

- 若进行了代码变更（文档变更除外），必须执行 `pnpm check`。
- 必须保留完整输出，不得截断。
- 在结束前，必须修复 `pnpm check` 报出的所有错误、警告和信息。
- `pnpm check` 不会运行测试，不要误判。
- 测试先于代码实现，实现后需要进行回归测试。

### 禁止执行

- 禁止运行：
  - `pnpm dev`

### 测试规则

- 运行测试时，必须从对应包的根目录执行，而不是仓库根目录。
- 编写测试后，必须实际运行，并根据测试结果持续迭代，直到测试或实现中的问题被修复。
- `@tianji/node` 的冒烟测试命令为 `SMOKE_E2E=1 pnpm --filter @tianji/node test:smoke`。
- 该冒烟测试会在 `SMOKE_E2E=1` 时通过 Vitest `setupFiles` 自动加载仓库根目录 `.env.test`，并覆盖当前 shell 中的同名环境变量。

### 提交规则

- 如果需要执行 `git commit`，必须先加载 `git commit` skill。
- 绝对不允许添加例如 `Co-Authored-By:` 这样的内容

## 文件读取与编辑规则

* 禁止使用 `sed`、`cat` 读取文件或文件片段。
* 必须使用 `read` 工具，并使用 `offset + limit` 方式读取。
* 在编辑任何文件前，必须完整读取该文件。

## Git 操作限制

### 严禁使用以下命令

这些操作可能破坏其他代理的工作：

```bash
git reset --hard
git checkout .
git clean -fd
git stash
git add -A
git add .
git commit --no-verify
```

### Rebase 冲突处理

* 只解决你负责文件中的冲突。
* 如果冲突出现在你未修改的文件中，立即停止并询问用户。
* 严禁 `force push`。

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **daemon-session-thread-alignment** (3633 symbols, 6197 relationships, 245 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## When Debugging

1. `gitnexus_query({query: "<error or symptom>"})` — find execution flows related to the issue
2. `gitnexus_context({name: "<suspect function>"})` — see all callers, callees, and process participation
3. `READ gitnexus://repo/daemon-session-thread-alignment/process/{processName}` — trace the full execution flow step by step
4. For regressions: `gitnexus_detect_changes({scope: "compare", base_ref: "main"})` — see what your branch changed

## When Refactoring

- **Renaming**: MUST use `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` first. Review the preview — graph edits are safe, text_search edits need manual review. Then run with `dry_run: false`.
- **Extracting/Splitting**: MUST run `gitnexus_context({name: "target"})` to see all incoming/outgoing refs, then `gitnexus_impact({target: "target", direction: "upstream"})` to find all external callers before moving code.
- After any refactor: run `gitnexus_detect_changes({scope: "all"})` to verify only expected files changed.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Tools Quick Reference

| Tool | When to use | Command |
|------|-------------|---------|
| `query` | Find code by concept | `gitnexus_query({query: "auth validation"})` |
| `context` | 360-degree view of one symbol | `gitnexus_context({name: "validateUser"})` |
| `impact` | Blast radius before editing | `gitnexus_impact({target: "X", direction: "upstream"})` |
| `detect_changes` | Pre-commit scope check | `gitnexus_detect_changes({scope: "staged"})` |
| `rename` | Safe multi-file rename | `gitnexus_rename({symbol_name: "old", new_name: "new", dry_run: true})` |
| `cypher` | Custom graph queries | `gitnexus_cypher({query: "MATCH ..."})` |

## Impact Risk Levels

| Depth | Meaning | Action |
|-------|---------|--------|
| d=1 | WILL BREAK — direct callers/importers | MUST update these |
| d=2 | LIKELY AFFECTED — indirect deps | Should test |
| d=3 | MAY NEED TESTING — transitive | Test if critical path |

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/daemon-session-thread-alignment/context` | Codebase overview, check index freshness |
| `gitnexus://repo/daemon-session-thread-alignment/clusters` | All functional areas |
| `gitnexus://repo/daemon-session-thread-alignment/processes` | All execution flows |
| `gitnexus://repo/daemon-session-thread-alignment/process/{name}` | Step-by-step execution trace |

## Self-Check Before Finishing

Before completing any code modification task, verify:
1. `gitnexus_impact` was run for all modified symbols
2. No HIGH/CRITICAL risk warnings were ignored
3. `gitnexus_detect_changes()` confirms changes match expected scope
4. All d=1 (WILL BREAK) dependents were updated

## Keeping the Index Fresh

After committing code changes, the GitNexus index becomes stale. Re-run analyze to update it:

```bash
npx gitnexus analyze
```

If the index previously included embeddings, preserve them by adding `--embeddings`:

```bash
npx gitnexus analyze --embeddings
```

To check whether embeddings exist, inspect `.gitnexus/meta.json` — the `stats.embeddings` field shows the count (0 means no embeddings). **Running analyze without `--embeddings` will delete any previously generated embeddings.**

> Claude Code users: A PostToolUse hook handles this automatically after `git commit` and `git merge`.

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
