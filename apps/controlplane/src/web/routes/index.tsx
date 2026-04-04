import { useQuery } from '@tanstack/react-query'
import { createRoute } from '@tanstack/react-router'
import { useEffect, useRef, useState } from 'react'

import { ChatShell } from '../components/chat-shell'
import type { ChatMessage } from '../components/message-list'
import { createTask, fetchNodes } from '../lib/api'
import { streamTask } from '../lib/task-stream'
import { Route as RootRoute } from './__root'

export const Route = createRoute({
  getParentRoute: () => RootRoute,
  path: '/',
  component: IndexRouteComponent,
})

export function IndexRouteComponent() {
  const { data: nodes = [], error } = useQuery({
    queryKey: ['ui-nodes'],
    queryFn: fetchNodes,
  })
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sending, setSending] = useState(false)
  const streamCleanupRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    if (selectedNodeId !== null) {
      return
    }

    const firstOnlineNode = nodes.find(
      (node) => node.status === 'online' && node.agents[0] !== undefined
    )
    if (firstOnlineNode !== undefined) {
      setSelectedNodeId(firstOnlineNode.nodeId)
      setSelectedAgentId(firstOnlineNode.agents[0]?.agentId ?? null)
    }
  }, [nodes, selectedNodeId])

  useEffect(() => {
    return () => {
      streamCleanupRef.current?.()
    }
  }, [])

  async function handleSubmit(value: string): Promise<void> {
    if (selectedNodeId === null || selectedAgentId === null) {
      setMessages((current) => [
        ...current,
        { id: `system-${Date.now()}`, role: 'system', text: '请先选择一个在线节点。' },
      ])
      return
    }

    const assistantId = `assistant-${Date.now()}`
    setMessages((current) => [
      ...current,
      { id: `user-${Date.now()}`, role: 'user', text: value },
      { id: assistantId, role: 'assistant', text: '' },
    ])
    setSending(true)

    try {
      const createdTask = await createTask({
        nodeId: selectedNodeId,
        agentId: selectedAgentId,
        goal: value,
        sessionId,
      })

      streamCleanupRef.current?.()
      streamCleanupRef.current = streamTask(createdTask.taskId, {
        onSessionAttached: (nextSessionId) => {
          setSessionId(nextSessionId)
        },
        onMessageDelta: (delta) => {
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId ? { ...message, text: message.text + delta } : message
            )
          )
        },
        onDone: () => {
          setSending(false)
          setMessages((current) =>
            current.map((message) =>
              message.id === assistantId && message.text.trim().length === 0
                ? { ...message, text: '任务已完成，但当前没有可显示的文本输出。' }
                : message
            )
          )
        },
        onError: () => {
          setSending(false)
        },
      })
    } catch (submitError) {
      setSending(false)
      setMessages((current) =>
        current.map((message) =>
          message.id === assistantId
            ? {
                ...message,
                text: submitError instanceof Error ? submitError.message : String(submitError),
              }
            : message
        )
      )
    }
  }

  return (
    <ChatShell
      messages={messages}
      nodes={nodes}
      onSelectNode={(nodeId, agentId) => {
        setSelectedNodeId(nodeId)
        setSelectedAgentId(agentId)
        setSessionId(null)
      }}
      onSubmit={handleSubmit}
      selectedAgentId={selectedAgentId}
      selectedNodeId={selectedNodeId}
      sending={sending}
      sessionId={sessionId}
      statusText={error instanceof Error ? error.message : '选择一个在线节点开始。'}
    />
  )
}
