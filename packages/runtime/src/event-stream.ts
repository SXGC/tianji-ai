export class ReplayableEventStream<T> implements AsyncIterable<T> {
  private readonly events: T[] = []
  private readonly waiters = new Set<() => void>()
  private closed = false
  private failure: Error | undefined

  push(event: T): void {
    if (this.closed) {
      throw new Error('Cannot push to a closed event stream')
    }

    this.events.push(event)
    this.flushWaiters()
  }

  close(): void {
    this.closed = true
    this.flushWaiters()
  }

  fail(error: Error): void {
    this.failure = error
    this.closed = true
    this.flushWaiters()
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    let index = 0

    return {
      next: async (): Promise<IteratorResult<T>> => {
        while (index >= this.events.length) {
          if (this.failure !== undefined) {
            throw this.failure
          }

          if (this.closed) {
            return { done: true, value: undefined }
          }

          await new Promise<void>((resolve) => {
            this.waiters.add(resolve)
          })
        }

        const value = this.events[index]
        index += 1
        return { done: false, value }
      },
    }
  }

  private flushWaiters(): void {
    for (const waiter of this.waiters) {
      waiter()
    }

    this.waiters.clear()
  }
}
