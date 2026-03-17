# @tianji/llm

`tianji-ai` 的 LLM 接入层，提供与模型供应商无关的网关抽象与流式接口。

## 包职责

`@tianji/llm` 将各个模型供应商 SDK 的细节封装在统一网关契约之后，对上层暴露稳定的请求构造、流式输出、工具执行桥接和用量/成本收集能力，同时把供应商特定初始化逻辑隔离在工厂函数内部。

当前支持的供应商为 `openai`、`anthropic` 和 `google`。

## 当前公开内容

- 核心网关接口：`LlmGateway`、`LlmRequest`、`LlmResponse`、`LlmStream`、`LlmStreamEvent`
- 供应商与配置类型：`LlmProvider`、`LlmProviderConfig`、`LlmGenerationConfig`、`LlmUsage`、`LlmCost`
- 供应商工厂：`createLlmGateway`、`createOpenAIGateway`、`createAnthropicGateway`、`createGoogleGateway`
- 辅助导出：`ConversionError`、`ToolSchemaError`、`collectLlmUsage`

## 使用示例

```ts
import { createLlmGateway } from '@tianji/llm'
import { createRunId, type AppMessage } from '@tianji/contracts'

const gateway = createLlmGateway({
  provider: 'openai',
  model: 'gpt-4.1',
  apiKey: process.env.OPENAI_API_KEY,
})

const messages: AppMessage[] = [
  {
    id: 'msg_123',
    role: 'user',
    content: [{ type: 'text', text: 'Summarize this repository.' }],
    createdAt: Date.now(),
  },
]

const response = await gateway.generate({
  runId: createRunId('run_123'),
  messages,
})

console.log(response.content)
```

## 开发命令

在仓库根目录执行：

```bash
pnpm --filter @tianji/llm build
pnpm --filter @tianji/llm typecheck
pnpm --filter @tianji/llm test
pnpm --filter @tianji/llm clean
```

## 开源协议

MIT
