import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages'
import { describe, expect, it } from 'vitest'
import { LlmCallRecorder, createRecordingMiddleware } from '../llm-call-recorder.js'
import { LlmRawStore } from '../llm-raw-store.js'

/**
 * 构造一个最小可用的 ModelRequest 对象。
 */
function makeModelRequest(overrides: Record<string, unknown> = {}) {
  return {
    model: {
      lc: [1, 2],
      _llmType: () => 'openai',
      modelName: 'gpt-4',
    },
    messages: [],
    systemPrompt: '',
    systemMessage: new SystemMessage(''),
    tools: [],
    state: {},
    runtime: {},
    ...overrides,
  }
}

describe('LlmCallRecorder', () => {
  it('recordCall 按序记录 request 和 response', () => {
    const recorder = new LlmCallRecorder()
    recorder.recordCall(
      makeModelRequest({
        systemPrompt: 'test',
        systemMessage: new SystemMessage('test'),
      }),
      new AIMessage({ content: 'Hello!' })
    )

    const calls = recorder.getCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0].index).toBe(0)
    expect(calls[0].request.systemPrompt).toBe('test')
    expect(calls[0].response.content).toBe('Hello!')
  })

  it('多次调用 index 递增', () => {
    const recorder = new LlmCallRecorder()
    recorder.recordCall(makeModelRequest(), new AIMessage({ content: 'a' }))
    recorder.recordCall(makeModelRequest(), new AIMessage({ content: 'b' }))

    expect(recorder.getCalls().map((c) => c.index)).toEqual([0, 1])
  })

  it('toRecord 生成完整 LlmRawRecord', () => {
    const recorder = new LlmCallRecorder()
    recorder.recordCall(makeModelRequest(), new AIMessage({ content: 'x' }))

    const record = recorder.toRecord('run_1', 'sess_1')
    expect(record.runId).toBe('run_1')
    expect(record.sessionId).toBe('sess_1')
    expect(record.createdAt).toBeGreaterThan(0)
    expect(record.calls).toHaveLength(1)
  })

  it('无调用时 toRecord 返回空 calls', () => {
    const recorder = new LlmCallRecorder()
    expect(recorder.toRecord('r', 's').calls).toHaveLength(0)
  })

  it('序列化 tool_calls', () => {
    const recorder = new LlmCallRecorder()
    recorder.recordCall(
      makeModelRequest(),
      new AIMessage({
        content: '',
        tool_calls: [{ id: 'c1', name: 'read_file', args: { path: '/a' } }],
      })
    )

    const tc = recorder.getCalls()[0].response.toolCalls
    expect(tc).toHaveLength(1)
    expect(tc[0].name).toBe('read_file')
    expect(tc[0].args).toEqual({ path: '/a' })
  })

  it('序列化 usage_metadata', () => {
    const recorder = new LlmCallRecorder()
    recorder.recordCall(
      makeModelRequest(),
      new AIMessage({
        content: 'hi',
        usage_metadata: {
          input_tokens: 100,
          output_tokens: 50,
          total_tokens: 150,
        },
      })
    )

    const usage = recorder.getCalls()[0].response.usageMetadata
    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    })
  })

  it('序列化 messages 中的 HumanMessage', () => {
    const recorder = new LlmCallRecorder()
    recorder.recordCall(
      makeModelRequest({
        messages: [new HumanMessage('hello world')],
      }),
      new AIMessage({ content: 'response' })
    )

    const msg = recorder.getCalls()[0].request.messages[0]
    expect(msg.role).toBe('human')
    expect(msg.content).toBe('hello world')
  })

  it('序列化 ToolMessage 带 toolCallId', () => {
    const recorder = new LlmCallRecorder()
    recorder.recordCall(
      makeModelRequest({
        messages: [
          new ToolMessage({
            content: 'file content',
            tool_call_id: 'tc_1',
          }),
        ],
      }),
      new AIMessage({ content: 'done' })
    )

    const msg = recorder.getCalls()[0].request.messages[0]
    expect(msg.role).toBe('tool')
    expect(msg.toolCallId).toBe('tc_1')
  })

  it('从 model 对象提取 modelName', () => {
    const recorder = new LlmCallRecorder()
    recorder.recordCall(
      makeModelRequest({
        model: { modelName: 'claude-3.5-sonnet', lc: [] },
      }),
      new AIMessage({ content: 'ok' })
    )

    expect(recorder.getCalls()[0].request.model).toBe('claude-3.5-sonnet')
  })

  it('从 model 字符串直接提取', () => {
    const recorder = new LlmCallRecorder()
    recorder.recordCall(
      makeModelRequest({
        model: 'gpt-4o',
      }),
      new AIMessage({ content: 'ok' })
    )

    expect(recorder.getCalls()[0].request.model).toBe('gpt-4o')
  })
})

describe('LlmCallRecorder + LlmRawStore 集成', () => {
  it('recorder 产出可被 store 正确写入和读取', async () => {
    const testDir = join(tmpdir(), `llm-int-${Date.now()}`)
    const store = new LlmRawStore(testDir)
    const recorder = new LlmCallRecorder()

    recorder.recordCall(
      makeModelRequest({
        systemPrompt: 'integration',
        systemMessage: new SystemMessage('integration'),
      }),
      new AIMessage({ content: 'resp' })
    )

    await store.write(recorder.toRecord('run_int', 'sess_int'))

    const written = JSON.parse(await readFile(join(testDir, 'raws', 'llm_run_int.json'), 'utf8'))
    expect(written.calls[0].request.systemPrompt).toBe('integration')
    expect(written.calls[0].response.content).toBe('resp')

    await rm(testDir, { recursive: true, force: true })
  })
})

describe('createRecordingMiddleware', () => {
  it('返回带 name 和 wrapModelCall 的 middleware 对象', () => {
    const recorder = new LlmCallRecorder()
    const middleware = createRecordingMiddleware(recorder)

    expect(middleware.name).toBe('tianji-llm-call-recorder')
    expect(typeof middleware.wrapModelCall).toBe('function')
  })

  it('wrapModelCall 调用 handler 后记录 request/response', async () => {
    const recorder = new LlmCallRecorder()
    const middleware = createRecordingMiddleware(recorder)
    const request = makeModelRequest({ systemPrompt: 'mid-test' })
    const fakeResponse = new AIMessage({ content: 'from handler' })

    const result = await middleware.wrapModelCall!(request, async () => fakeResponse)

    expect(result).toBe(fakeResponse)
    expect(recorder.getCalls()).toHaveLength(1)
    expect(recorder.getCalls()[0].request.systemPrompt).toBe('mid-test')
    expect(recorder.getCalls()[0].response.content).toBe('from handler')
  })
})
