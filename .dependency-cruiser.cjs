/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ── L0: shared 不得依赖任何其他内部包 ──
    {
      name: 'shared-no-internal-deps',
      comment: 'shared 是最底层，禁止依赖其他内部包',
      severity: 'error',
      from: { path: '^packages/shared/' },
      to: {
        path: '^(packages|apps)/',
        pathNot: '^packages/shared/',
      },
    },

    // ── L1: runtime 只能依赖 shared ──
    {
      name: 'runtime-only-depends-on-shared',
      comment: 'runtime 禁止依赖 agent、observer 和 apps',
      severity: 'error',
      from: { path: '^packages/runtime/' },
      to: { path: '^(packages/agent|packages/observer|apps)/' },
    },

    // ── L2: agent 禁止依赖 AI 框架和 apps ──
    {
      name: 'agent-no-ai-frameworks',
      comment: 'AI 框架收敛在 runtime，agent 禁止直接使用',
      severity: 'error',
      from: { path: '^packages/agent/' },
      to: {
        dependencyTypesNot: ['type-only'],
        path: 'node_modules/(ai|@ai-sdk|langchain|@langchain)',
      },
    },
    {
      name: 'agent-no-apps',
      comment: 'agent 禁止依赖 apps 层',
      severity: 'error',
      from: { path: '^packages/agent/' },
      to: { path: '^apps/' },
    },

    // ── L3: node 禁止直接依赖 runtime 和 AI 框架 ──
    {
      name: 'node-no-runtime',
      comment: 'node 通过 agent 间接使用 runtime，禁止直接依赖',
      severity: 'error',
      from: { path: '^apps/node/' },
      to: { path: '^packages/runtime/' },
    },
    {
      name: 'node-no-ai-frameworks',
      comment: 'node 层禁止直接使用 AI 框架',
      severity: 'error',
      from: { path: '^apps/node/' },
      to: {
        dependencyTypesNot: ['type-only'],
        path: 'node_modules/(ai|@ai-sdk|langchain|@langchain)',
      },
    },

    // ── 通用: 禁止循环依赖 ──
    {
      name: 'no-circular',
      comment: '禁止包间循环依赖',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: {
      path: ['dist/', '__tests__/', '\\.(test|spec)\\.ts$'],
    },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
  },
}
