import { runCli } from './main.js'

/**
 * Runs the compiled CLI entrypoint and transfers the returned exit code onto
 * the current Node.js process.
 */
async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2))
}

try {
  await main()
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exitCode = 1
}
