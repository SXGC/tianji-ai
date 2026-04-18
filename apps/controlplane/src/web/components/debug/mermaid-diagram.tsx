import mermaid from 'mermaid'
import type { JSX } from 'react'
import { useEffect, useId, useRef } from 'react'

mermaid.initialize({ startOnLoad: false, theme: 'dark', securityLevel: 'strict' })

interface Props {
  diagram: string
}

/** 将 mermaid 文本渲染为内联 SVG。diagram 变化时重新渲染。 */
export function MermaidDiagram({ diagram }: Props): JSX.Element {
  const rawId = useId()
  const id = `mermaid-${rawId.replace(/:/g, '')}`
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    mermaid
      .render(id, diagram)
      .then(({ svg }) => {
        if (!cancelled && ref.current !== null) {
          ref.current.innerHTML = svg
        }
      })
      .catch((err: unknown) => {
        console.error('[debug] mermaid.render failed', err)
      })
    return () => {
      cancelled = true
    }
  }, [diagram, id])

  return <div ref={ref} data-testid="mermaid-diagram" style={{ padding: 8 }} />
}
