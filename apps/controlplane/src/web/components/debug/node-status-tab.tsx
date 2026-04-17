import type { JSX } from 'react'
import { useEffect, useState } from 'react'

import { type DebugNodeDto, fetchDebugNodes } from '../../services/debug-api.js'
import { useDebugStore } from '../../stores/debug-store.js'

const REFRESH_INTERVAL_MS = 5000

/**
 * 节点状态 Tab，仅当 panelOpen && tab === 'nodes' 时激活。
 *
 * 激活时立即拉取一次 /api/debug/nodes，随后每 5 秒刷新。
 * 切换 Tab / 关闭面板 / 组件卸载自动清理定时器，避免后台持续轮询。
 */
export function NodeStatusTab(): JSX.Element {
  const active = useDebugStore((s) => s.panelOpen && s.tab === 'nodes')
  const [nodes, setNodes] = useState<DebugNodeDto[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!active) return
    let cancelled = false

    async function tick(): Promise<void> {
      try {
        const data = await fetchDebugNodes()
        if (!cancelled) {
          setNodes(data)
          setError(null)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'unknown')
      }
    }

    void tick()
    const id = setInterval(() => {
      void tick()
    }, REFRESH_INTERVAL_MS)

    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [active])

  return (
    <div style={{ padding: 8, overflow: 'auto', height: '100%' }}>
      {error !== null && (
        <div role="alert" style={{ background: '#5a1f1f', color: '#fff', padding: 6 }}>
          加载失败：{error}
        </div>
      )}
      {nodes.map((n) => (
        <div
          key={n.nodeId}
          style={{
            border: '1px solid #333',
            borderRadius: 6,
            padding: 8,
            marginBottom: 8,
            fontSize: 12,
            fontFamily: 'monospace',
          }}
        >
          <div style={{ fontWeight: 'bold' }}>{n.nodeId}</div>
          <div>
            状态：{n.status} · 执行：{n.executionState}
          </div>
          <div>注册：{n.registeredAt}</div>
          <div>最后心跳：{n.lastHeartbeatAt ?? '-'}</div>
          <div>Agents：</div>
          <ul style={{ margin: '4px 0 0 16px' }}>
            {n.agents.map((a) => (
              <li key={a.agentId}>
                {a.agentId} · {a.name} · {a.type} · {a.version}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}
