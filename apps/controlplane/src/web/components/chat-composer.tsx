import type { FormEvent } from 'react'
import { useState } from 'react'

interface ChatComposerProps {
  readonly disabled: boolean
  readonly onSubmit: (value: string) => Promise<void>
}

export function ChatComposer(props: ChatComposerProps) {
  const [value, setValue] = useState('')

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextValue = value.trim()
    if (nextValue.length === 0) {
      return
    }

    setValue('')
    await props.onSubmit(nextValue)
  }

  return (
    <form className="composer" onSubmit={(event) => void handleSubmit(event)}>
      <textarea
        disabled={props.disabled}
        onChange={(event) => setValue(event.target.value)}
        placeholder="输入你的任务或问题"
        value={value}
      />
      <button disabled={props.disabled} type="submit">
        发送
      </button>
    </form>
  )
}
