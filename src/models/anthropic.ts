import Anthropic from '@anthropic-ai/sdk'
import type { ModelProvider } from './provider.js'
import {
  type ContentBlock,
  isAbortError,
  ModelError,
  type ModelInfo,
  type ModelRequest,
  type ModelResponse,
  type SingleAgentEffort,
  type StopReason,
  type StreamEvent,
  toProviderEffort,
  type Usage,
} from './types.js'

/**
 * Anthropic adapter.
 *
 * Responsibilities, and nothing else: translate Flex's message shape into
 * `messages.create` parameters, turn the SSE event stream into Flex's
 * normalized events, and map SDK errors onto ModelError. It has no opinion
 * about tools, permissions, or the agent loop.
 */

export interface AnthropicProviderOptions {
  apiKey?: string
  /** Must NOT include `/v1` — the SDK appends `/v1/messages` itself. */
  baseURL?: string
  authToken?: string
  maxRetries?: number
  /** Milliseconds. The TS SDK uses ms; the Python one uses seconds. */
  timeoutMs?: number
}

const DEFAULT_MAX_OUTPUT = 32_000

/**
 * Model line-up as of the installed SDK (0.128.0). `claude-opus-5` is retained
 * because it is still servable, but `claude-opus-5-5` is the flagship.
 */
export const ANTHROPIC_MODELS: readonly ModelInfo[] = [
  {
    id: 'claude-opus-5-5',
    label: 'Opus 5.5',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsThinking: true,
    supportsEffort: true,
    supportsWebSearch: true,
    supportsPromptCaching: true,
    nativeEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    perMessageEffort: true,
    pricing: { inputPerMTok: 4, outputPerMTok: 20, cacheReadPerMTok: 0.4, cacheWritePerMTok: 5 },
  },
  {
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsThinking: true,
    supportsEffort: true,
    supportsWebSearch: true,
    supportsPromptCaching: true,
    nativeEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    pricing: { inputPerMTok: 2, outputPerMTok: 10, cacheReadPerMTok: 0.2, cacheWritePerMTok: 2.5 },
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Haiku 4.5',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    supportsTools: true,
    supportsThinking: false,
    // Haiku 4.5 does not accept `output_config.effort`.
    supportsEffort: false,
    supportsWebSearch: true,
    supportsPromptCaching: true,
    pricing: { inputPerMTok: 1, outputPerMTok: 5 },
  },
  {
    id: 'claude-fable-5-1',
    label: 'Fable 5.1',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsThinking: true,
    supportsEffort: true,
    supportsWebSearch: true,
    supportsPromptCaching: true,
    nativeEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    perMessageEffort: true,
    pricing: { inputPerMTok: 10, outputPerMTok: 50 },
  },
  {
    id: 'claude-opus-5',
    label: 'Opus 5 (legacy)',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    supportsTools: true,
    supportsThinking: true,
    supportsEffort: true,
    supportsWebSearch: true,
    supportsPromptCaching: true,
    nativeEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    pricing: { inputPerMTok: 5, outputPerMTok: 25 },
  },
]

/** Accept short aliases so `flex --model opus` works. */
const ALIASES: Record<string, string> = {
  opus: 'claude-opus-5-5',
  'opus-5': 'claude-opus-5-5',
  'opus-5.5': 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5',
  haiku: 'claude-haiku-4-5',
  'haiku-4.5': 'claude-haiku-4-5',
  fable: 'claude-fable-5-1',
  'fable-5.1': 'claude-fable-5-1',
}

export class AnthropicProvider implements ModelProvider {
  readonly id = 'anthropic'
  readonly label = 'Anthropic'
  readonly #client: Anthropic
  readonly #models: ModelInfo[]
  readonly #credential: string | undefined

  constructor(options: AnthropicProviderOptions = {}) {
    this.#credential =
      options.apiKey ??
      options.authToken ??
      process.env.ANTHROPIC_API_KEY ??
      process.env.ANTHROPIC_AUTH_TOKEN
    this.#client = new Anthropic({
      apiKey: options.apiKey ?? process.env.ANTHROPIC_API_KEY,
      // A proxy baseURL must not carry `/v1`; the SDK concatenates `/v1/messages`.
      baseURL: options.baseURL ?? process.env.ANTHROPIC_BASE_URL,
      authToken: options.authToken ?? process.env.ANTHROPIC_AUTH_TOKEN,
      maxRetries: options.maxRetries ?? 2,
      timeout: options.timeoutMs ?? 600_000,
    })
    this.#models = ANTHROPIC_MODELS.map((m) => ({ ...m, provider: 'anthropic' }))
  }

  configured(): boolean {
    return Boolean(this.#credential)
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    if (this.#credential) return { ok: true }
    return { ok: false, reason: 'ANTHROPIC_API_KEY is not set' }
  }

  listModels(): ModelInfo[] {
    return this.#models
  }

  resolveModel(spec: string): ModelInfo | undefined {
    const normalized = spec.trim().toLowerCase()
    if (!normalized) return this.#models[0]
    const direct = this.#models.find((m) => m.id === normalized)
    if (direct) return direct
    const aliased = ALIASES[normalized]
    if (aliased) return this.#models.find((m) => m.id === aliased)
    // Any other `claude-*` id is still an Anthropic model (a dated snapshot, or
    // one released after this table was written). Assume the family defaults
    // rather than routing it to a provider that would answer 404.
    if (normalized.startsWith('claude-')) {
      return {
        id: spec.trim(),
        label: spec.trim(),
        contextWindow: 200_000,
        maxOutputTokens: 64_000,
        supportsTools: true,
        supportsThinking: false,
        supportsEffort: false,
        supportsWebSearch: false,
        supportsPromptCaching: true,
        provider: 'anthropic',
      }
    }
    return undefined
  }

  stream(request: ModelRequest): AsyncGenerator<StreamEvent> {
    const params = this.#buildParams(request)
    return this.#runStream(params, request)
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const params = this.#buildParams(request)
    try {
      const message = await this.#client.messages.create({
        ...params,
        stream: false,
      })
      return {
        id: message.id,
        model: message.model,
        content: message.content.flatMap((b) => fromAnthropicBlock(b)),
        stopReason: convertStopReason(message.stop_reason),
        usage: convertUsage(message.usage),
      }
    } catch (err) {
      throw toModelError(err)
    }
  }

  // -------------------------------------------------------------------------

  #buildParams(request: ModelRequest): Anthropic.MessageCreateParamsNonStreaming {
    const model = this.resolveModel(request.model)?.id ?? request.model
    const info = this.resolveModel(request.model)
    const maxTokens = request.maxOutputTokens ?? info?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT

    // Cache breakpoints: the system prompt and the tool list are stable across
    // turns, so they are the highest-value places to spend one of the four
    // breakpoints the API allows.
    const system: Anthropic.TextBlockParam[] = [
      { type: 'text', text: request.system.text, cache_control: { type: 'ephemeral' } },
    ]
    if (request.system.toolGuidance) {
      system.push({ type: 'text', text: request.system.toolGuidance })
    }

    const tools: Anthropic.ToolUnion[] = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
      ...(tool.strict === false ? {} : { strict: true }),
      // Lets tool arguments stream in as they are produced instead of arriving
      // as one blob at the end, which makes long tool calls feel immediate.
      eager_input_streaming: true,
      cache_control: { type: 'ephemeral' },
    }))

    if (request.serverTools?.length) {
      for (const serverTool of request.serverTools) {
        tools.push(serverTool as unknown as Anthropic.ToolUnion)
      }
    }

    const effort: SingleAgentEffort | undefined =
      info?.supportsEffort && request.effort ? toProviderEffort(request.effort) : undefined

    return {
      model,
      max_tokens: maxTokens,
      system,
      messages: request.messages
        .map(convertMessage)
        .filter((m) => (m.content as unknown[]).length > 0),
      ...(tools.length > 0 ? { tools } : {}),
      // Adaptive thinking is the only shape supported across the current
      // generation; the legacy `enabled` + budget form 400s on Opus 5.5.
      thinking: { type: 'adaptive', display: 'summarized' },
      ...(effort ? { output_config: { effort } } : {}),
      ...(request.metadata ? { metadata: request.metadata } : {}),
    } as Anthropic.MessageCreateParamsNonStreaming
  }

  async *#runStream(
    params: Anthropic.MessageCreateParamsNonStreaming,
    request: ModelRequest,
  ): AsyncGenerator<StreamEvent> {
    // Partial JSON is accumulated per content-block index. Parallel tool calls
    // interleave their deltas, so index is the only reliable key.
    const partialJson = new Map<number, string>()
    const toolStarts = new Map<number, { id: string; name: string }>()
    let messageId = ''
    let model = params.model
    let stopReason: StopReason = 'end_turn'
    let usage: Usage = { inputTokens: 0, outputTokens: 0 }
    let emittedUsage = false

    try {
      const stream = this.#client.messages.stream(
        { ...params, stream: true },
        request.signal ? { signal: request.signal } : undefined,
      )

      for await (const event of stream) {
        switch (event.type) {
          case 'message_start': {
            messageId = event.message.id
            model = event.message.model
            usage = convertUsage(event.message.usage)
            emittedUsage = true
            yield { type: 'message_start', id: messageId, model }
            break
          }
          case 'content_block_start': {
            const block = event.content_block
            if (block.type === 'tool_use') {
              toolStarts.set(event.index, { id: block.id, name: block.name })
              partialJson.set(event.index, '')
              yield { type: 'tool_call_start', index: event.index, id: block.id, name: block.name }
            }
            break
          }
          case 'content_block_delta': {
            const delta = event.delta
            if (delta.type === 'text_delta') {
              yield { type: 'text_delta', text: delta.text }
            } else if (delta.type === 'thinking_delta') {
              yield { type: 'thinking_delta', thinking: delta.thinking }
            } else if (delta.type === 'signature_delta') {
              yield { type: 'thinking_signature', signature: delta.signature }
            } else if (delta.type === 'input_json_delta') {
              partialJson.set(
                event.index,
                (partialJson.get(event.index) ?? '') + delta.partial_json,
              )
              yield { type: 'tool_call_delta', index: event.index, partialJson: delta.partial_json }
            } else if (delta.type === 'citations_delta') {
              const citation = delta.citation
              yield {
                type: 'citation_delta',
                citation: {
                  type: 'citation',
                  url: 'url' in citation ? citation.url : '',
                  title: ('title' in citation ? citation.title : undefined) ?? undefined,
                  citedText:
                    ('cited_text' in citation ? citation.cited_text : undefined) ?? undefined,
                },
              }
            }
            break
          }
          case 'content_block_stop': {
            const start = toolStarts.get(event.index)
            if (start) {
              const raw = partialJson.get(event.index) ?? ''
              // With eager_input_streaming the API stops validating tool input,
              // so a truncated turn can leave invalid JSON. Parse defensively
              // and surface the problem as an argument error the agent can act on.
              let parsed: unknown = {}
              try {
                parsed = raw ? JSON.parse(raw) : {}
              } catch {
                parsed = {
                  __parseError: 'tool input was not valid JSON',
                  __partial: raw.slice(0, 400),
                }
              }
              yield {
                type: 'tool_call_end',
                index: event.index,
                id: start.id,
                name: start.name,
                input: parsed,
              }
            }
            break
          }
          case 'message_delta': {
            stopReason = convertStopReason(event.delta.stop_reason)
            if (event.usage) {
              usage = {
                ...usage,
                outputTokens: event.usage.output_tokens ?? usage.outputTokens,
              }
              emittedUsage = true
              yield { type: 'usage', usage }
            }
            break
          }
          case 'message_stop':
            break
          default:
            // The typed MessageStream iterator surfaces failures by throwing,
            // which the catch below converts into an error event.
            break
        }
      }

      if (!emittedUsage) yield { type: 'usage', usage }
      yield { type: 'done', stopReason, usage }
    } catch (err) {
      if (isAbortError(err)) {
        yield { type: 'done', stopReason: 'aborted', usage }
        return
      }
      yield { type: 'error', error: toModelError(err) }
    }
  }
}

// ---------------------------------------------------------------------------
// conversions
// ---------------------------------------------------------------------------

function convertMessage(message: ModelRequest['messages'][number]): Anthropic.MessageParam {
  return {
    role: message.role,
    content: message.content
      // Thinking that never received a signature (another provider's reasoning,
      // or a session saved before signatures were kept) cannot be replayed:
      // Anthropic validates the signature and rejects the request.
      .filter((b) => b.type !== 'thinking' || Boolean(b.signature))
      .filter((b) => b.type !== 'citation' && b.type !== 'server_tool_use')
      .map(convertBlock) as Anthropic.ContentBlockParam[],
  }
}

function convertBlock(block: ContentBlock): Anthropic.ContentBlockParam {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'thinking':
      // Anthropic validates the signature on replay, so a thinking block we
      // did not receive a signature for cannot be sent back.
      return { type: 'thinking', thinking: block.thinking, signature: block.signature ?? '' }
    case 'redacted_thinking':
      return { type: 'redacted_thinking', data: block.data }
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>,
      }
    case 'tool_result': {
      const content =
        typeof block.content === 'string' ? block.content : block.content.map(convertBlock)
      return {
        type: 'tool_result',
        tool_use_id: block.toolUseId,
        content: content as Anthropic.ToolResultBlockParam['content'],
        ...(block.isError ? { is_error: true } : {}),
      }
    }
    default:
      return { type: 'text', text: '' }
  }
}

/** SDK response content block -> Flex content block. Unsupported kinds are dropped. */
function fromAnthropicBlock(block: Anthropic.ContentBlock): ContentBlock[] {
  switch (block.type) {
    case 'text':
      return [{ type: 'text', text: block.text }]
    case 'thinking':
      return [{ type: 'thinking', thinking: block.thinking, signature: block.signature }]
    case 'redacted_thinking':
      return [{ type: 'redacted_thinking', data: block.data }]
    case 'tool_use':
      return [{ type: 'tool_use', id: block.id, name: block.name, input: block.input }]
    case 'server_tool_use':
      return [{ type: 'server_tool_use', id: block.id, name: block.name, input: block.input }]
    case 'web_search_tool_result': {
      // Search results arrive as citations so the UI can render sources and the
      // final answer can link them.
      const out: ContentBlock[] = []
      if (Array.isArray(block.content)) {
        for (const hit of block.content) {
          if (hit.type !== 'web_search_result') continue
          out.push({ type: 'citation', url: hit.url, title: hit.title })
        }
      }
      return out
    }
    case 'web_fetch_tool_result': {
      const fetched = block.content
      if (fetched.type !== 'web_fetch_result') return []
      // `content` is a DocumentBlock: one or more typed content parts. Keep the
      // text parts, which is all the model can act on.
      const parts = Array.isArray(fetched.content) ? fetched.content : [fetched.content]
      const text = parts
        .map((part) => ('text' in part && typeof part.text === 'string' ? part.text : ''))
        .join('\n')
      return [{ type: 'text', text: `Source: ${fetched.url}\n\n${text}` }]
    }
    default:
      return []
  }
}

function convertUsage(usage: Anthropic.Usage): Usage {
  return {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? undefined,
    reasoningTokens: usage.output_tokens_details?.thinking_tokens ?? undefined,
  }
}

function convertStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_use'
    case 'max_tokens':
      return 'max_tokens'
    case 'stop_sequence':
      return 'stop_sequence'
    case 'refusal':
      return 'refusal'
    case 'pause_turn':
      return 'pause_turn'
    case 'model_context_window_exceeded':
      return 'context_overflow'
    default:
      return 'end_turn'
  }
}

/** The SDK exposes no OverloadedError; 529 arrives as InternalServerError. */
export function toModelError(err: unknown): ModelError {
  if (err instanceof ModelError) return err
  if (err instanceof Anthropic.AuthenticationError) return ModelError.auth(err.message)
  if (err instanceof Anthropic.PermissionDeniedError) {
    return new ModelError(err.message, { kind: 'auth', status: 403 })
  }
  if (err instanceof Anthropic.RateLimitError) return ModelError.rateLimit(err.message, 429)
  if (err instanceof Anthropic.NotFoundError) {
    return new ModelError(`Model or endpoint not found: ${err.message}`, {
      kind: 'invalid_request',
      status: 404,
    })
  }
  if (err instanceof Anthropic.BadRequestError) {
    if (/context|too long|maximum.*tokens/i.test(err.message)) {
      return ModelError.contextOverflow(err.message)
    }
    return ModelError.invalidRequest(err.message, 400)
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) return ModelError.timeout(err.message)
  if (err instanceof Anthropic.APIConnectionError) return ModelError.connection(err.message, err)
  if (err instanceof Anthropic.APIUserAbortError) return ModelError.aborted(err.message)
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? undefined
    if (status === 529) return ModelError.overloaded(err.message, 529)
    if (status === 429) return ModelError.rateLimit(err.message, 429)
    if (status !== undefined && status >= 500) {
      return new ModelError(err.message, { kind: 'overloaded', status, retryable: true })
    }
    return new ModelError(err.message, { kind: 'invalid_request', status })
  }
  if (isAbortError(err)) return ModelError.aborted()
  return ModelError.unknown(err instanceof Error ? err.message : String(err), err)
}
