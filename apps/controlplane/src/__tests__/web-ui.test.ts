import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * web-ui 路由依赖 process.cwd() 解析 dist/web 和 src/web 目录。
 * 这里用 vi.mock + 临时目录来控制文件系统行为。
 */

let tempDir: string

beforeEach(() => {
  tempDir = join(tmpdir(), `web-ui-test-${Date.now()}`)
  mkdirSync(tempDir, { recursive: true })
})

afterEach(() => {
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

/**
 * 动态导入 web-ui 模块并覆盖 process.cwd()，使其指向临时目录。
 */
async function loadRouteWithCwd(cwd: string) {
  vi.spyOn(process, 'cwd').mockReturnValue(cwd)
  // 每次需要重新加载模块以使新的 cwd 生效
  vi.resetModules()
  const mod = await import('../routes/web-ui.js')
  return mod.createWebUiRoute()
}

describe('web-ui route', () => {
  it('returns 503 when no web files exist', async () => {
    const app = await loadRouteWithCwd(tempDir)
    const res = await app.request('http://localhost/')
    expect(res.status).toBe(503)
    expect(await res.text()).toBe('Controlplane web UI is not built')
  })

  it('serves index.html from dist/web at root path', async () => {
    const distDir = join(tempDir, 'dist/web')
    mkdirSync(distDir, { recursive: true })
    writeFileSync(join(distDir, 'index.html'), '<html><div id="root"></div></html>')

    const app = await loadRouteWithCwd(tempDir)
    const res = await app.request('http://localhost/')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('<div id="root"></div>')
  })

  it('serves index.html from src/web when dist is missing', async () => {
    const srcDir = join(tempDir, 'src/web')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'index.html'), '<html>src version</html>')

    const app = await loadRouteWithCwd(tempDir)
    const res = await app.request('http://localhost/')

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('src version')
  })

  it('prefers dist/web over src/web', async () => {
    const distDir = join(tempDir, 'dist/web')
    const srcDir = join(tempDir, 'src/web')
    mkdirSync(distDir, { recursive: true })
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(distDir, 'index.html'), '<html>dist</html>')
    writeFileSync(join(srcDir, 'index.html'), '<html>src</html>')

    const app = await loadRouteWithCwd(tempDir)
    const res = await app.request('http://localhost/')

    expect(res.status).toBe(200)
    expect(await res.text()).toContain('dist')
  })

  it('serves JS files with correct content type', async () => {
    const distDir = join(tempDir, 'dist/web/assets')
    mkdirSync(distDir, { recursive: true })
    writeFileSync(join(distDir, 'main.js'), 'console.log("hello")')

    const app = await loadRouteWithCwd(tempDir)
    const res = await app.request('http://localhost/assets/main.js')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/javascript')
  })

  it('serves CSS files with correct content type', async () => {
    const distDir = join(tempDir, 'dist/web/assets')
    mkdirSync(distDir, { recursive: true })
    writeFileSync(join(distDir, 'style.css'), 'body { color: red; }')

    const app = await loadRouteWithCwd(tempDir)
    const res = await app.request('http://localhost/assets/style.css')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/css')
  })

  it('falls back to index.html for SPA routes when specific file not found', async () => {
    const distDir = join(tempDir, 'dist/web')
    mkdirSync(distDir, { recursive: true })
    writeFileSync(join(distDir, 'index.html'), '<html>SPA shell</html>')

    const app = await loadRouteWithCwd(tempDir)
    const res = await app.request('http://localhost/dashboard/tasks')

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('SPA shell')
  })

  it('returns 404 for /api/ prefixed paths', async () => {
    const distDir = join(tempDir, 'dist/web')
    mkdirSync(distDir, { recursive: true })
    writeFileSync(join(distDir, 'index.html'), '<html></html>')

    const app = await loadRouteWithCwd(tempDir)
    const res = await app.request('http://localhost/api/unknown')

    expect(res.status).toBe(404)
  })

  it('serves files from src/web for non-root paths', async () => {
    const srcDir = join(tempDir, 'src/web')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'main.tsx'), 'export default function App() {}')

    // 需要 index.html 存在于 src/web 以作为 fallback（但这里直接访问 main.tsx）
    const app = await loadRouteWithCwd(tempDir)
    const res = await app.request('http://localhost/main.tsx')

    // .tsx 文件不匹配 .js/.css，所以 content-type 默认为 text/html
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
  })
})
