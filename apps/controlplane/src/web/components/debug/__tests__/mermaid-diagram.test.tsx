/** @vitest-environment jsdom */
import { render } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg data-testid="mock-svg">diagram</svg>' }),
  },
}))

import mermaid from 'mermaid'
import { MermaidDiagram } from '../mermaid-diagram.js'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('MermaidDiagram', () => {
  test('挂载后调用 mermaid.render 并注入 SVG', async () => {
    const { container } = render(<MermaidDiagram diagram={'flowchart TD\n  A-->B'} />)

    await vi.waitFor(() => {
      expect(mermaid.render).toHaveBeenCalledOnce()
      expect(mermaid.render).toHaveBeenCalledWith(
        expect.stringContaining('mermaid-'),
        'flowchart TD\n  A-->B'
      )
      expect(container.querySelector('[data-testid="mock-svg"]')).not.toBeNull()
    })
  })

  test('diagram 更新时重新渲染', async () => {
    const { rerender } = render(<MermaidDiagram diagram={'flowchart TD\n  A-->B'} />)
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(1))

    rerender(<MermaidDiagram diagram={'flowchart TD\n  C-->D'} />)
    await vi.waitFor(() => expect(mermaid.render).toHaveBeenCalledTimes(2))
  })
})
