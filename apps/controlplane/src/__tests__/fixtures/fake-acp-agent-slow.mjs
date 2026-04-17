#!/usr/bin/env node

/**
 * 慢速 fake ACP agent，用于 cancel e2e 测试。
 *
 * session/prompt 发出第一条 text chunk 后永远挂起（30 秒），
 * 只能被 SIGTERM 或 stdin 关闭中止。
 * 配合 node 侧的 cancel 链路测试：disconnect() → SIGTERM → 进程退出 → runner 退出。
 */

import readline from 'node:readline'

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
})

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

/** 当前 pending prompt 的 abort controller，SIGTERM 时用于提前结束计时器 */
let pendingController = null

process.on('SIGTERM', () => {
  pendingController?.abort()
  process.exit(0)
})

rl.on('line', (line) => {
  if (!line.trim()) {
    return
  }

  const message = JSON.parse(line)

  if (message.method === 'initialize') {
    write({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
      },
    })
    return
  }

  if (message.method === 'session/new') {
    write({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        sessionId: 'fake-slow-session-1',
      },
    })
    return
  }

  if (message.method === 'session/prompt') {
    // 立即发第一条 text chunk，确保 TaskStarted + MessageStarted 事件已流出
    write({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'fake-slow-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'working...' },
        },
      },
    })

    // 永不返回 result，挂起 30 秒或直到 SIGTERM
    const controller = new AbortController()
    pendingController = controller

    new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingController = null
        resolve()
      }, 30_000)
      controller.signal.addEventListener('abort', () => {
        clearTimeout(timer)
        resolve()
      })
    }).then(() => {
      // 超时或被 abort 都不发 result，让外部 disconnect / SIGTERM 触发退出
    })

    // 注意：不返回 result，即 session/prompt 响应永远不发出
    // 这是故意的：测试 cancel 链路
  }
})

// stdin 关闭时退出
rl.on('close', () => {
  pendingController?.abort()
  process.exit(0)
})
