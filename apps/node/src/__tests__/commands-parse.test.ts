import { describe, expect, it } from 'vitest'

import { extractGlobalFlags, parseCommand } from '../commands/parse.js'
import { COMMAND_REGISTRY } from '../commands/registry.js'
import { createI18n } from '../i18n/index.js'

describe('extractGlobalFlags', () => {
  it('recognizes top-level help and version flags', () => {
    expect(extractGlobalFlags(['--help'])).toEqual({
      help: true,
      version: false,
      commandHelp: false,
      remaining: [],
    })

    expect(extractGlobalFlags(['-V'])).toEqual({
      help: false,
      version: true,
      commandHelp: false,
      remaining: [],
    })
  })

  it('recognizes command help when help appears after a command token', () => {
    expect(extractGlobalFlags(['run', '--help'])).toEqual({
      help: false,
      version: false,
      commandHelp: true,
      remaining: ['run'],
    })
  })
})

describe('parseCommand', () => {
  it('parses run prompt positional argument', () => {
    const result = parseCommand(['run', 'hello'], COMMAND_REGISTRY, createI18n('en'))

    expect(result.command.name).toBe('run')
    expect(result.context.args).toEqual({ prompt: 'hello' })
  })

  it('parses log options and defaults follow to true', () => {
    const result = parseCommand(['log', '-n', '20'], COMMAND_REGISTRY, createI18n('en'))

    expect(result.context.options).toEqual({
      follow: true,
      lines: 20,
    })
  })

  it('parses register url positional argument', () => {
    const result = parseCommand(
      ['register', 'http://127.0.0.1:3000/register?enrollment-token=test-token'],
      COMMAND_REGISTRY,
      createI18n('en')
    )

    expect(result.command.name).toBe('register')
    expect(result.context.args).toEqual({
      url: 'http://127.0.0.1:3000/register?enrollment-token=test-token',
    })
  })

  it('rejects unknown commands with translated usage hint', () => {
    expect(() => parseCommand(['wat'], COMMAND_REGISTRY, createI18n('en'))).toThrow(
      /Unknown command "wat"/i
    )
  })
})
