import { describe, expect, it } from 'vitest'
import { UIStore } from '../src/tui/store.js'

describe('UIStore frame batching', () => {
  it('retains every streamed text delta in a coalesced frame', () => {
    const store = new UIStore()
    store.apply({ type: 'text_delta', text: 'a' })
    store.apply({ type: 'text_delta', text: 'b' })
    store.apply({ type: 'text_delta', text: 'c' })

    store.flush()

    expect(store.getSnapshot().transcript).toEqual([
      {
        kind: 'assistant',
        id: 'assistant-0',
        text: 'abc',
        streaming: true,
        citations: [],
      },
    ])
  })
})
