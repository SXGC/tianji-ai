export interface TaskStreamHandlers {
  readonly onSessionAttached: (sessionId: string) => void
  readonly onMessageDelta: (delta: string) => void
  readonly onDone: () => void
  readonly onError: () => void
}

/**
 * 订阅 task SSE，并将生命周期与消息增量映射为前端回调。
 */
export function streamTask(taskId: string, handlers: TaskStreamHandlers): () => void {
  const eventSource = new EventSource(`/api/ui/tasks/${encodeURIComponent(taskId)}/stream`)

  eventSource.addEventListener('task.lifecycle', (event) => {
    const data = JSON.parse((event as MessageEvent).data) as {
      payload?: {
        type?: string
        sessionId?: string
      }
    }

    if (
      data.payload?.type === 'task.session.attached' &&
      typeof data.payload.sessionId === 'string'
    ) {
      handlers.onSessionAttached(data.payload.sessionId)
    }
  })

  eventSource.addEventListener('agent.message.delta', (event) => {
    const data = JSON.parse((event as MessageEvent).data) as {
      payload?: {
        event?: {
          payload?: {
            content?: string
          }
        }
      }
    }

    if (typeof data.payload?.event?.payload?.content === 'string') {
      handlers.onMessageDelta(data.payload.event.payload.content)
    }
  })

  eventSource.addEventListener('done', () => {
    handlers.onDone()
    eventSource.close()
  })

  eventSource.onerror = () => {
    handlers.onError()
    eventSource.close()
  }

  return () => {
    eventSource.close()
  }
}
