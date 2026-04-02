# Tianji AI 开发者指南

> 状态：当前
> 日期：2026-04-02
> 相关文档：[`./ARCHITECTURE.md`](./ARCHITECTURE.md)

---

## 1. 环境要求

| 工具 | 版本 |
|------|------|
| Node.js | ≥ 18（推荐 22+） |
| pnpm | 10.28.0（由 `package.json#packageManager` 锁定） |

---

## 2. 快速开始

```bash
git clone <repo-url>
cd tianji-ai
pnpm install        # 安装依赖 + Husky hooks
pnpm build          # 构建所有包
pnpm check          # lint + typecheck
pnpm test           # 运行所有测试
```

---

## 3. 仓库结构与包依赖

### 3.1 包结构

```text
tianji-ai/
├─ packages/
│  ├─ shared/       # L0: 类型 + 配置 schema + 工具函数
│  ├─ observer/     # 横切: 结构化日志 + tracing
│  ├─ runtime/      # L1: 配置加载 + LLM 网关 + 执行引擎
│  └─ agent/        # L2: 上下文装配 + 启动封装 + daemon
├─ apps/
│  └─ cli/          # L3: 命令行应用
└─ docs/            # 设计文档
```

### 3.2 依赖方向

```
shared (零内部依赖)
    ↑
observer (零内部依赖)
    ↑
runtime (→ shared, observer)
    ↑
agent (→ shared, runtime)
    ↑
cli (→ shared, agent, observer)
```

**约束**：依赖只能向下指。CLI 不直接依赖 runtime，agent 不使用 AI SDK / LangChain。

### 3.3 依赖矩阵

| 包 | 允许的内部依赖 | 禁止的外部依赖 |
|----|--------------|---------------|
| `@tianji/shared` | 无 | `ai`, `@ai-sdk/*`, `@langchain/*`, `deepagents` |
| `@tianji/observer` | 无 | 所有内部包 |
| `@tianji/runtime` | shared, observer | `@tianji/agent`, `apps/*` |
| `@tianji/agent` | shared, runtime | `ai`, `@ai-sdk/*`, `@langchain/*` |
| `@tianji/cli` | shared, agent, observer | `@tianji/runtime`, `ai`, `@ai-sdk/*` |

---

## 4. 常用命令

### 4.1 根目录命令

| 命令 | 用途 |
|------|------|
| `pnpm lint` | Biome linter（全仓库） |
| `pnpm format` | Biome 格式化（带 `--write`） |
| `pnpm format:check` | 检查格式（不修改） |
| `pnpm typecheck` | 递归执行各包 `tsc --noEmit` |
| `pnpm check` | 完整检查 = `biome check` + `typecheck` |
| `pnpm build` | Turbo 编排构建所有包 |
| `pnpm test` | Turbo 编排运行所有测试 |
| `pnpm tianji <cmd>` | 构建后直接运行 CLI |

### 4.2 单包命令

```bash
cd packages/runtime     # 进入目标包
pnpm typecheck          # 类型检查
pnpm test               # 运行测试
pnpm test:watch         # 监视模式
pnpm build              # 构建
pnpm clean              # 清理 dist/
```

**重要**：测试必须从对应包的根目录执行，不是仓库根目录。

---

## 5. 构建系统

### 5.1 Turbo 任务编排

```json
{
  "build":     { "outputs": ["dist/**"] },
  "typecheck": { "dependsOn": ["^build"] },
  "test":      { "dependsOn": ["^build"] },
  "check":     { "dependsOn": ["typecheck", "lint"] }
}
```

- `^build` 表示依赖包必须先完成构建
- `check` 依赖 `typecheck` 和 `lint` 都完成
- Turbo 自动处理缓存和并行执行

### 5.2 TypeScript 配置

**基础配置**（`tsconfig.json`）：
- `strict: true`
- `target: ES2022`
- `module: ESNext`
- `moduleResolution: bundler`
- `noEmit: true`（仅类型检查）

**构建配置**（`tsconfig.build.json`）：
- 继承基础配置
- `noEmit: false`，输出到 `dist/`
- 生成 `declaration` + `declarationMap` + `sourceMap`
- 排除测试文件

每个包有自己的 `tsconfig.json` 和 `tsconfig.build.json`，继承根配置。

---

## 6. 代码质量

### 6.1 Biome 配置

**格式化规则**：
- 缩进：2 空格
- 行宽：100
- 换行符：LF
- 引号：单引号（JSX 用双引号）
- 尾逗号：ES5 风格
- 分号：按需
- 箭头函数括号：始终

**Lint 规则**：
- 启用推荐规则集（accessibility、complexity、correctness、performance、security、style、suspicious）
- `noNonNullAssertion` 关闭（允许 `!` 断言）

**忽略**：`node_modules`、`dist`、`.turbo`、`coverage`、`*.min.js`、`*.js`、`*.d.ts`

### 6.2 代码规范

- **禁止 `any`**：除非绝对必要
- **顶部导入**：禁止动态 `import()` 和类型层面的动态导入
- **外部 API 类型**：必须在 `node_modules` 中确认，禁止猜测
- **快捷键**：禁止硬编码，必须可配置
- **注释**：新方法和复杂逻辑添加 TSDoc 格式注释
- **README 更新**：功能修改后检查并更新相关 README

---

## 7. 测试

### 7.1 框架

- **Vitest**：Node.js 环境，全局 API（`describe`、`it`、`expect`）
- **覆盖率**：v8 provider，输出 text + json + html + lcov

### 7.2 文件组织

测试文件放在各包的 `src/__tests__/` 目录下，命名为 `*.test.ts`。

### 7.3 执行

```bash
# 从包目录执行（不是仓库根目录）
cd packages/runtime
pnpm test              # 运行一次
pnpm test:watch        # 监视模式

# CLI 冒烟测试（需要配置 provider）
cd apps/cli
SMOKE_E2E=1 pnpm test:smoke
```

### 7.4 原则

- 测试先于代码实现
- 实现后进行回归测试
- `pnpm check` 不运行测试，不要误判

---

## 8. Git Hooks

### 8.1 pre-commit

通过 Husky（v9）安装，`pnpm install` 时自动配置。

```bash
pnpm precommit:check
```

执行内容：
1. `biome check --staged`：仅对暂存文件执行 lint / format 检查
2. `pnpm -r typecheck`：递归类型检查所有包

目标：提交前检查尽量轻量，不触发 Turbo 依赖包构建。

### 8.2 工作流

```
代码修改 → pnpm check（本地验证）→ git add → git commit（hook 自动运行）
```

如果 `pnpm check` 通过，pre-commit hook 通常也会通过。

---

## 9. 环境变量

根目录 `.env.example` 列出了当前代码使用的环境变量：

```
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
GOOGLE_GENERATIVE_AI_API_KEY=
```

无"无条件必需"变量。这些仅在使用对应 provider 且走默认环境变量读取时需要。

配置系统支持 `${env:VAR_NAME}` 占位符，`.env.example` 不是完整白名单。

---

## 10. 必须遵守的规则

代码变更后（文档变更除外）：

1. **必须执行 `pnpm check`** 并修复所有错误、警告和信息
2. **禁止运行 `pnpm dev`**
3. **禁止截断 `pnpm check` 输出**
4. **禁止使用 `any`**（除非绝对必要）
5. **禁止动态导入**（`await import()` 和 `import().Type`）
6. **不得通过删除代码规避类型错误**——应优先升级依赖
7. **删除有意设计的功能前必须询问**
