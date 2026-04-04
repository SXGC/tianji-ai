export interface ChatMessage {
  readonly id: string
  readonly role: 'user' | 'assistant' | 'system'
  readonly text: string
}

interface MessageListProps {
  readonly messages: readonly ChatMessage[]
}

export function MessageList(props: MessageListProps) {
  return (
    <section className="messages">
      {props.messages.map((message) => (
        <article key={message.id} className={`bubble ${message.role}`}>
          {message.text}
        </article>
      ))}
    </section>
  )
}
