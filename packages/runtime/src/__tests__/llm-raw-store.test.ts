import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { type LlmRawRecord, LlmRawStore } from '../llm-raw-store.js'

describe('LlmRawStore', () => {
  let testDir: string

  afterEach(async () => {
    if (testDir !== undefined) {
      await rm(testDir, { recursive: true, force: true })
    }
  })

  it('write 在 raws/ 子目录下创建 llm_{runId}.json', async () => {
    testDir = join(tmpdir(), `llm-raw-test-${Date.now()}`)
    const store = new LlmRawStore(testDir)

    const record: LlmRawRecord = {
      runId: 'run_abc123',
      sessionId: 'sess_xyz',
      createdAt: 1712544000000,
      calls: [
        {
          index: 0,
          request: {
            model: 'gpt-4',
            systemPrompt: 'hello',
            messages: [],
            tools: [],
          },
          response: {
            content: 'Hi!',
            toolCalls: [],
          },
        },
      ],
    }

    await store.write(record)

    const content = await readFile(join(testDir, 'raws', 'llm_run_abc123.json'), 'utf8')
    const parsed = JSON.parse(content)
    expect(parsed.runId).toBe('run_abc123')
    expect(parsed.calls[0].request.model).toBe('gpt-4')
    expect(parsed.calls[0].response.content).toBe('Hi!')
  })

  it('write 同一 runId 覆盖已有文件', async () => {
    testDir = join(tmpdir(), `llm-raw-ow-${Date.now()}`)
    const store = new LlmRawStore(testDir)

    const baseRecord: LlmRawRecord = {
      runId: 'run_ow',
      sessionId: 's1',
      createdAt: 1000,
      calls: [],
    }

    await store.write({ ...baseRecord, createdAt: 1000 })
    await store.write({ ...baseRecord, createdAt: 2000 })

    const content = await readFile(join(testDir, 'raws', 'llm_run_ow.json'), 'utf8')
    expect(JSON.parse(content).createdAt).toBe(2000)
  })

  it('write 空目录自动创建', async () => {
    testDir = join(tmpdir(), `llm-raw-mkdir-${Date.now()}`)
    const store = new LlmRawStore(testDir)

    await store.write({
      runId: 'run_mkdir',
      sessionId: 's1',
      createdAt: 1000,
      calls: [],
    })

    const content = await readFile(join(testDir, 'raws', 'llm_run_mkdir.json'), 'utf8')
    expect(JSON.parse(content).runId).toBe('run_mkdir')
  })
})
