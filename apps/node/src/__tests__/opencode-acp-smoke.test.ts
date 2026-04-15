/**
 * Smoke test: tianji Node 通过 ACP 协议调用 OpenCode。
 *
 * 仅在 SMOKE_E2E=1 时运行。验证完整的 ACP 生命周期：
 * spawn opencode acp → initialize → session/new → prompt → 接收事件 → disconnect。
 */
import { describe, expect, it } from 'vitest'

import { AgentRunner } from '../acp/agent-runner.js'

describe('ACP → OpenCode smoke', () => {
  it('completes a full ACP round-trip with opencode acp', async () => {
    if (process.env.SMOKE_E2E !== '1') {
      return
    }

    const runner = new AgentRunner({
      agentId: 'opencode-smoke',
      command: 'opencode',
      args: ['acp'],
    })

    const events: string[] = []

    try {
      await runner.connect()

      for await (const event of runner.query('Say exactly: __ACP_SMOKE_OK__')) {
        events.push(event.type)

        if (event.type === 'MessageDelta' && event.channel === 'text') {
          if (event.payload.content.includes('__ACP_SMOKE_OK__')) {
            break
          }
        }
      }
    } finally {
      await runner.disconnect()
    }

    expect(events.length).toBeGreaterThan(0)
    expect(events).toContain('MessageDelta')
  }, 30_000)
})
