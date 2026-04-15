/**
 * foundation wave 6 依赖边界验证测试。
 *
 * 业务职责：
 * - 校验 shared、observer、runtime 三个内部包之间的依赖约束。
 * - 防止内部包图出现循环依赖，保证分层稳定。
 *
 * 对外触点：
 * - 读取各包 package.json 声明。
 * - 通过本地图遍历验证 @tianji/* 依赖关系。
 */
import { describe, expect, it } from 'vitest'

interface PackageJson {
  readonly name?: string
  readonly dependencies?: Record<string, string>
}

interface PackageNode {
  readonly name: string
  readonly dependencies: readonly string[]
}

async function loadPackageJson(relativePath: string): Promise<PackageJson> {
  const module = (await import(relativePath, {
    assert: { type: 'json' },
  })) as { default: PackageJson }

  return module.default
}

function findCycle(nodes: readonly PackageNode[]): readonly string[] | undefined {
  const edges = new Map(nodes.map((node) => [node.name, [...node.dependencies]]))
  const visiting = new Set<string>()
  const visited = new Set<string>()

  function visit(nodeName: string, trail: readonly string[]): readonly string[] | undefined {
    if (visiting.has(nodeName)) {
      const cycleStart = trail.indexOf(nodeName)
      return [...trail.slice(cycleStart), nodeName]
    }

    if (visited.has(nodeName)) {
      return undefined
    }

    visiting.add(nodeName)

    for (const dependency of edges.get(nodeName) ?? []) {
      const cycle = visit(dependency, [...trail, dependency])

      if (cycle !== undefined) {
        return cycle
      }
    }

    visiting.delete(nodeName)
    visited.add(nodeName)
    return undefined
  }

  for (const node of nodes) {
    const cycle = visit(node.name, [node.name])

    if (cycle !== undefined) {
      return cycle
    }
  }

  return undefined
}

describe('foundation wave 6 verification', () => {
  it('preserves dependency constraints across shared, observer, and runtime', async () => {
    const [sharedPkg, observerPkg, runtimePkg] = await Promise.all([
      loadPackageJson('../../../shared/package.json'),
      loadPackageJson('../../../observer/package.json'),
      loadPackageJson('../../package.json'),
    ])

    const sharedDependencies = Object.keys(sharedPkg.dependencies ?? {})
    const observerDependencies = Object.keys(observerPkg.dependencies ?? {})
    const runtimeDependencies = Object.keys(runtimePkg.dependencies ?? {})

    // shared 是根节点，不能依赖任何内部包
    expect(sharedDependencies.filter((dependency) => dependency.startsWith('@tianji/'))).toEqual([])
    // observer 只能依赖 shared（Stage 06 引入 DomainEventEnvelope），不能依赖 runtime
    const observerInternalDeps = observerDependencies.filter((dependency) =>
      dependency.startsWith('@tianji/')
    )
    expect(observerInternalDeps).not.toContain('@tianji/runtime')
    expect(observerInternalDeps.every((dep) => dep === '@tianji/shared')).toBe(true)
    expect(runtimeDependencies).toContain('@langchain/core')
    expect(runtimeDependencies).toContain('deepagents')
    expect(runtimeDependencies).toContain('@tianji/shared')
    expect(runtimeDependencies).toContain('@tianji/observer')
  })

  it('keeps the internal package dependency graph acyclic', async () => {
    const [sharedPkg, observerPkg, runtimePkg] = await Promise.all([
      loadPackageJson('../../../shared/package.json'),
      loadPackageJson('../../../observer/package.json'),
      loadPackageJson('../../package.json'),
    ])

    const packageNodes: PackageNode[] = [sharedPkg, observerPkg, runtimePkg].map((pkg) => ({
      name: pkg.name ?? 'unknown-package',
      dependencies: Object.keys(pkg.dependencies ?? {}).filter((dependency) =>
        dependency.startsWith('@tianji/')
      ),
    }))

    expect(findCycle(packageNodes)).toBeUndefined()
  })
})
