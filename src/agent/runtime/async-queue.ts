/**
 * A minimal async queue used to hand events from concurrently-running tools
 * back to a sequential consumer.
 *
 * Tools run in parallel but their progress must be rendered in order, so the
 * emitter and the consumer meet here rather than sharing mutable state.
 */
export class AsyncQueue<T> {
  #items: T[] = []
  #resolvers: Array<(result: IteratorResult<T>) => void> = []
  #closed = false

  push(item: T): void {
    if (this.#closed) return
    const resolve = this.#resolvers.shift()
    if (resolve) {
      resolve({ value: item, done: false })
      return
    }
    this.#items.push(item)
  }

  close(): void {
    this.#closed = true
    while (this.#resolvers.length > 0) {
      this.#resolvers.shift()?.({ value: undefined as never, done: true })
    }
  }

  async *drain(): AsyncGenerator<T> {
    while (true) {
      if (this.#items.length > 0) {
        yield this.#items.shift() as T
        continue
      }
      if (this.#closed) return
      const result = await new Promise<IteratorResult<T>>((resolve) => {
        this.#resolvers.push(resolve)
      })
      if (result.done) return
      yield result.value
    }
  }
}
