#!/usr/bin/env node

import readline from 'node:readline'

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
})

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

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
        sessionId: 'fake-session-1',
      },
    })
    return
  }

  if (message.method === 'session/prompt') {
    write({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: 'fake-session-1',
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'done' },
        },
      },
    })

    write({
      jsonrpc: '2.0',
      id: message.id,
      result: {},
    })
  }
})
