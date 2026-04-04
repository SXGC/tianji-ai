import type { I18n } from '../i18n/index.js'

import type { CommandDefinition } from './types.js'

/**
 * Renders the top-level CLI help text from the declarative command registry.
 *
 * @param commands - All top-level commands
 * @param i18n - Active translator
 * @param version - CLI version string
 * @returns The full help text
 */
export function renderHelp(
  commands: readonly CommandDefinition[],
  i18n: I18n,
  version: string
): string {
  const lines: string[] = [`tianji v${version}`, '', i18n.t('help.usage_header'), '']

  for (const command of commands) {
    lines.push(`  ${formatCommandUsage(command)}`, `    ${i18n.t(command.description)}`)
  }

  lines.push(
    '',
    i18n.t('help.global_flags_header'),
    `  -h, --help       ${i18n.t('help.flag.help')}`,
    `  -V, --version    ${i18n.t('help.flag.version')}`
  )

  return lines.join('\n')
}

/**
 * Renders the arguments section for a command.
 *
 * @param args - Command argument definitions
 * @param i18n - Active translator
 * @returns Lines for the arguments section
 */
function renderArgsSection(args: NonNullable<CommandDefinition['args']>, i18n: I18n): string[] {
  return args.map((arg) => `  <${arg.name}>  ${i18n.t(arg.description)}`)
}

/**
 * Renders the options/flags section for a command.
 *
 * @param options - Command option definitions
 * @param i18n - Active translator
 * @returns Lines for the options section, including the section header
 */
function renderOptionsSection(
  options: NonNullable<CommandDefinition['options']>,
  i18n: I18n
): string[] {
  const lines: string[] = ['', i18n.t('help.global_flags_header')]
  for (const option of options) {
    const flags = option.short === undefined ? option.long : `${option.short}, ${option.long}`
    lines.push(`  ${flags}  ${i18n.t(option.description)}`)
  }
  return lines
}

/**
 * Renders the subcommands section for a command.
 *
 * @param subcommands - Subcommand definitions
 * @param i18n - Active translator
 * @returns Lines for the subcommands section, including the section header
 */
function renderSubcommandsSection(
  subcommands: NonNullable<CommandDefinition['subcommands']>,
  i18n: I18n
): string[] {
  const lines: string[] = ['', i18n.t('help.subcommands_header')]
  for (const subcommand of subcommands) {
    lines.push(`  ${subcommand.name}`, `    ${i18n.t(subcommand.description)}`)
    if (subcommand.options !== undefined) {
      for (const option of subcommand.options) {
        const flags = option.short === undefined ? option.long : `${option.short}, ${option.long}`
        lines.push(`    ${flags}  ${i18n.t(option.description)}`)
      }
    }
  }
  return lines
}

/**
 * Renders help for a single command, including its arguments, options, and subcommands.
 *
 * @param command - The command to describe
 * @param i18n - Active translator
 * @returns The command-specific help text
 */
export function renderCommandHelp(command: CommandDefinition, i18n: I18n): string {
  const lines: string[] = [i18n.t('help.usage_header'), `  ${formatCommandUsage(command)}`]

  if (command.args !== undefined && command.args.length > 0) {
    lines.push(...renderArgsSection(command.args, i18n))
  }

  if (command.options !== undefined && command.options.length > 0) {
    lines.push(...renderOptionsSection(command.options, i18n))
  }

  if (command.subcommands !== undefined && command.subcommands.length > 0) {
    lines.push(...renderSubcommandsSection(command.subcommands, i18n))
  }

  return lines.join('\n')
}

function formatCommandUsage(command: CommandDefinition): string {
  const args = command.args?.map((arg) => `<${arg.name}>`) ?? []
  if (command.subcommands !== undefined && command.subcommands.length > 0) {
    return `tianji ${command.name} <subcommand>`
  }

  const argsSuffix = args.length > 0 ? ` ${args.join(' ')}` : ''
  return `tianji ${command.name}${argsSuffix}`
}
