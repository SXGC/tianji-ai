import { describe, expect, it } from 'vitest'

import { getUserConfigPaths } from '../config.js'

describe('CLI config bootstrap', () => {
  it('re-exports user config paths from agent package', () => {
    const paths = getUserConfigPaths()

    expect(paths.configDir).toContain('.config/tianji-ai')
    expect(paths.agentsDir).toContain('.config/tianji-ai/agents')
    expect(paths.logsDir).toContain('.config/tianji-ai/logs')
    expect(paths.configFilePath).toContain('.config/tianji-ai/tianji.json')
    expect(paths.cliLogFilePath).toContain('.config/tianji-ai/logs/tianji.log')
  })
})
