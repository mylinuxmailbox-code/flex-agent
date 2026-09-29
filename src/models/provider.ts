import type {
  AgentMessage,
  ContentBlock,
  ModelInfo,
  ModelRequest,
  ModelResponse,
  StreamEvent,
} from './types.js'

/**
 * The contract every model backend implements.
 *
 * A provider owns exactly two things: how to ask a model, and how to turn its
 * reply into Flex's vocabulary. It knows nothing about tools, permissions,
 * the UI, or the agent loop.
 */
export interface ModelProvider {
  /** Stable identifier, e.g. `anthropic`. Used in config and `/model` display. */
  readonly id: string
  /** Human label, e.g. `Anthropic`. */
  readonly label: string
  /** Extra names accepted as a `provider:model` prefix, e.g. `gemini` for `google`. */
  readonly aliases?: readonly string[]
  /**
   * True when `resolveModel` accepts any id it is given (local servers and
   * gateways serve arbitrary models). The router asks catch-all providers last
   * so they cannot shadow a provider that knows the id for certain.
   */
  readonly catchAll?: boolean

  /** Synchronous: is a credential (or a keyless endpoint) configured? No network. */
  configured?(): boolean

  /** Cheap check: can this provider serve requests at all? (key present, etc.) */
  available(): Promise<{ ok: boolean; reason?: string }>

  /** All models this provider exposes, best first. */
  listModels(): ModelInfo[]

  /** Ask the service which models it serves and update `listModels()`. Never throws. */
  refreshModels?(signal?: AbortSignal): Promise<void>

  /** Resolve a user-typed model string. Never throws; returns undefined if unknown. */
  resolveModel(spec: string): ModelInfo | undefined

  /**
   * Stream a completion. Implementations must be lazy generators so the agent
   * loop can stop iterating without leaving a request in flight.
   */
  stream(request: ModelRequest): AsyncGenerator<StreamEvent>

  /** Non-streaming convenience wrapper. `stream()` must be implemented regardless. */
  complete(request: ModelRequest): Promise<ModelResponse>
}

/** Accumulates a StreamEvent sequence into a finished ModelResponse. */
export function collectStream(events: AsyncIterable<StreamEvent>): Promise<ModelResponse> {
  return new Promise<ModelResponse>((resolve, reject) => {
    void (async () => {
      const content: ContentBlock[] = []
      let pendingSignature: string | undefined
      let id = ''
      let model = ''
      let stopReason: ModelResponse['stopReason'] = 'end_turn'
      let usage = { inputTokens: 0, outputTokens: 0 }
      let firstError: Error | null = null

      for await (const event of events) {
        switch (event.type) {
          case 'message_start':
            id = event.id
            model = event.model
            break
          case 'text_delta':
            pushText(content, event.text)
            break
          case 'thinking_delta':
            pushThinking(content, event.thinking)
            break
          case 'thinking_signature': {
            const last = content[content.length - 1]
            if (last?.type === 'thinking') last.signature = event.signature
            else pendingSignature = event.signature
            break
          }
          case 'citation_delta':
            content.push(event.citation)
            break
          case 'tool_call_end':
            content.push({
              type: 'tool_use',
              id: event.id,
              name: event.name,
              input: event.input,
              ...(event.providerMeta ? { providerMeta: event.providerMeta } : {}),
            })
            break
          case 'usage':
            usage = event.usage
            break
          case 'error':
            firstError ??= event.error
            break
          case 'done':
            stopReason = event.stopReason
            usage = event.usage
            break
          default:
            break
        }
      }

      if (firstError) return reject(firstError)
      if (pendingSignature) {
        // A signature with no preceding thinking text still authenticates an
        // (empty) thinking block; keep it so replay validation passes.
        content.unshift({ type: 'thinking', thinking: '', signature: pendingSignature })
      }
      resolve({ id, model, content, stopReason, usage })
    })().catch(reject)
  })
}

/** Merge consecutive text deltas so providers don't emit one block per token. */
export function pushText(content: ContentBlock[], text: string): void {
  const last = content[content.length - 1]
  if (last?.type === 'text') {
    last.text += text
  } else {
    content.push({ type: 'text', text })
  }
}

export function pushThinking(content: ContentBlock[], thinking: string): void {
  const last = content[content.length - 1]
  if (last?.type === 'thinking') {
    last.thinking += thinking
  } else {
    content.push({ type: 'thinking', thinking })
  }
}

/** Flatten a message's content blocks to plain text (for previews and logging). */
export function messageToText(message: AgentMessage): string {
  return message.content
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
}
