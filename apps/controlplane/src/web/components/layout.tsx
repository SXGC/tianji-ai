import { CopilotChat } from '@copilotkit/react-ui'
import '@copilotkit/react-ui/styles.css'

import { useAppStore } from '../stores/app-store'
import { NodeList } from './node-list'
import { WorkspacePanel } from './workspace-panel'

export function Layout() {
  const { selectedNodeId } = useAppStore()
  const chatDisabled = selectedNodeId === null

  return (
    <div className="app-layout">
      <NodeList />
      <WorkspacePanel />
      <div className="chat-panel">
        {chatDisabled ? (
          <div className="chat-disabled">
            <p>请先选择一个在线节点</p>
          </div>
        ) : (
          <CopilotChat
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
