import { useAppStore } from '../stores/app-store'

export function WorkspacePanel() {
  const { sessionId } = useAppStore()

  return (
    <div className="workspace-panel">
      <div className="workspace-placeholder">
        <p>工作区</p>
        <p>{sessionId === null ? '当前没有会话' : `当前会话: ${sessionId}`}</p>
      </div>
    </div>
  )
}
