import { CopilotChat } from '@copilotkit/react-ui'
import '@copilotkit/react-ui/styles.css'

import { useAppStore } from '../stores/app-store'
import { NodeList } from './node-list'
import { WorkspacePanel } from './workspace-panel'

export function Layout() {
  const { selectedNodeId, sessionId, setSessionId } = useAppStore()
  const chatDisabled = selectedNodeId === null || sessionId === null

  return (
    <div className="app-layout">
      <NodeList />
      <WorkspacePanel />
      <div className="chat-panel">
        <div className="chat-toolbar">
          <button
            type="button"
            disabled={selectedNodeId === null}
            onClick={() => {
              setSessionId(`session_${Date.now()}`)
            }}
          >
            New Session
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
