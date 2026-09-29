import OpenAI from 'openai'
import type { ModelProvider } from './provider.js'
import { collectStream } from './provider.js'
import { cleanJsonSchema } from './schema.js'
import {
  type AgentMessage,
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
 * OpenAI-compatible provider.
 *
 * One adapter covers OpenAI, Azure-style gateways, DeepSeek, Groq, Together,
 * OpenRouter, Ollama, vLLM, LM Studio, llama.cpp — anything that serves
 * `POST {baseURL}/chat/completions`. Details that matter more than they look:
 *
 *  - `delta.tool_calls[].index` is the only stable key across chunks. `id` and
 *    `name` arrive only on the first chunk for an index, and some local servers
 *    omit `index` entirely.
 *  - `finish_reason` is `'length'`, not `'max_tokens'`, and usage rides on a
 *    final chunk whose `choices` array is empty.
 *  - api.openai.com wants `max_completion_tokens`; almost everything else only
 *    understands `max_tokens`. The parameter is chosen from the host and can be
 *    overridden per provider.
 *  - `reasoning_effort` is only sent to models that take it. A strict server
 *    answers an unknown parameter with a 400.
 *  - Reasoning text arrives as `reasoning_content` (DeepSeek, vLLM) or
 *    `reasoning` (OpenRouter) and is surfaced as thinking, never replayed.
 */

export interface OpenAICompatibleOptions {
  /** Provider id used for `provider:model` prefixes. Default `openai`. */
  id?: string
  label?: string
  /** Must include the API version path, e.g. `https://api.openai.com/v1`. */
  baseURL: string
  apiKey?: string
  defaultModel?: string
  /** Extra models to list. Strings are ids with default capabilities. */
  models?: ReadonlyArray<string | (Partial<ModelInfo> & { id: string })>
  /** Context window to assume; servers do not reliably report it. */
  contextWindow?: number
  maxOutputTokens?: number
  timeoutMs?: number
  headers?: Record<string, string>
  maxRetries?: number
  /** Override the auto-detected token limit parameter. */
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens'
  /** Force `reasoning_effort` on (true) or off (false). Default: model-name based. */
  reasoningEffort?: boolean
  /** Send `stream_options.include_usage`. A few old servers reject it. Default true. */
  streamUsage?: boolean
}

const isOpenAIHost = (baseURL: string): boolean => {
  try {
    return new URL(baseURL).hostname === 'api.openai.com'
  } catch {
    return false
  }
}

const isLocalHost = (baseURL: string): boolean => {
  try {
    const host = new URL(baseURL).hostname
    return host === 'localhost' || host === '::1' || host === '[::1]' || /^127\./.test(host)
  } catch {
    return false
  }
}

/** Models known to accept `reasoning_effort`. */
const REASONING_MODEL = /^(o\d|gpt-5|gpt-oss|deepseek-reasoner)/i

function modelInfo(
  id: string,
  opts: OpenAICompatibleOptions,
  extra: Partial<ModelInfo> = {},
): ModelInfo {
  const reasoning = opts.reasoningEffort ?? REASONING_MODEL.test(id)
  return {
    id,
    label: id,
    contextWindow: opts.contextWindow ?? 128_000,
    maxOutputTokens: opts.maxOutputTokens ?? 8_192,
    supportsTools: true,
    supportsThinking: reasoning,
    supportsEffort: reasoning,
    supportsWebSearch: false,
    supportsPromptCaching: false,
    provider: opts.id ?? 'openai',
    ...extra,
  }
}

/** Shown when the server has not (yet) been asked what it serves. */
function defaultCatalogue(opts: OpenAICompatibleOptions): ModelInfo[] {
  if (isOpenAIHost(opts.baseURL)) {
    return [
      modelInfo('gpt-5', opts, {
        label: 'GPT-5',
        contextWindow: 400_000,
        maxOutputTokens: 128_000,
      }),
      modelInfo('gpt-5-mini', opts, {
        label: 'GPT-5 mini',
        contextWindow: 400_000,
        maxOutputTokens: 128_000,
      }),
      modelInfo('gpt-4.1', opts, {
        label: 'GPT-4.1',
        contextWindow: 1_000_000,
        maxOutputTokens: 32_768,
      }),
      modelInfo('gpt-4o', opts, { label: 'GPT-4o', maxOutputTokens: 16_384 }),
    ]
  }
  return []
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string
  readonly label: string
  readonly catchAll = true
  readonly #client: OpenAI
  readonly #options: OpenAICompatibleOptions
  readonly #apiKey: string | undefined
  #models: ModelInfo[]

  constructor(options: OpenAICompatibleOptions) {
    this.#options = options
    this.id = options.id ?? 'openai'
    this.label = options.label ?? (isOpenAIHost(options.baseURL) ? 'OpenAI' : 'OpenAI-compatible')
    this.#apiKey = options.apiKey
    this.#client = new OpenAI({
      // Unlike Anthropic, this baseURL *must* include /v1: the SDK's paths are
      // relative to it.
      baseURL: options.baseURL,
      // The SDK refuses to construct without a key; keyless local servers get a
      // placeholder that is never a real credential.
      apiKey: options.apiKey ?? 'not-needed',
      defaultHeaders: options.headers,
      maxRetries: options.maxRetries ?? 2,
      timeout: options.timeoutMs ?? 300_000,
    })
    const configured = (options.models ?? []).map((m) =>
      typeof m === 'string' ? modelInfo(m, options) : modelInfo(m.id, options, m),
    )
    const seen = new Set(configured.map((m) => m.id))
    this.#models = [...configured, ...defaultCatalogue(options).filter((m) => !seen.has(m.id))]
  }

  configured(): boolean {
    // A hosted endpoint needs a key; a local one is keyless by nature.
    return (
      Boolean(this.#apiKey) ||
      isLocalHost(this.#options.baseURL) ||
      !isOpenAIHost(this.#options.baseURL)
    )
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    if (isOpenAIHost(this.#options.baseURL) && !this.#apiKey) {
      return { ok: false, reason: 'OPENAI_API_KEY is not set' }
    }
    try {
      await this.#client.models.list({ timeout: 5_000, maxRetries: 0 })
      return { ok: true }
    } catch (err) {
      if (err instanceof OpenAI.APIError && err.status !== undefined && err.status < 500) {
        // The server answered. A 404 just means it has no /models route.
        if (err.status === 401 || err.status === 403) {
          return { ok: false, reason: `${this.#options.baseURL} rejected the API key` }
        }
        return { ok: true }
      }
      return {
        ok: false,
        reason: `cannot reach ${this.#options.baseURL}: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  listModels(): ModelInfo[] {
    return this.#models
  }

  /** Replace the catalogue with what `GET /models` reports, when it reports any. */
  async refreshModels(signal?: AbortSignal): Promise<void> {
    try {
      const page = await this.#client.models.list({ timeout: 8_000, maxRetries: 0, signal })
      const ids: string[] = []
      for await (const m of page) {
        if (
          m.id &&
          !/(embed|whisper|tts|dall-e|moderation|image|transcribe|realtime|audio)/i.test(m.id)
        ) {
          ids.push(m.id)
        }
      }
      if (ids.length === 0) return
      const configured = new Map(this.#models.map((m) => [m.id, m]))
      this.#models = ids.sort().map((id) => configured.get(id) ?? modelInfo(id, this.#options))
    } catch {
      /* keep whatever catalogue we had */
    }
  }

  resolveModel(spec: string): ModelInfo | undefined {
    const normalized = spec.trim()
    if (!normalized) {
      const id = this.#options.defaultModel ?? this.#models[0]?.id
      return id ? this.resolveModel(id) : undefined
    }
    const known = this.#models.find((m) => m.id === normalized)
    if (known) return known
    // Servers accept arbitrary model ids and a local server's catalogue is not
    // knowable ahead of time, so an unknown id is assumed valid rather than
    // rejected — with conservative capability assumptions.
    return modelInfo(normalized, this.#options)
  }

  stream(request: ModelRequest): AsyncGenerator<StreamEvent> {
    return this.#runStream(request)
  }

  complete(request: ModelRequest): Promise<ModelResponse> {
    return collectStream(this.#runStream(request))
  }

  async *#runStream(request: ModelRequest): AsyncGenerator<StreamEvent> {
    const info = this.resolveModel(request.model)
    const model = info?.id ?? request.model
    const maxTokens =
      request.maxOutputTokens ?? this.#options.maxOutputTokens ?? info?.maxOutputTokens ?? 8_192
    const tokenParam =
      this.#options.maxTokensParam ??
      (isOpenAIHost(this.#options.baseURL) ? 'max_completion_tokens' : 'max_tokens')

    /** Keyed by the provider's own index, which is the only stable identifier. */
    const partialCalls = new Map<
      number,
      { id: string; name: string; args: string; started: boolean }
    >()
    let usage: Usage = { inputTokens: 0, outputTokens: 0 }
    let finishReason: string | null = null

    try {
      const params: Record<string, unknown> = {
        model,
        messages: toOpenAIMessages(request),
        [tokenParam]: maxTokens,
        stream: true,
        ...(this.#options.streamUsage === false ? {} : { stream_options: { include_usage: true } }),
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      }
      if (request.tools.length > 0) {
        params.tools = request.tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.name,
            description: tool.description,
            parameters: cleanJsonSchema(tool.inputSchema),
          },
        }))
      }
      if (info?.supportsEffort && request.effort) {
        params.reasoning_effort = toOpenAIEffort(request.effort)
      }

      const stream = (await this.#client.chat.completions.create(
        params as unknown as OpenAI.ChatCompletionCreateParamsStreaming,
        request.signal ? { signal: request.signal } : undefined,
      )) as AsyncIterable<
        OpenAI.ChatCompletionChunk & { error?: { message?: string; code?: unknown } }
      >

      yield { type: 'message_start', id: `chatcmpl-${model}`, model }

      for await (const chunk of stream) {
        // Gateways (OpenRouter and friends) report mid-stream failures as data.
        if (chunk.error) {
          yield { type: 'error', error: fromErrorPayload(chunk.error) }
          return
        }
        // The usage-only chunk at the end carries an empty choices array.
        if (chunk.usage) {
          const details = chunk.usage as {
            prompt_tokens?: number
            completion_tokens?: number
            prompt_tokens_details?: { cached_tokens?: number }
            completion_tokens_details?: { reasoning_tokens?: number }
          }
          usage = {
            inputTokens: details.prompt_tokens ?? 0,
            outputTokens: details.completion_tokens ?? 0,
            ...(details.prompt_tokens_details?.cached_tokens
              ? { cacheReadTokens: details.prompt_tokens_details.cached_tokens }
              : {}),
            ...(details.completion_tokens_details?.reasoning_tokens
              ? { reasoningTokens: details.completion_tokens_details.reasoning_tokens }
              : {}),
          }
        }

        const choice = chunk.choices?.[0]
        if (!choice) continue
        if (choice.finish_reason) finishReason = choice.finish_reason

        const delta = choice.delta as
          | (OpenAI.ChatCompletionChunk.Choice.Delta & {
              reasoning_content?: string | null
              reasoning?: string | null
            })
          | undefined
        if (!delta) continue
        if (delta.content) yield { type: 'text_delta', text: delta.content }
        const reasoning = delta.reasoning_content ?? delta.reasoning
        if (reasoning) yield { type: 'thinking_delta', thinking: reasoning }

        let position = 0
        for (const call of delta.tool_calls ?? []) {
          // Some local servers omit `index`; their calls arrive whole and in order.
          const index = call.index ?? position
          position++
          const existing = partialCalls.get(index) ?? { id: '', name: '', args: '', started: false }
          // `id` and `name` arrive only on the first chunk for this index.
          if (call.id) existing.id = call.id
          if (call.function?.name) existing.name = existing.name || call.function.name
          if (call.function?.arguments) existing.args += call.function.arguments
          partialCalls.set(index, existing)

          if (!existing.started && existing.name) {
            existing.started = true
            existing.id ||= `call_${index}_${Date.now().toString(36)}`
            yield { type: 'tool_call_start', index, id: existing.id, name: existing.name }
          }
          if (call.function?.arguments) {
            yield { type: 'tool_call_delta', index, partialJson: call.function.arguments }
          }
        }
      }

      // The SDK ends the iterator quietly on abort; without this check a cancelled
      // turn would look like a normal end_turn (and half a tool call would run).
      if (request.signal?.aborted) {
        yield { type: 'done', stopReason: 'aborted', usage }
        return
      }

      let emitted = 0
      for (const [index, call] of [...partialCalls].sort((a, b) => a[0] - b[0])) {
        if (!call.name) continue
        emitted++
        yield {
          type: 'tool_call_end',
          index,
          id: call.id || `call_${index}`,
          name: call.name,
          input: parseArguments(call.args),
        }
      }

      yield { type: 'usage', usage }
      yield { type: 'done', stopReason: mapFinishReason(finishReason, emitted > 0), usage }
    } catch (err) {
      if (isAbortError(err) || request.signal?.aborted) {
        yield { type: 'done', stopReason: 'aborted', usage }
        return
      }
      yield { type: 'error', error: toModelError(err) }
    }
  }
}

function parseArguments(raw: string): unknown {
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return { __parseError: 'tool input was not valid JSON', __partial: raw.slice(0, 400) }
  }
}

function toOpenAIEffort(effort: SingleAgentEffort): 'low' | 'medium' | 'high' {
  const level = toProviderEffort(effort)
  return level === 'low' ? 'low' : level === 'medium' ? 'medium' : 'high'
}

/** Exported for tests. */
export function toOpenAIMessages(
  request: Pick<ModelRequest, 'system' | 'messages'>,
): OpenAI.ChatCompletionMessageParam[] {
  const system = [request.system.text, request.system.toolGuidance].filter(Boolean).join('\n\n')
  const out: OpenAI.ChatCompletionMessageParam[] = [{ role: 'system', content: system }]

  for (const message of request.messages as readonly AgentMessage[]) {
    const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')

    if (message.role === 'assistant') {
      const toolCalls = message.content.flatMap((b) => (b.type === 'tool_use' ? [b] : []))
      if (toolCalls.length > 0) {
        out.push({
          role: 'assistant',
          content: text || null,
          tool_calls: toolCalls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
          })),
        })
      } else if (text) {
        out.push({ role: 'assistant', content: text })
      }
      continue
    }

    // One `tool` message per result, which must directly follow the assistant
    // message that made the calls. Any free text in the same turn (a nudge, a
    // "continue") goes after them as an ordinary user message.
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue
      const content =
        typeof block.content === 'string'
          ? block.content
          : block.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
      out.push({
        role: 'tool',
        tool_call_id: block.toolUseId,
        content: block.isError ? `Error: ${content}` : content,
      })
    }
    if (text) out.push({ role: 'user', content: text })
  }

  return out
}

function mapFinishReason(reason: string | null, hasToolCalls: boolean): StopReason {
  // A server that reports `stop` while streaming tool arguments is still a
  // tool call; trusting the reason alone loses the call. The exception is a
  // truncated turn, where the arguments cannot be trusted.
  if (reason === 'length') return 'max_tokens'
  if (hasToolCalls) return 'tool_use'
  switch (reason) {
    case 'content_filter':
      return 'refusal'
    case 'tool_calls':
    case 'function_call':
      return 'tool_use'
    default:
      return 'end_turn'
  }
}

function fromErrorPayload(error: { message?: string; code?: unknown }): ModelError {
  const message = error.message ?? 'the server reported an error mid-stream'
  const code = Number(error.code)
  if (code === 401 || code === 403) return ModelError.auth(message)
  if (code === 429) return ModelError.rateLimit(message, 429)
  if (code >= 500)
    return new ModelError(message, { kind: 'overloaded', status: code, retryable: true })
  if (/context.*(length|window)|too many tokens|maximum context/i.test(message)) {
    return ModelError.contextOverflow(message)
  }
  return new ModelError(message, {
    kind: 'invalid_request',
    status: Number.isFinite(code) ? code : undefined,
  })
}

export function toModelError(err: unknown): ModelError {
  if (err instanceof ModelError) return err
  // Subclasses first: APIConnectionTimeoutError extends APIConnectionError,
  // which extends APIError.
  if (err instanceof OpenAI.APIUserAbortError) return ModelError.aborted(err.message)
  if (err instanceof OpenAI.APIConnectionTimeoutError) return ModelError.timeout(err.message)
  if (err instanceof OpenAI.APIConnectionError) return ModelError.connection(err.message, err)
  if (err instanceof OpenAI.APIError) {
    const status = err.status
    // The SDK throws on an `{error}` chunk mid-stream, with no HTTP status.
    if (status === undefined && err.error && typeof err.error === 'object') {
      return fromErrorPayload(err.error as { message?: string; code?: unknown })
    }
    if (status === 401 || status === 403)
      return new ModelError(err.message, { kind: 'auth', status })
    if (status === 429) return ModelError.rateLimit(err.message, 429)
    if (status !== undefined && status >= 500) {
      return new ModelError(err.message, { kind: 'overloaded', status, retryable: true })
    }
    if (
      (err as { code?: unknown }).code === 'context_length_exceeded' ||
      /context.*(length|window)|maximum context|too many tokens|reduce the length/i.test(
        err.message,
      )
    ) {
      return ModelError.contextOverflow(err.message)
    }
    return new ModelError(err.message, { kind: 'invalid_request', status })
  }
  if (isAbortError(err)) return ModelError.aborted()
  return ModelError.unknown(err instanceof Error ? err.message : String(err), err)
}
