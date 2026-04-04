import type { I18n } from '../i18n/index.js'

import { findCommand } from './registry.js'
import type {
  CliDependencies,
  CommandDefinition,
  OptionDefinition,
  ParsedCommandResult,
} from './types.js'

class CliUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliUsageError'
  }
}

/**
 * 全局 flag 提取规则：
 * - `tianji --help` / `tianji -h` / `tianji help` -> 全局帮助
 * - `tianji --version` / `tianji -V` -> 版本号，任意位置优先级最高
 * - `tianji <command> --help` -> 命令级帮助
 * - `tianji help <command>` -> 等价于 `tianji <command> --help`
 */
export function extractGlobalFlags(argv: readonly string[]): {
  help: boolean
  version: boolean
  commandHelp: boolean
  remaining: string[]
} {
  if (argv.includes('--version') || argv.includes('-V')) {
    return { help: false, version: true, commandHelp: false, remaining: [] }
  }

  if (argv.length >= 1 && (argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help')) {
    if (argv[0] === 'help' && argv.length > 1) {
      return { help: false, version: false, commandHelp: true, remaining: argv.slice(1) }
    }

    return { help: true, version: false, commandHelp: false, remaining: [] }
  }

  const remaining = argv.filter((arg) => arg !== '--help' && arg !== '-h')
  const commandHelp = remaining.length !== argv.length

  return {
    help: false,
    version: false,
    commandHelp,
    remaining,
  }
}

/**
 * Parses argv into a command definition plus normalized args/options.
 *
 * @param argv - argv after global flags are removed
 * @param commands - top-level command registry
 * @param i18n - active translator
 * @param deps - optional injectable CLI dependencies
 * @returns The matched command and execution context
 */
export function parseCommand(
  argv: readonly string[],
  commands: readonly CommandDefinition[],
  i18n: I18n,
  deps?: CliDependencies
): ParsedCommandResult {
  const [commandName, ...restArgs] = argv
  if (commandName === undefined) {
    throw new CliUsageError(i18n.t('error.missing_command'))
  }

  const command = findCommand(commands, commandName)
  if (command === undefined) {
    throw new CliUsageError(
      `${i18n.t('error.unknown_command', { command: commandName })} ${i18n.t('error.run_help_hint')}`
    )
  }

  if (command.subcommands !== undefined) {
    return parseSubcommand(command, restArgs, i18n, deps)
  }

  const { args, options } = parseArgsAndOptions(restArgs, command.options ?? [], i18n)
  const positionalArgDefs = command.args ?? []
  const parsedArgs = assignArguments(positionalArgDefs, args, i18n)

  return {
    command,
    context: {
      args: parsedArgs,
      options,
      i18n,
      deps,
    },
  }
}

function parseSubcommand(
  parent: CommandDefinition,
  argv: readonly string[],
  i18n: I18n,
  deps?: CliDependencies
): ParsedCommandResult {
  const [subcommandName, ...restArgs] = argv
  if (subcommandName === undefined) {
    throw new CliUsageError(i18n.t('error.missing_subcommand', { command: parent.name }))
  }

  const subcommand = findCommand(parent.subcommands ?? [], subcommandName)
  if (subcommand === undefined) {
    throw new CliUsageError(
      i18n.t('error.unknown_subcommand', {
        command: parent.name,
        subcommand: subcommandName,
      })
    )
  }

  const { args, options } = parseArgsAndOptions(restArgs, subcommand.options ?? [], i18n)
  const parsedArgs = assignArguments(subcommand.args ?? [], args, i18n)

  return {
    command: subcommand,
    context: {
      args: parsedArgs,
      options,
      i18n,
      deps,
    },
  }
}

/**
 * 构建选项标志到定义的映射，并收集默认值。
 *
 * @param definitions - 命令的选项定义列表
 * @returns 标志映射表和默认值对象
 */
function initializeOptionMap(definitions: readonly OptionDefinition[]): {
  optionByFlag: Map<string, OptionDefinition>
  defaults: Record<string, string | number | boolean>
} {
  const optionByFlag = new Map<string, OptionDefinition>()
  const defaults: Record<string, string | number | boolean> = {}
  for (const definition of definitions) {
    optionByFlag.set(definition.long, definition)
    if (definition.short !== undefined) {
      optionByFlag.set(definition.short, definition)
    }
    if (definition.default !== undefined) {
      defaults[toOptionName(definition.long)] = definition.default
    }
  }
  return { optionByFlag, defaults }
}

/**
 * 解析单个选项 token 并将结果写入 options。
 *
 * @param definition - 匹配到的选项定义
 * @param token - 当前 token（如 `--port`）
 * @param nextToken - 紧随其后的 token，用于需要值的选项
 * @param options - 待写入的选项结果对象
 * @param i18n - 翻译实例
 * @returns 消耗的额外 token 数：boolean 选项返回 0，值选项返回 1
 */
function parseOptionValue(
  definition: OptionDefinition,
  token: string,
  nextToken: string | undefined,
  options: Record<string, string | number | boolean>,
  i18n: I18n
): number {
  const optionName = toOptionName(definition.long)
  if (definition.type === 'boolean') {
    options[optionName] = true
    return 0
  }
  if (nextToken === undefined) {
    throw new CliUsageError(i18n.t('error.option_requires_value', { option: token }))
  }
  if (definition.type === 'number') {
    const parsedValue = Number.parseInt(nextToken, 10)
    if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
      throw new CliUsageError(i18n.t('error.option_invalid_number', { option: token }))
    }
    options[optionName] = parsedValue
  } else {
    options[optionName] = nextToken
  }
  return 1
}

function parseArgsAndOptions(
  argv: readonly string[],
  definitions: readonly OptionDefinition[],
  i18n: I18n
): {
  args: string[]
  options: Record<string, string | number | boolean>
} {
  const { optionByFlag, defaults } = initializeOptionMap(definitions)
  const options = { ...defaults }
  const args: string[] = []
  let index = 0

  while (index < argv.length) {
    const token = argv[index]
    if (!token.startsWith('-')) {
      args.push(token)
      index += 1
      continue
    }

    const definition = optionByFlag.get(token)
    if (definition === undefined) {
      throw new CliUsageError(i18n.t('error.unknown_option', { option: token }))
    }

    const consumed = parseOptionValue(definition, token, argv[index + 1], options, i18n)
    index += 1 + consumed
  }

  return { args, options }
}

function assignArguments(
  definitions: readonly { name: string; required: boolean }[],
  values: readonly string[],
  i18n: I18n
): Record<string, string> {
  const args: Record<string, string> = {}

  for (const [index, definition] of definitions.entries()) {
    const value = values[index]
    if (value === undefined) {
      if (definition.required) {
        throw new CliUsageError(i18n.t('error.missing_required_arg', { arg: definition.name }))
      }

      continue
    }

    args[definition.name] = value
  }

  if (values.length > definitions.length) {
    throw new CliUsageError(i18n.t('error.unexpected_args'))
  }

  return args
}

function toOptionName(longFlag: `--${string}`): string {
  return longFlag.slice(2)
}

export { CliUsageError }
