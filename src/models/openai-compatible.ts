import OpenAI from 'openai'
import { collectStream, type ModelProvider } from './provider.js'
import {
  isAbortError,
  ModelError,
  type ModelInfo,
  type ModelRequest,
  type ModelResponse,
  type StopReason,
  type StreamEvent,
  type Usage,
} from './types.js'

/**
 * OpenAI-compatible provider.
 *
 * One adapter covers OpenAI, DeepSeek, Ollama, vLLM, LM Studio, OpenRouter and
 * anything else that serves `POST /chat/completions`. Two details matter more
 * than they look:
 *
 *  - `delta.tool_calls[].index` is the only stable key across chunks. Array
 *    position is not guaranteed, and `id`/`name` arrive only on the first
 *    chunk for an index.
 *  - `finish_reason` is `'length'`, not `'max_tokens'`, and usage rides on a
 *    final chunk whose `choices` array is empty. Reading `choices[0]` there
 *    throws, so it is handled explicitly below.
 *
 * Effort, thinking, and prompt caching are dropped: no OpenAI-compatible server
 * honours them, and sending them anyway is how you get a 400 from a strict one.
 */

export interface OpenAICompatibleOptions {
  /** The endpoint root. `/v1` is added when the URL has no path. */
  baseURL?: string
  apiKey?: string
  defaultModel?: string
  /** Context window to assume; servers do not reliably report it. */
  contextWindow?: number
  maxOutputTokens?: number
  timeoutMs?: number
  /** Some local servers reject `stream_options`; disable it when necessary. */
  includeUsage?: boolean
}

/** Models offered when the server does not advertise a catalogue. */
function defaultModels(baseURL: string, contextWindow: number): ModelInfo[] {
  return [
    {
      id: 'gpt-4o',
      label: 'GPT-4o',
      contextWindow,
      maxOutputTokens: 16_384,
      supportsTools: true,
      supportsThinking: false,
      supportsEffort: false,
      supportsWebSearch: false,
      supportsPromptCaching: false,
    },
    {
      id: 'deepseek-chat',
      label: 'DeepSeek Chat',
      contextWindow,
      maxOutputTokens: 8_192,
      supportsTools: true,
      supportsThinking: false,
      supportsEffort: false,
      supportsWebSearch: false,
      supportsPromptCaching: false,
    },
    {
      id: 'qwen2.5-coder',
      label: 'Qwen Coder (local)',
      contextWindow,
      maxOutputTokens: 8_192,
      supportsTools: true,
      supportsThinking: false,
      supportsEffort: false,
      supportsWebSearch: false,
      supportsPromptCaching: false,
    },
  ].map((model) => ({ ...model, alias: baseURL }))
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = 'openai-compatible'
  readonly label = 'OpenAI-compatible'
  readonly #client: OpenAI
  readonly #options: Required<
    Pick<OpenAICompatibleOptions, 'baseURL' | 'timeoutMs' | 'includeUsage'>
  > &
    Omit<OpenAICompatibleOptions, 'baseURL' | 'timeoutMs' | 'includeUsage'>
  #models: ModelInfo[] | null = null

  constructor(options: OpenAICompatibleOptions = {}) {
    this.#options = {
      ...options,
      baseURL: normalizeBaseURL(
        options.baseURL ?? process.env.FLEX_OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL,
      ),
      apiKey:
        options.apiKey ??
        process.env.FLEX_OPENAI_API_KEY ??
        process.env.OPENAI_API_KEY ??
        'not-needed',
      defaultModel: options.defaultModel ?? process.env.FLEX_OPENAI_MODEL ?? 'gpt-4o',
      timeoutMs: options.timeoutMs ?? 300_000,
      includeUsage: options.includeUsage ?? true,
    }
    this.#client = new OpenAI({
      baseURL: this.#options.baseURL,
      apiKey: this.#options.apiKey,
      maxRetries: 2,
      timeout: this.#options.timeoutMs,
    })
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    try {
      await this.#client.models.list()
      return { ok: true }
    } catch (err) {
      return {
        ok: false,
        reason: `cannot reach ${this.#options.baseURL}: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  listModels(): ModelInfo[] {
    if (!this.#models) {
      this.#models = defaultModels(this.#options.baseURL, this.#options.contextWindow ?? 128_000)
    }
    return this.#models
  }

  resolveModel(spec: string): ModelInfo | undefined {
    const normalized = spec.trim()
    if (!normalized) {
      return this.#options.defaultModel
        ? ({
            ...this.listModels()[0],
            id: this.#options.defaultModel,
            label: this.#options.defaultModel,
          } as ModelInfo)
        : undefined
    }
    const known = this.listModels().find((m) => m.id === normalized)
    if (known) return known
    // Servers accept arbitrary model ids and a local server's catalogue is not
    // knowable ahead of time, so an unknown id is assumed valid rather than
    // rejected — with conservative capability assumptions.
    return {
      id: normalized,
      label: normalized,
      contextWindow: this.#options.contextWindow ?? 128_000,
      maxOutputTokens: this.#options.maxOutputTokens ?? 8_192,
      supportsTools: true,
      supportsThinking: false,
      supportsEffort: false,
      supportsWebSearch: false,
      supportsPromptCaching: false,
    }
  }

  stream(request: ModelRequest): AsyncGenerator<StreamEvent> {
    return this.#runStream(request)
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    return collectStream(this.#runStream(request))
  }

  async *#runStream(request: ModelRequest): AsyncGenerator<StreamEvent> {
    const model = this.resolveModel(request.model)?.id ?? request.model
    const maxTokens = request.maxOutputTokens ?? this.#options.maxOutputTokens ?? 8_192

    const messages = toOpenAIMessages(request)

    /** Keyed by the provider's own index, which is the only stable identifier. */
    const partialCalls = new Map<
      number,
      { id: string; name: string; args: string; started: boolean }
    >()
    let usage: Usage = { inputTokens: 0, outputTokens: 0 }
    let finishReason: string | null = null

    try {
      const stream = await this.#client.chat.completions.create(
        {
          model,
          messages,
          max_tokens: maxTokens,
          stream: true,
          // OpenAI reports usage on a final choices-less chunk. Some local
          // servers reject this otherwise optional extension.
          ...(this.#options.includeUsage ? { stream_options: { include_usage: true } } : {}),
          ...(request.tools.length > 0
            ? {
                tools: request.tools.map((tool) => ({
                  type: 'function' as const,
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.inputSchema,
                  },
                })),
              }
            : {}),
        },
        request.signal ? { signal: request.signal } : undefined,
      )

      yield { type: 'message_start', id: `chatcmpl-${model}`, model }

      for await (const chunk of stream) {
        // The usage-only chunk at the end carries an empty choices array.
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
          }
          yield { type: 'usage', usage }
        }

        const choice = chunk.choices[0]
        if (!choice) continue

        if (choice.finish_reason) finishReason = choice.finish_reason

        const delta = choice.delta
        if (delta.content) yield { type: 'text_delta', text: delta.content }
        // Reasoning models return their scratchpad outside the standard shape.
        const reasoning = (delta as { reasoning_content?: string | null }).reasoning_content
        if (reasoning) yield { type: 'thinking_delta', thinking: reasoning }

        for (const call of delta.tool_calls ?? []) {
          const index = call.index
          const existing = partialCalls.get(index) ?? {
            id: '',
            name: '',
            args: '',
            started: false,
          }
          // `id` and `name` arrive only on the first chunk for this index.
          if (call.id) existing.id = call.id
          if (call.function?.name) existing.name = call.function.name
          if (call.function?.arguments) existing.args += call.function.arguments
          partialCalls.set(index, existing)

          if (!existing.started && existing.name) {
            existing.started = true
            yield { type: 'tool_call_start', index, id: existing.id, name: existing.name }
          }
          if (call.function?.arguments) {
            yield { type: 'tool_call_delta', index, partialJson: call.function.arguments }
          }
        }
      }

      for (const [index, call] of partialCalls) {
        let input: unknown = {}
        try {
          input = call.args ? JSON.parse(call.args) : {}
        } catch {
          input = {
            __parseError: 'tool input was not valid JSON',
            __partial: call.args.slice(0, 400),
          }
        }
        yield {
          type: 'tool_call_end',
          index,
          id: call.id || `call_${index}`,
          name: call.name,
          input,
        }
      }

      yield { type: 'usage', usage }
      yield {
        type: 'done',
        stopReason: mapFinishReason(finishReason, partialCalls.size > 0),
        usage,
      }
    } catch (err) {
      if (isAbortError(err)) {
        yield { type: 'done', stopReason: 'aborted', usage }
        return
      }
      yield { type: 'error', error: toModelError(err) }
    }
  }
}

function toOpenAIMessages(request: ModelRequest): OpenAI.ChatCompletionMessageParam[] {
  const systemText = request.system.toolGuidance
    ? `${request.system.text}\n\n${request.system.toolGuidance}`
    : request.system.text
  const out: OpenAI.ChatCompletionMessageParam[] = [{ role: 'system', content: systemText }]

  for (const message of request.messages) {
    const toolResults = message.content.filter((b) => b.type === 'tool_result')
    if (toolResults.length > 0) {
      // One `tool` message per result, in the same order the calls were made.
      for (const block of toolResults) {
        if (block.type !== 'tool_result') continue
        out.push({
          role: 'tool',
          tool_call_id: block.toolUseId,
          content:
            typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
        })
      }
      continue
    }

    const text = message.content
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('')
    const toolCalls = message.content.filter((b) => b.type === 'tool_use')

    if (toolCalls.length > 0) {
      out.push({
        role: 'assistant',
        content: text || null,
        tool_calls: toolCalls.map((b) => {
          const call = b as { id: string; name: string; input: unknown }
          return {
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
          }
        }),
      })
      continue
    }

    if (text) out.push({ role: message.role, content: text })
  }

  return out
}

function mapFinishReason(reason: string | null, hasToolCalls: boolean): StopReason {
  // A server that reports `stop` while streaming tool arguments is still a
  // tool call; trusting the reason alone loses the call.
  if (hasToolCalls) return 'tool_use'
  switch (reason) {
    case 'length':
      return 'max_tokens'
    case 'content_filter':
      return 'refusal'
    case 'tool_calls':
      return 'tool_use'
    default:
      return 'end_turn'
  }
}

function normalizeBaseURL(value: string | undefined): string {
  const raw = value?.trim() || 'https://api.openai.com/v1'
  try {
    const url = new URL(raw)
    if (!url.pathname || url.pathname === '/') url.pathname = '/v1'
    return url.toString().replace(/\/$/, '')
  } catch {
    // Let the SDK produce its normal actionable URL error, while still
    // avoiding a surprising `/v1/v1` for a simple custom endpoint.
    return raw.replace(/\/$/, '')
  }
}

function toModelError(err: unknown): ModelError {
  if (err instanceof ModelError) return err
  if (err instanceof OpenAI.APIError) {
    const status = err.status
    if (status === 401 || status === 403) return ModelError.auth(err.message)
    if (status === 429) return ModelError.rateLimit(err.message, 429)
    if (status !== undefined && status >= 500) {
      return new ModelError(err.message, { kind: 'overloaded', status, retryable: true })
    }
    return new ModelError(err.message, { kind: 'invalid_request', status })
  }
  if (err instanceof OpenAI.APIConnectionTimeoutError) return ModelError.timeout(err.message)
  if (err instanceof OpenAI.APIConnectionError) return ModelError.connection(err.message, err)
  if (isAbortError(err)) return ModelError.aborted()
  return ModelError.unknown(err instanceof Error ? err.message : String(err), err)
}
