import { runCli } from './main.js'
import { createControlPlaneRuntime } from './node-runtime/controlplane-runtime.js'
import { readControlPlaneRuntimeConfigFromEnv } from './node-runtime/env-config.js'

/**
 * Runs the compiled CLI entrypoint and transfers the returned exit code onto
 * the current Node.js process.
 */
async function main(): Promise<void> {
  const controlPlaneConfig = readControlPlaneRuntimeConfigFromEnv()
  if (controlPlaneConfig !== null && process.argv.length <= 2) {
    const runtime = createControlPlaneRuntime(controlPlaneConfig)
    await runtime.connection.start()
    process.on('SIGTERM', () => runtime.connection.stop())
    process.on('SIGINT', () => runtime.connection.stop())
    await new Promise(() => undefined)
  }

  process.exitCode = await runCli(process.argv.slice(2))
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exitCode = 1
})
