import { expect, test } from 'vitest'

import { COMMAND_REGISTRY } from '../commands/registry.js'
import type { CommandDefinition } from '../commands/types.js'
import enMessages from '../i18n/locales/en.json' with { type: 'json' }
import zhCNMessages from '../i18n/locales/zh-CN.json' with { type: 'json' }

test('zh-CN covers all english message keys', () => {
  const missingKeys = Object.keys(enMessages).filter((key) => !(key in zhCNMessages))
  expect(missingKeys).toEqual([])
})

test('command registry only references existing description keys', () => {
  const visit = (command: CommandDefinition): void => {
    expect(command.description in enMessages).toBe(true)
    for (const arg of command.args ?? []) {
      expect(arg.description in enMessages).toBe(true)
    }
    for (const option of command.options ?? []) {
      expect(option.description in enMessages).toBe(true)
    }
    for (const subcommand of command.subcommands ?? []) {
      visit(subcommand)
    }
  }

  for (const command of COMMAND_REGISTRY) {
    visit(command)
  }
})
