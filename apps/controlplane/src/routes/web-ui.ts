import { existsSync, readFileSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'

import { Hono } from 'hono'

const WEB_DIST_DIR = resolve(process.cwd(), 'dist/web')
const WEB_SRC_DIR = resolve(process.cwd(), 'src/web')

function getContentType(filePath: string): string {
  const extension = extname(filePath)

  if (extension === '.js') {
    return 'text/javascript; charset=utf-8'
  }
  if (extension === '.css') {
    return 'text/css; charset=utf-8'
  }

  return 'text/html; charset=utf-8'
}

/**
 * 从 dist/web 或 src/web 读取前端文件，优先返回构建产物。
 */
function readWebFile(relativePath: string): { content: string; contentType: string } | null {
  const normalizedPath = relativePath === '/' ? '/index.html' : relativePath
  const distPath = join(WEB_DIST_DIR, normalizedPath)
  if (existsSync(distPath)) {
    return {
      content: readFileSync(distPath, 'utf8'),
      contentType: getContentType(distPath),
    }
  }

  const srcPath = join(WEB_SRC_DIR, normalizedPath)
  if (existsSync(srcPath)) {
    return {
      content: readFileSync(srcPath, 'utf8'),
      contentType: getContentType(srcPath),
    }
  }

  return null
}

/**
 * 提供 controlplane SPA 静态资源与 fallback。
 */
export function createWebUiRoute(): Hono {
  const app = new Hono()

  app.get('*', (c) => {
    const requestPath = c.req.path
    if (requestPath.startsWith('/api/')) {
      return c.notFound()
    }

    const asset = readWebFile(requestPath)
    if (asset !== null) {
      return c.body(asset.content, 200, {
        'content-type': asset.contentType,
      })
    }

    const indexFile = readWebFile('/index.html')
    if (indexFile === null) {
      return c.text('Controlplane web UI is not built', 503)
    }

    return c.body(indexFile.content, 200, {
      'content-type': 'text/html; charset=utf-8',
    })
  })

  return app
}
