# agents.md

## 通用要求

- 所有最终回答必须使用中文。
- 回答保持简短、直接、技术化。
- 不使用表情符号。
- 不写无信息量的客套话或填充内容。

## 代码质量

### 代码风格
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

## 输出要求

* 所有最终回答必须使用中文。
* 输出语言要通俗易懂，严禁使用套话、黑话。例如*出清*改为*清理*
