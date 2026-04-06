import { afterEach, describe, expect, it, vi } from 'vitest'

import { streamTask } from '../task-stream.js'

class MockEventSource {
  static instances: MockEventSource[] = []

  readonly listeners = new Map<string, Set<(event: MessageEvent) => void>>()
  onerror: ((event: Event) => void) | null = null
  closed = false

  constructor(readonly url: string) {
    MockEventSource.instances.push(this)
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const callback = listener
    const listeners = this.listeners.get(type) ?? new Set<(event: MessageEvent) => void>()
    listeners.add(callback)
    this.listeners.set(type, listeners)
  }

  close(): void {
    this.closed = true
  }

  emit(type: string, data: unknown): void {
    const listeners = this.listeners.get(type)
    if (listeners === undefined) {
      return
    }

    const event = { data: JSON.stringify(data) } as MessageEvent
    for (const listener of listeners) {
      listener(event)
    }
  }
}

describe('streamTask', () => {
  afterEach(() => {
    MockEventSource.instances = []
    vi.unstubAllGlobals()
  })

  it('forwards message delta content from nested runtime payload', () => {
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource)

    const onMessageDelta = vi.fn()

    streamTask('task-1', {
      onSessionAttached: vi.fn(),
      onMessageDelta,
      onDone: vi.fn(),
      onError: vi.fn(),
    })

    const source = MockEventSource.instances[0]
    expect(source).toBeDefined()

    source?.emit('agent.message.delta', {
      payload: {
        event: {
          payload: {
            content: 'Hi',
          },
        },
      },
    })

    expect(onMessageDelta).toHaveBeenCalledWith('Hi')
  })

  it('forwards task failed lifecycle errors', () => {
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource)

    const onError = vi.fn()

    streamTask('task-1', {
      onSessionAttached: vi.fn(),
      onMessageDelta: vi.fn(),
      onDone: vi.fn(),
      onError,
    })

    const source = MockEventSource.instances[0]
    expect(source).toBeDefined()

    source?.emit('task.lifecycle', {
      payload: {
        type: 'task.failed',
        error: 'executor failed',
      },
    })

    expect(onError).toHaveBeenCalledWith('executor failed')
  })

  it('forwards task cancelled lifecycle errors', () => {
    vi.stubGlobal('EventSource', MockEventSource as unknown as typeof EventSource)

    const onError = vi.fn()

    streamTask('task-1', {
      onSessionAttached: vi.fn(),
      onMessageDelta: vi.fn(),
      onDone: vi.fn(),
      onError,
    })

    const source = MockEventSource.instances[0]
    expect(source).toBeDefined()

    source?.emit('task.lifecycle', {
      payload: {
        type: 'task.cancelled',
      },
    })

    expect(onError).toHaveBeenCalledWith('任务已取消。')
  })
})
