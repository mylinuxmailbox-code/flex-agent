/**
 * Minimal Server-Sent Events reader.
 *
 * Used by adapters that talk to a streaming HTTP API directly rather than
 * through a vendor SDK. It implements exactly the subset of the SSE spec those
 * APIs use: `data:` lines (possibly several per event), `event:` names, comments
 * and CRLF/LF line endings, with events separated by a blank line.
 */

export interface SSEMessage {
  event?: string
  data: string
}

export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEMessage> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let event: string | undefined
  let data: string[] = []

  const flush = (): SSEMessage | null => {
    if (data.length === 0) {
      event = undefined
      return null
    }
    const message: SSEMessage = { event, data: data.join('\n') }
    event = undefined
    data = []
    return message
  }

  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let newline = buffer.search(/\r\n|\n|\r/)
      while (newline !== -1) {
        const line = buffer.slice(0, newline)
        const sep = buffer.startsWith('\r\n', newline) ? 2 : 1
        buffer = buffer.slice(newline + sep)

        if (line === '') {
          const message = flush()
          if (message) yield message
        } else if (!line.startsWith(':')) {
          const colon = line.indexOf(':')
          const field = colon === -1 ? line : line.slice(0, colon)
          let val = colon === -1 ? '' : line.slice(colon + 1)
          if (val.startsWith(' ')) val = val.slice(1)
          if (field === 'data') data.push(val)
          else if (field === 'event') event = val
        }
        newline = buffer.search(/\r\n|\n|\r/)
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) {
      const colon = buffer.indexOf(':')
      if (buffer.startsWith('data') && colon !== -1) data.push(buffer.slice(colon + 1).trimStart())
    }
    const last = flush()
    if (last) yield last
  } finally {
    reader.releaseLock()
  }
}
