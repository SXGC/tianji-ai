import type { InputProps, MessagesProps } from '@copilotkit/react-ui'
import { CopilotChat } from '@copilotkit/react-ui'
import '@copilotkit/react-ui/styles.css'
import { useState } from 'react'

import { createSession } from '../lib/nodes-api'
import { useAppStore } from '../stores/app-store'
import { NodeList } from './node-list'
import { WorkspacePanel } from './workspace-panel'

/**
 * 让 CopilotChat 的消息区滚动留在右侧面板内部，而不是继续撑高整个页面。
 */
function ChatMessages({ messages, inProgress, RenderMessage }: MessagesProps) {
  return (
    <div className="chat-messages-shell">
      <div className="chat-messages-scroll">
        {messages.map((message, index) => {
          const isCurrentMessage = index === messages.length - 1
          return (
            <RenderMessage
              key={message.id}
              message={message}
              messages={messages}
              inProgress={inProgress}
              index={index}
              isCurrentMessage={isCurrentMessage}
            />
          )
        })}
      </div>
    </div>
  )
}

/**
 * 只改输入区外壳，不改 CopilotKit 的发送/停止业务行为。
 */
function ChatInput({ inProgress, onSend, onStop, chatReady, hideStopButton }: InputProps) {
  const [value, setValue] = useState('')

  const submit = async () => {
    const nextValue = value.trim()
    if (nextValue.length === 0 || inProgress) return
    await onSend(nextValue)
    setValue('')
  }

  const canSend = chatReady !== false && value.trim().length > 0 && !inProgress
  const canStop = inProgress && hideStopButton !== true && onStop !== undefined

  return (
    <div className="chat-input-shell">
      <label className="chat-input-label" htmlFor="chat-input">
        输入任务
      </label>
      <div className="chat-input-row">
        <textarea
          id="chat-input"
          className="chat-input-field"
          disabled={chatReady === false}
          onChange={(event) => {
            setValue(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' || event.shiftKey) return
            event.preventDefault()
            void submit()
          }}
          placeholder="输入你的任务或问题"
          rows={1}
          value={value}
        />
        <div className="chat-input-actions">
          {canStop ? (
            <button className="chat-secondary-button" onClick={onStop} type="button">
              停止
            </button>
          ) : null}
          <button
            className="chat-primary-button"
            disabled={!canSend}
            onClick={() => {
              void submit()
            }}
            type="button"
          >
            发送
          </button>
        </div>
      </div>
    </div>
  )
}

export function Layout() {
  const { selectedNodeId, selectedAgentId, sessionId, setSessionId } = useAppStore()
  const chatDisabled = selectedNodeId === null || sessionId === null
  const sessionLabel = sessionId === null ? '未创建' : sessionId.replace(/^session_/, '#')

  return (
    <div className="app-layout">
      <NodeList />
      <WorkspacePanel />
      <div className="chat-panel">
        <div className="chat-toolbar">
          <div className="chat-toolbar-copy">
            <p className="chat-toolbar-eyebrow">Copilot Session</p>
            <h2 className="chat-toolbar-title">{sessionLabel}</h2>
          </div>
          <button
            className="chat-icon-button"
            data-testid="new-session-button"
            disabled={selectedNodeId === null}
            onClick={() => {
              if (selectedNodeId === null || selectedAgentId === null) return
              void createSession({ nodeId: selectedNodeId, agentId: selectedAgentId }).then(
                (result) => {
                  setSessionId(result.sessionId, {
                    nodeId: selectedNodeId,
                    agentId: selectedAgentId,
                  })
                }
              )
            }}
            title="新建会话"
            type="button"
          >
            <svg
              aria-label="新建会话"
              fill="none"
              height="18"
              role="img"
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
              viewBox="0 0 24 24"
              width="18"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
        {chatDisabled ? (
          <div className="chat-disabled">
            <p>{selectedNodeId === null ? '请先选择一个在线节点' : '正在初始化会话'}</p>
          </div>
        ) : (
          <CopilotChat
            key={sessionId}
            className="tianji-chat"
            Input={ChatInput}
            Messages={ChatMessages}
            labels={{
              initial: '选择一个节点后发送消息',
              placeholder: '输入你的任务或问题',
            }}
          />
        )}
      </div>
    </div>
  )
}
