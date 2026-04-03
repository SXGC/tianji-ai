import { describe, expect, it } from 'vitest'

import { renderCommandHelp, renderHelp } from '../commands/help.js'
import { COMMAND_REGISTRY } from '../commands/registry.js'
import { createI18n } from '../i18n/index.js'

describe('renderHelp', () => {
  it('renders all top-level commands and global flags', () => {
    const output = renderHelp(COMMAND_REGISTRY, createI18n('en'), '0.0.1')

    expect(output).toContain('tianji v0.0.1')
    expect(output).toContain('tianji run <prompt>')
    expect(output).toContain('tianji daemon <subcommand>')
    expect(output).toContain('-h, --help')
    expect(output).toContain('-V, --version')
  })

  it('renders chinese help with translated headers', () => {
    const output = renderHelp(COMMAND_REGISTRY, createI18n('zh-CN'), '0.0.1')

    expect(output).toContain('用法:')
    expect(output).toContain('全局选项:')
  })
})

describe('renderCommandHelp', () => {
  it('renders daemon subcommands and descriptions', () => {
    const daemon = COMMAND_REGISTRY.find((command) => command.name === 'daemon')
    expect(daemon).toBeDefined()

    const output = renderCommandHelp(daemon!, createI18n('en'))

    expect(output).toContain('Subcommands:')
    expect(output).toContain('start')
    expect(output).toContain('restart')
  })
})
