import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A scriptable HTTP server for provider tests.
 *
 * The providers are exercised through their real HTTP clients (the OpenAI SDK,
 * `fetch`), so what is asserted is the actual wire behaviour: request shape on
 * the way out, stream parsing on the way back.
 */

export interface RecordedRequest {
  method: string
  url: string
  headers: IncomingMessage['headers']
  body: unknown
}

export type Handler = (
  req: RecordedRequest,
  res: ServerResponse,
  raw: IncomingMessage,
) => void | Promise<void>

export interface MockServer {
  url: string
  requests: RecordedRequest[]
  /** Replace the handler. Called for every request. */
  handle(handler: Handler): void
  close(): Promise<void>
}

export async function startMockServer(initial?: Handler): Promise<MockServer> {
  let handler: Handler =
    initial ??
    ((_req, res) => {
      res.statusCode = 404
      res.end('{}')
    })
  const requests: RecordedRequest[] = []

  const server: Server = createServer((raw, res) => {
    const chunks: Buffer[] = []
    raw.on('data', (c: Buffer) => chunks.push(c))
    raw.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      let body: unknown = text
      try {
        body = text ? JSON.parse(text) : undefined
      } catch {
        /* leave as text */
      }
      const recorded: RecordedRequest = {
        method: raw.method ?? 'GET',
        url: raw.url ?? '/',
        headers: raw.headers,
        body,
      }
      requests.push(recorded)
      void Promise.resolve(handler(recorded, res, raw)).catch((err) => {
        res.statusCode = 500
        res.end(String(err))
      })
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    handle: (h) => {
      handler = h
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

/** Write an SSE stream: each item becomes one `data:` event. */
export function sse(res: ServerResponse, events: unknown[], opts: { done?: boolean } = {}): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const event of events) {
    res.write(`data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
  }
  if (opts.done) res.write('data: [DONE]\n\n')
  res.end()
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
