# Tianji AI 配置设计 v1

> 状态：Draft v1  
> 范围：`tianji-ai` 的详细配置机制  
> 相关文档：[`./ARCHITECTURE_V1.md`](./ARCHITECTURE_V1.md)

---

## 1. 目的

本文档定义了 `tianji-ai` 中配置是如何被**存储、加载、合并、校验与解析**的。

主架构文档仍然是以下内容的唯一事实来源：

- 归属边界
- 运行时不变量
- cancellation / snapshot truth
- delta / event 语义
- 工具路径安全规则

本文聚焦于配置的操作机制。

---

## 2. 设计原则

1. **配置以 JSON 为核心**  
   面向用户的配置存放在 JSON 文件中，而不是分散在各处的环境变量里。

2. **密钥由环境变量承载**  
   敏感值通过占位符从环境变量中注入。

3. **运行时只解析一次配置**  
   `packages/runtime` 是唯一负责合并配置层并解析占位符的组件。

4. **Schema 位于 `packages/shared`**  
   类型定义、校验 schema、迁移辅助工具以及占位符语法规则都定义在 `packages/shared` 中。

5. **后置层覆盖前置层**  
   覆盖行为是确定性的，并且基于字段路径进行处理。

---

## 3. 配置层

`tianji-ai` 使用三层 JSON 配置。

### 3.1 项目层

路径：

```text
<project-root>/tianji.config.json
```

作用：

- 项目默认值
- 团队共享行为
- 默认模型路由
- 默认工具策略
- 默认 observer 设置

这是仓库的**工厂默认**配置。

### 3.2 用户层

路径：

```text
~/.config/tianji-ai/tianji.json
```

作用：

- 用户级覆盖
- 跨仓库的个人默认值
- 偏好的 provider、UI 相关默认值、个人非敏感设置

这一层会覆盖项目层。

### 3.3 工作区层

路径：

```text
~/.config/tianji-ai/workspaces/<workspace-id>.json
```

作用：

- 工作区特定覆盖
- 仓库本地的用户行为
- 针对工具、模型或运行时设置的本地例外

这一层会同时覆盖项目层和用户层。

---

## 4. 优先级规则

从低到高的优先级顺序：

1. 项目层
2. 用户层
3. 工作区层

简写为：

> **project < user < workspace**

规则：

- 后置层会覆盖前置层中相同路径的字段
- 缺失字段会回退到更低优先级的层
- 更高优先级层中的非法配置必须直接校验失败，而不是静默回退
- 运行时必须将最终解析结果以 `ResolvedConfig` 形式暴露出来

---

## 5. 环境变量占位符

环境变量**不是第四层配置**。

它们只用于：

- API key
- token / secret
- 敏感 endpoint / 凭据
- 可选的启动参数值（例如自定义配置路径）

### 5.1 占位符语法

JSON 可以通过占位符引用环境变量值：

```json
{
  "llm": {
    "providers": {
      "openai": {
        "apiKey": "${env:OPENAI_API_KEY}"
      }
    }
  }
}
```

建议的 v1 语法：

- `${env:VAR_NAME}`

v1 **不需要**完整的模板语言。一个明确的环境变量占位符语法就足够了。

### 5.2 解析规则

运行时会在 **JSON 合并之后、最终配置生效之前** 解析占位符。

规则：

- 未解析的占位符 => 配置错误
- 空字符串环境变量值视为显式解析值，而不是“缺失”
- 只在字符串值中解析占位符
- 解析后的敏感值不得回写到 JSON 文件
- 日志和诊断信息必须对解析后的敏感值进行脱敏

---

## 6. 运行时加载流水线

运行时加载器应执行以下流水线：

1. 读取项目配置 JSON
2. 读取用户配置 JSON
3. 读取工作区配置 JSON
4. 按优先级顺序合并
5. 使用 schema 校验合并后的原始结构
6. 解析 `${env:VAR_NAME}` 占位符
7. 构建 `ResolvedConfig`
8. 将 `ResolvedConfig` 分发给 `llm`、`tools-node`、`observer` 和应用

重要说明：

- 合并和环境变量解析必须在一个中心化加载器中完成
- 内部包不得各自独立读取配置文件或环境变量
- 运行时应同时暴露原始来源元数据与解析后的配置快照，供诊断使用

---

## 7. 工作区 ID 映射

`<workspace-id>` 应基于工作区根路径通过稳定映射生成。

要求：

- 相同工作区路径始终映射到相同 ID
- 不同工作区路径在实践中不得发生冲突
- ID 必须可安全用于文件系统

推荐模式：

- 归一化后的工作区绝对路径
- 哈希为一个稳定且简短的标识符

为了便于调试，人类可读的源路径应继续保留在元数据中。

---

## 8. 建议的顶层配置结构

精确 schema 后续可能演进，但 v1 应收敛到类似如下的结构：

```json
{
  "llm": {
    "defaultProvider": "openai",
    "defaultModel": "gpt-4.1",
    "providers": {
      "openai": {
        "apiKey": "${env:OPENAI_API_KEY}"
      }
    }
  },
  "runtime": {
    "retry": {
      "maxAttempts": 2,
      "baseDelayMs": 300,
      "maxDelayMs": 3000
    },
    "tool": {
      "timeoutMs": 120000,
      "maxConcurrency": 4,
      "allowDestructive": false,
      "pathPolicy": {
        "forbidDirectories": [
          ".git/",
          "node_modules/"
        ],
        "filenameDenyPatterns": [
          "^\\.env($|\\.)",
          "(^|/)id_rsa$"
        ]
      }
    }
  },
  "observer": {
    "enabled": true,
    "redactSecrets": true
  }
}
```

这个示例仅用于说明，并不对每个默认值做强制规定。

---

## 9. 合并语义

建议的 v1 语义：

- **对象字段**：深度合并
- **标量字段**：替换
- **数组**：默认整体替换

数组采用替换而不是合并的原因：

- 更容易理解
- 可避免 deny/allow 列表的意外重复
- 更容易调试最终生效配置

如果未来用例需要更智能的合并策略，应按字段逐项引入，而不是全局启用。

---

## 10. 校验与错误处理

以下情况必须快速失败：

- JSON 格式非法
- 未知的必需结构缺失
- 占位符语法非法
- 环境变量占位符未解析
- 更高优先级配置引入了非法数据

建议的错误分类：

- `config.parse_error`
- `config.schema_error`
- `config.placeholder_error`
- `config.env_missing`
- `config.workspace_resolution_error`

诊断信息应报告：

- 哪个文件提供了非法字段
- 字段路径
- 期望类型或规则
- 错误发生在环境变量解析之前还是之后

---

## 11. v1 非目标

v1 **不**打算提供：

- 动态远程配置服务
- 覆盖所有运行时的热重载
- JSON 内任意表达式语言
- 基于角色的多租户配置继承
- 分散在各包中的插件自定义配置文件

---

## 12. 总结

`tianji-ai` v1 使用：

- **三层 JSON 配置**来承载默认值与覆盖项
- **环境变量占位符**来承载敏感值
- **由 runtime 持有的解析流程**来生成最终生效配置

一句话概括：

> 项目默认值位于 `tianji.config.json`，用户和工作区 JSON 文件在其之上进行覆盖，最终由 runtime 将环境变量占位符解析为统一的 `ResolvedConfig`。
