import type { UiNode } from '../lib/api'
import { ChatComposer } from './chat-composer'
import { type ChatMessage, MessageList } from './message-list'
import { NodeList } from './node-list'

interface ChatShellProps {
  readonly nodes: readonly UiNode[]
  readonly selectedNodeId: string | null
  readonly selectedAgentId: string | null
  readonly sessionId: string | null
  readonly messages: readonly ChatMessage[]
  readonly statusText: string
  readonly sending: boolean
  readonly onSelectNode: (nodeId: string, agentId: string | null) => void
  readonly onSubmit: (value: string) => Promise<void>
}

export function ChatShell(props: ChatShellProps) {
  return (
    <div className="chat-app">
      <aside className="sidebar">
        <h1 className="brand">Tianji</h1>
        <p className="subtitle">Controlplane 最小聊天页</p>
        <div className="status">{props.statusText}</div>
        <NodeList
          nodes={props.nodes}
          onSelect={props.onSelectNode}
          selectedNodeId={props.selectedNodeId}
        />
      </aside>
      <main className="chat">
        <header className="chat-header">
          <div>
            <h2>{props.selectedNodeId ?? '选择一个在线节点'}</h2>
            <p>
              {props.selectedAgentId === null
                ? '当前没有可用 agent'
                : `agent: ${props.selectedAgentId}`}
            </p>
          </div>
          <div className="session-pill">
            {props.sessionId === null ? 'session: 未建立' : `session: ${props.sessionId}`}
          </div>
        </header>
        <MessageList messages={props.messages} />
        <ChatComposer disabled={props.sending} onSubmit={props.onSubmit} />
      </main>
    </div>
  )
}
