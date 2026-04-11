# 输出规范

- 所有最终回答必须使用中文。
- 回答必须直白，把用户当做普通高中生，禁止用办公室黑话套话。不使用表情符号。不写无信息量的客套话或填充内容,例如*出清*改为*清理*。
- 使用简洁的格式输出。对于复杂对比、流程多使用图表。
- 强制收口。结束对话必须要总结本次对话行为，并列出使用的 skill 和 tool。

# 核心原则

- 需求必须清晰。如果指令动机不清立即停止并反馈。
- Let it crash。发现问题尽早暴露。严禁使用任何降级兜底、启发式补丁或非严谨通用算法的后处理补救。如果你觉得这里有问题，就让他暴露。

# 软件工程规则

## 架构原则
- 遵循KISS原则（Keep It Simple and Stupid）和奥卡姆剃刀原理（如无必要，勿增实体）
- 所有实现不能仅仅考虑实现，而要考虑到未来的可维护性、可读性。

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

## 代码质量

```
pnpm test:coverage
pnpm sonar 
```

### sonar

环境变量中已经有 SONAR_HOST_URL 和 SONAR_TOKEN
- 用户要求直接开始执行时，不要因为 todo 计划再等待确认，直接推进。

Sonar 的 api/ce/task 可以查询 Compute Engine 任务；质量门可以用 api/qualitygates/project_status 查；问题列表可以用 api/issues/search 查；指标可以走 api/measures
