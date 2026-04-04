# AI 编程助手 CLI 命令对比

对 `.othergit` 中四个项目的 CLI 命令进行横向分析：OpenCode、Codex、Claude Code、ForgeCode。

## 1. OpenCode

- **语言/框架:** TypeScript, yargs
- **命令总数:** ~40+

### 命令列表

| 分类 | 命令 | 说明 |
|------|------|------|
| 会话 | `run` | 使用消息运行 opencode |
| 会话 | `attach <url>` | 连接到运行中的 opencode 服务器 |
| 会话 | `serve` | 启动无头服务器 |
| 会话 | `web` | 启动服务器并打开 Web 界面 |
| 会话 | `session list` | 列出会话 |
| 会话 | `session delete` | 删除会话 |
| 会话 | `export` | 导出会话为 JSON |
| 会话 | `import` | 从 JSON 导入会话 |
| 会话 | `pr <number>` | 检出 GitHub PR 分支并运行 |
| 提供商 | `providers list` | 列出提供商和凭证 |
| 提供商 | `providers login` | 登录提供商 |
| 提供商 | `providers logout` | 登出提供商 |
| 模型 | `models [provider]` | 列出可用模型 |
| MCP | `mcp list` | 列出 MCP 服务器 |
| MCP | `mcp add` | 添加 MCP 服务器 |
| MCP | `mcp auth` | OAuth 认证 MCP 服务器 |
| MCP | `mcp logout` | 移除 OAuth 凭证 |
| MCP | `mcp debug` | 调试 OAuth 连接 |
| 代理 | `agent create` | 创建新代理 |
| 代理 | `agent list` | 列出可用代理 |
| 控制台 | `console login` | 登录控制台 |
| 控制台 | `console logout` | 登出控制台 |
| 控制台 | `console switch` | 切换活跃组织 |
| 控制台 | `console orgs` | 列出组织 |
| 控制台 | `console open` | 打开活跃控制台 |
| GitHub | `github install` | 安装 GitHub 代理 |
| GitHub | `github run` | 运行 GitHub 代理 |
| 其他 | `generate` | 生成 OpenAPI 规范 |
| 其他 | `upgrade` | 升级到最新版本 |
| 其他 | `uninstall` | 卸载并删除所有文件 |
| 其他 | `plugin <module>` | 安装插件 |
| 其他 | `db [query]` | SQLite shell 或执行查询 |
| 其他 | `stats` | 显示 token 使用和成本 |
| 其他 | `acp` | 启动 ACP 服务器 |
| 其他 | `completion` | 生成 shell 补全脚本 |
| 调试 | `debug config` | 显示已解析配置 |
| 调试 | `debug lsp` | LSP 调试 |
| 调试 | `debug rg` | ripgrep 调试 |
| 调试 | `debug search` | 文件搜索 |
| 调试 | `debug scrap` | 列出已知项目 |
| 调试 | `debug skill` | 列出技能 |
| 调试 | `debug snapshot` | 快照调试 |
| 调试 | `debug agent` | 代理配置详情 |
| 调试 | `debug paths` | 显示全局路径 |

### 全局选项

`--help`, `--version`, `--print-logs`, `--log-level`, `--pure`

---

## 2. Codex

- **语言/框架:** Rust, clap
- **命令总数:** ~35+

### 命令列表

| 分类 | 命令 | 说明 |
|------|------|------|
| 核心 | `exec` (别名 `e`) | 非交互模式运行 |
| 核心 | `review` | 非交互代码审查 |
| 核心 | `apply` (别名 `a`) | 应用 agent 生成的差异 |
| 核心 | `resume` | 恢复上一个交互式会话 |
| 核心 | `fork` | 分叉上一个交互式会话 |
| 认证 | `login` | 管理登录 |
| 认证 | `login status` | 显示登录状态 |
| 认证 | `logout` | 移除身份验证凭证 |
| MCP | `mcp list` | 列出配置的服务器 |
| MCP | `mcp get` | 显示单个服务器 |
| MCP | `mcp add` | 添加服务器条目 |
| MCP | `mcp remove` | 删除服务器条目 |
| MCP | `mcp login` | OAuth 认证 MCP 服务器 |
| MCP | `mcp logout` | 移除 OAuth 凭证 |
| 沙箱 | `sandbox macos` | macOS Seatbelt 沙箱 |
| 沙箱 | `sandbox linux` | Linux bubblewrap 沙箱 |
| 沙箱 | `sandbox windows` | Windows 受限令牌沙箱 |
| 云任务 | `cloud exec` | 提交云端任务 |
| 云任务 | `cloud status` | 显示云端任务状态 |
| 云任务 | `cloud list` | 列出云端任务 |
| 云任务 | `cloud apply` | 本地应用云端差异 |
| 云任务 | `cloud diff` | 显示云端任务差异 |
| 功能 | `features list` | 列出功能标志 |
| 功能 | `features enable` | 启用功能 |
| 功能 | `features disable` | 禁用功能 |
| 服务 | `mcp-server` | 作为 MCP 服务器启动 (stdio) |
| 服务 | `app-server` | 运行 app server [实验] |
| 服务 | `app` | 启动桌面应用 [仅 macOS] |
| 调试 | `debug app-server send-message-v2` | 向 app server 发消息 |
| 调试 | `debug clear-memories` | 重置本地内存 |
| 其他 | `completion` | 生成 shell 补全 |
| 其他 | `execpolicy check` | 检查执行策略 |
| 内部 | `responses-api-proxy` | Responses API 代理 |
| 内部 | `stdio-to-uds` | stdio 到 UDS 中继 |

---

## 3. Claude Code

- **语言/框架:** TypeScript, 自定义命令系统
- **命令总数:** ~88+ (含功能门控命令)
- **命令类型:** `prompt`(发送给模型)、`local`(本地执行)、`local-jsx`(React 渲染)

### 命令列表

| 分类 | 命令 | 别名 | 说明 |
|------|------|------|------|
| 会话 | `resume` | `continue` | 恢复之前的对话 |
| 会话 | `branch` | `fork` | 创建对话分支 |
| 会话 | `rewind` | `checkpoint` | 恢复代码/对话到之前状态 |
| 会话 | `rename` | - | 重命名当前对话 |
| 会话 | `clear` | `reset`, `new` | 清除对话历史 |
| 会话 | `compact` | - | 压缩上下文 |
| 会话 | `export` | - | 导出对话 |
| 会话 | `share` | - | 共享当前对话 |
| 会话 | `copy` | - | 复制最后一条消息 |
| 会话 | `summary` | - | 总结当前对话 |
| 会话 | `context` | - | 可视化上下文使用量 |
| 会话 | `exit` | `quit` | 退出 REPL |
| 文件 | `add-dir` | - | 添加工作目录 |
| 文件 | `files` | - | 列出上下文中的文件 |
| 文件 | `diff` | - | 查看未提交更改 |
| 配置 | `config` | `settings` | 打开配置面板 |
| 配置 | `keybindings` | - | 打开键绑定配置 |
| 配置 | `theme` | - | 更改主题 |
| 配置 | `color` | - | 设置提示栏颜色 |
| 配置 | `vim` | - | 切换 Vim 模式 |
| 配置 | `model` | - | 选择模型 |
| 配置 | `effort` | - | 设置努力级别 |
| 配置 | `fast` | - | 快速模式切换 |
| 配置 | `permissions` | `allowed-tools` | 管理工具权限 |
| 配置 | `hooks` | - | 查看钩子配置 |
| 配置 | `privacy-settings` | - | 隐私设置 |
| 集成 | `mcp` | - | 管理 MCP 服务器 |
| 集成 | `plugin` | - | 管理插件 |
| 集成 | `reload-plugins` | - | 重新加载插件 |
| 集成 | `memory` | - | 编辑内存文件 |
| 集成 | `skills` | - | 列出技能 |
| 集成 | `agents` | - | 管理代理配置 |
| 审查 | `review` | - | 审查 PR |
| 审查 | `ultrareview` | - | 深度 bug 扫描 (~10-20 min) |
| 审查 | `security-review` | - | 安全审查 |
| 审查 | `pr-comments` | - | 获取 PR 评论 |
| 使用量 | `cost` | - | 显示成本和时长 |
| 使用量 | `usage` | - | 显示计划限制 |
| 使用量 | `extra-usage` | - | 配置额外用量 |
| 使用量 | `rate-limit-options` | - | 速率限制选项 |
| 使用量 | `passes` | - | 查看可用次数 |
| 集成 | `desktop` | `app` | 在 Desktop 中继续 |
| 集成 | `mobile` | `ios`, `android` | 移动端二维码 |
| 集成 | `install-github-app` | - | 设置 GitHub Actions |
| 集成 | `install-slack-app` | - | 安装 Slack 应用 |
| 集成 | `remote-env` | - | 配置远程环境 |
| 集成 | `ide` | - | 管理 IDE 集成 |
| 集成 | `chrome` | - | Chrome 扩展设置 |
| 集成 | `terminal-setup` | - | 终端集成设置 |
| 协作 | `btw` | - | 快速侧问题 |
| 协作 | `tag` | - | 切换可搜索标签 |
| 协作 | `tasks` | `bashes` | 管理后台任务 |
| 诊断 | `doctor` | - | 诊断安装 |
| 诊断 | `status` | - | 显示会话状态 |
| 诊断 | `stats` | - | 使用统计 |
| 诊断 | `statusline` | - | 切换状态行 |
| 诊断 | `env` | - | 环境配置 |
| 规划 | `plan` | - | 计划模式 |
| 规划 | `brief` | - | 创建/查看简要说明 |
| 规划 | `workflows` | - | 运行工作流脚本 |
| 认证 | `login` | - | 登录 |
| 认证 | `logout` | - | 登出 |
| 认证 | `upgrade` | - | 升级到 Max |
| 其他 | `help` | - | 显示帮助 |
| 其他 | `init` | - | 初始化项目 |
| 其他 | `stickers` | - | 订购贴纸 |
| 其他 | `release-notes` | - | 查看发行说明 |
| 其他 | `insights` | - | 生成分析报告 |
| 其他 | `advisor` | - | 配置顾问模型 |
| 其他 | `feedback` | `bug` | 提交反馈 |
| 其他 | `good-claude` | - | 标记有用回答 |

### 功能门控命令

需要特定功能标志才可用：

| 命令 | 功能标志 |
|------|----------|
| `bridge` | BRIDGE_MODE |
| `voice` | VOICE_MODE |
| `assistant` | KAIROS |
| `proactive` | PROACTIVE + KAIROS |
| `ultraplan` | ULTRAPLAN |
| `subscribe-pr` | KAIROS_GITHUB_WEBHOOKS |
| `peers` | UDS_INBOX |
| `fork` | FORK_SUBAGENT |
| `buddy` | BUDDY |
| `torch` | TORCH |
| `force-snip` | HISTORY_SNIP |
| `remote-setup` | CCR_REMOTE_SETUP |

---

## 4. ForgeCode

- **语言/框架:** Rust, clap
- **命令总数:** ~60+ (含交互模式命令)

### CLI 命令列表

| 分类 | 命令 | 说明 |
|------|------|------|
| 会话 | `conversation new` | 创建新会话 |
| 会话 | `conversation list` | 列出会话 |
| 会话 | `conversation dump` | 导出为 JSON/HTML |
| 会话 | `conversation compact` | 压缩会话 |
| 会话 | `conversation retry` | 重试上一命令 |
| 会话 | `conversation resume` | 恢复会话 |
| 会话 | `conversation show` | 显示最后一条消息 |
| 会话 | `conversation info` | 会话详情 |
| 会话 | `conversation stats` | 会话统计 |
| 会话 | `conversation clone` | 克隆会话 |
| 会话 | `conversation delete` | 删除会话 |
| 会话 | `conversation rename` | 重命名会话 |
| 配置 | `config set model` | 设置活动模型 |
| 配置 | `config set provider` | 设置活动提供商 |
| 配置 | `config set commit` | 设置提交消息模型 |
| 配置 | `config set suggest` | 设置命令建议模型 |
| 配置 | `config set reasoning-effort` | 设置推理努力级别 |
| 配置 | `config get` | 获取配置值 |
| 配置 | `config list` | 列出配置 |
| 提供商 | `provider login` | 认证提供商 |
| 提供商 | `provider logout` | 删除凭证 |
| 提供商 | `provider list` | 列出提供商 |
| MCP | `mcp import` | 从 JSON 导入配置 |
| MCP | `mcp list` | 列出服务器 |
| MCP | `mcp remove` | 删除服务器 |
| MCP | `mcp show` | 显示服务器详情 |
| MCP | `mcp reload` | 重新加载服务器 |
| 代理 | `agent list` | 列出可用代理 |
| Shell | `zsh plugin` | 生成 shell 插件脚本 |
| Shell | `zsh theme` | 生成 shell 主题 |
| Shell | `zsh doctor` | shell 环境诊断 |
| Shell | `zsh rprompt` | 获取提示符信息 |
| Shell | `zsh setup` | 设置 zsh 集成 |
| Shell | `zsh keyboard` | 显示键盘快捷键 |
| 工作区 | `workspace sync` | 同步目录以语义搜索 |
| 工作区 | `workspace list` | 列出工作区 |
| 工作区 | `workspace query` | 查询工作区 |
| 工作区 | `workspace info` | 显示工作区信息 |
| 工作区 | `workspace delete` | 删除工作区 |
| 工作区 | `workspace status` | 文件同步状态 |
| 工作区 | `workspace init` | 初始化空工作区 |
| 自定义命令 | `cmd list` | 列出自定义命令 |
| 自定义命令 | `cmd execute` | 执行自定义命令 |
| 统一列表 | `list agents` | 列出代理 |
| 统一列表 | `list providers` | 列出提供商 |
| 统一列表 | `list models` | 列出模型 |
| 统一列表 | `list commands` | 列出命令 |
| 统一列表 | `list configs` | 列出配置 |
| 统一列表 | `list tools` | 列出工具 |
| 统一列表 | `list mcps` | 列出 MCP 服务器 |
| 统一列表 | `list sessions` | 列出会话 |
| 统一列表 | `list skills` | 列出技能 |
| 其他 | `commit` | AI 生成提交消息 |
| 其他 | `suggest` | 从自然语言建议 shell 命令 |
| 其他 | `data` | 通过 LLM 处理 JSONL 数据 |
| 其他 | `vscode install-extension` | 安装 VS Code 扩展 |
| 其他 | `update` | 更新到最新版本 |
| 其他 | `doctor` | 环境诊断 |
| 其他 | `banner` | 显示版本横幅 |
| 其他 | `info` | 显示配置和环境 |
| 其他 | `env` | 环境信息 |

### 交互模式内置命令

在交互模式中额外支持约 30 个命令：

| 命令 | 别名 | 说明 |
|------|------|------|
| `info` | `i` | 打印会话信息 |
| `env` | `e` | 显示环境信息 |
| `config-provider` | `p` | 切换提供商 |
| `config-model` | `cm` | 切换模型 (全局) |
| `model` | `m` | 切换模型 (仅当前会话) |
| `model-reset` | `mr` | 重置会话模型 |
| `reasoning-effort` | `re` | 设置推理努力 (会话) |
| `config-reasoning-effort` | `cre` | 设置推理努力 (全局) |
| `config-commit-model` | `ccm` | 设置提交消息模型 |
| `config-suggest-model` | `csm` | 设置建议模型 |
| `config` | - | 列出配置值 |
| `config-edit` | `ce` | 编辑器打开配置文件 |
| `new` | `n` | 新会话 |
| `dump` | `d` | 导出会话 |
| `conversation` | `c` | 列出所有会话 |
| `retry` | `r` | 重试上一命令 |
| `compact` | - | 压缩上下文 |
| `edit` | - | 使用外部编辑器写提示 |
| `tools` | `t` | 列出所有工具 |
| `skill` | - | 列出所有技能 |
| `commit` | - | 提交 AI 生成的消息 |
| `commit-preview` | - | 预览提交消息 |
| `suggest` | `s` | 生成 shell 命令 |
| `provider-login` | `login` | 登录提供商 |
| `logout` | - | 注销提供商 |
| `agent` | `a` | 选择并切换代理 |
| `workspace-sync` | `sync` | 同步工作区 |
| `clone` | - | 克隆会话 |
| `rename` | `rn` | 重命名当前会话 |
| `copy` | - | 复制到剪贴板 |
| `doctor` | - | 环境诊断 |
| `keyboard-shortcuts` | `kb` | ZSH 快捷键 |
| `setup` | - | 设置 zsh 集成 |

### 全局选项

`-p/--prompt`, `--conversation`, `--conversation-id`, `-C/--directory`, `--sandbox`, `--verbose`, `--agent`, `-e/--event`

---

## 横向对比

### 命令规模

| 工具 | CLI 命令数 | 交互命令数 | 总计 |
|------|-----------|-----------|------|
| OpenCode | ~40 | - | ~40 |
| Codex | ~35 | - | ~35 |
| Claude Code | ~88+ | (统一命令系统) | ~88+ |
| ForgeCode | ~60 | ~30 | ~90 |

### 能力矩阵

| 能力 | OpenCode | Codex | Claude Code | ForgeCode |
|------|:--------:|:-----:|:-----------:|:---------:|
| MCP 管理 | Y | Y | Y | Y |
| 代理系统 | Y | - | Y | Y |
| 会话管理 | 基础 | resume/fork | 丰富 | 最完整 |
| 代码审查 | - | review | review/ultra/security | - |
| 云/远程执行 | attach/serve/web | cloud tasks | remote/bridge | - |
| 沙箱隔离 | - | 跨平台 | toggle | - |
| Shell 集成 | - | - | terminal-setup | zsh 深度集成 |
| 语义搜索 | - | - | - | workspace |
| 自定义命令 | - | execpolicy | skills/plugins | cmd 系统 |
| IDE 集成 | - | - | VS Code/JetBrains/Chrome | VS Code |
| 提交生成 | - | - | skill | 内置 |
| 功能标志 | - | - | 完善体系 | - |
| 统一列表入口 | - | - | - | `list` 子命令 |
| 插件系统 | Y | - | Y | - |
| 数据处理 | - | - | - | `data` JSONL |

### 各工具独有特色

- **OpenCode**: 控制台组织管理、ACP 协议支持、PR 直接检出运行、SQLite 数据库访问、OpenAPI 生成
- **Codex**: 跨平台沙箱 (macOS/Linux/Windows)、cloud tasks 远程执行、execpolicy 安全策略、app-server 协议
- **Claude Code**: 命令最丰富，功能门控体系完善，集成最广 (GitHub/Slack/Desktop/Mobile/IDE/Chrome)，多层代码审查，计划模式
- **ForgeCode**: 工作区语义搜索，zsh 深度集成 (主题/插件/键盘快捷键/rprompt)，会话管理最完整 (12 个子命令)，`list` 统一列表入口，JSONL 数据处理
