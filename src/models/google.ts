import type { ModelProvider } from './provider.js'
import { collectStream } from './provider.js'
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
  type Usage,
} from './types.js'

/**
 * Google AI Studio's Generative Language API adapter.
 *
 * AI Studio exposes Gemini through a REST API rather than a vendor-neutral
 * OpenAI endpoint. This adapter keeps that wire format at the provider edge:
 * the runtime still only sees Flex messages, tool calls, usage, and stream
 * events. It deliberately uses fetch instead of adding another SDK so custom
 * proxies and the Node 22 runtime work the same way.
 */

export interface GoogleAIStudioProviderOptions {
  apiKey?: string
  /** Usually https://generativelanguage.googleapis.com/v1beta. */
  baseURL?: string
  defaultModel?: string
  contextWindow?: number
  maxOutputTokens?: number
  timeoutMs?: number
}

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
const DEFAULT_CONTEXT_WINDOW = 1_000_000
const DEFAULT_MAX_OUTPUT = 65_536

export const GOOGLE_AI_STUDIO_MODELS: readonly ModelInfo[] = [
  {
    id: 'gemini-2.5-pro',
    label: 'Gemini 2.5 Pro',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: DEFAULT_MAX_OUTPUT,
    supportsTools: true,
    supportsThinking: true,
    supportsEffort: true,
    supportsWebSearch: false,
    supportsPromptCaching: false,
    nativeEfforts: ['low', 'medium', 'high', 'xhigh', 'pro', 'max'],
  },
  {
    id: 'gemini-2.5-flash',
    label: 'Gemini 2.5 Flash',
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxOutputTokens: DEFAULT_MAX_OUTPUT,
    supportsTools: true,
    supportsThinking: true,
    supportsEffort: true,
    supportsWebSearch: false,
    supportsPromptCaching: false,
    nativeEfforts: ['low', 'medium', 'high', 'xhigh', 'pro', 'max'],
  },
  {
    id: 'gemini-2.0-flash',
    label: 'Gemini 2.0 Flash',
    contextWindow: 1_048_576,
    maxOutputTokens: 8_192,
    supportsTools: true,
    supportsThinking: false,
    supportsEffort: false,
    supportsWebSearch: false,
    supportsPromptCaching: false,
  },
]

const GOOGLE_MODEL_PREFIX = /^gemini-/i

interface GooglePart {
  text?: string
  thought?: boolean
  functionCall?: {
    name?: string
    args?: Record<string, unknown>
    id?: string
  }
  functionResponse?: {
    name?: string
    response?: unknown
  }
}

interface GoogleContent {
  role: 'user' | 'model'
  parts: GooglePart[]
}

interface GoogleCandidate {
  content?: { parts?: GooglePart[] }
  finishReason?: string
}

interface GoogleResponse {
  responseId?: string
  modelVersion?: string
  candidates?: GoogleCandidate[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    thoughtsTokenCount?: number
  }
  promptFeedback?: { blockReason?: string }
}

interface GoogleStreamCall {
  id: string
  name: string
  args: Record<string, unknown>
  index: number
}

class GoogleAPIError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'GoogleAPIError'
    this.status = status
  }
}

export class GoogleAIStudioProvider implements ModelProvider {
  readonly id = 'google'
  readonly label = 'Google AI Studio'
  readonly #options: Required<Pick<GoogleAIStudioProviderOptions, 'baseURL' | 'timeoutMs'>> &
    Omit<GoogleAIStudioProviderOptions, 'baseURL' | 'timeoutMs'>
  readonly #models: ModelInfo[]

  constructor(options: GoogleAIStudioProviderOptions = {}) {
    this.#options = {
      ...options,
      apiKey:
        options.apiKey ??
        process.env.FLEX_GOOGLE_API_KEY ??
        process.env.FLEX_GEMINI_API_KEY ??
        process.env.GEMINI_API_KEY ??
        process.env.GOOGLE_API_KEY ??
        process.env.GOOGLE_AI_API_KEY ??
        process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
        process.env.GOOGLE_AI_STUDIO_API_KEY,
      baseURL: normalizeGoogleBaseURL(
        options.baseURL ??
          process.env.FLEX_GOOGLE_BASE_URL ??
          process.env.GOOGLE_AI_BASE_URL ??
          process.env.GEMINI_BASE_URL ??
          DEFAULT_BASE_URL,
      ),
      defaultModel: options.defaultModel ?? process.env.FLEX_GOOGLE_MODEL ?? 'gemini-2.5-flash',
      timeoutMs: options.timeoutMs ?? 300_000,
    }
    this.#models = [...GOOGLE_AI_STUDIO_MODELS]
    if (
      this.#options.defaultModel &&
      !this.#models.some((model) => model.id === this.#options.defaultModel)
    ) {
      this.#models.push(this.#modelForId(this.#options.defaultModel))
    }
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    if (!this.#options.apiKey) return { ok: false, reason: 'GEMINI_API_KEY is not set' }
    try {
      const response = await this.#fetch(`${this.#options.baseURL}/models`)
      if (!response.ok) {
        return { ok: false, reason: `Google AI Studio returned HTTP ${response.status}` }
      }
      return { ok: true }
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      }
    }
  }

  listModels(): ModelInfo[] {
    return this.#models
  }

  resolveModel(spec: string): ModelInfo | undefined {
    const normalized = stripProviderPrefix(spec.trim())
    if (!normalized) {
      const id = this.#options.defaultModel
      return id ? this.#modelForId(id) : undefined
    }
    const known = this.#models.find((model) => model.id === normalized)
    if (known) return known
    // AI Studio adds models independently of Flex releases. Accept Gemini ids
    // not in the baked-in catalogue with conservative capabilities.
    if (GOOGLE_MODEL_PREFIX.test(normalized)) {
      return {
        id: normalized,
        label: normalized,
        contextWindow: this.#options.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        maxOutputTokens: this.#options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT,
        supportsTools: true,
        supportsThinking: /2\.5|3\./i.test(normalized),
        supportsEffort: /2\.5|3\./i.test(normalized),
        supportsWebSearch: false,
        supportsPromptCaching: false,
      }
    }
    return undefined
  }

  stream(request: ModelRequest): AsyncGenerator<StreamEvent> {
    return this.#runStream(request)
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    return collectStream(this.#runStream(request))
  }

  async *#runStream(request: ModelRequest): AsyncGenerator<StreamEvent> {
    const model = this.resolveModel(request.model)?.id ?? stripProviderPrefix(request.model)
    const usage: Usage = { inputTokens: 0, outputTokens: 0 }
    const calls = new Map<number, GoogleStreamCall>()
    let stopReason: StopReason = 'end_turn'

    try {
      const response = await this.#fetch(
        `${this.#options.baseURL}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
        {
          method: 'POST',
          body: JSON.stringify(toGoogleRequest(request, this.resolveModel(request.model))),
        },
        request.signal,
      )
      await assertGoogleResponse(response)

      yield { type: 'message_start', id: `gemini-${model}`, model }
      if (!response.body) throw new Error('Google AI Studio returned an empty streaming body')

      for await (const value of readSse(response.body)) {
        const chunk = value as GoogleResponse
        if (chunk.usageMetadata) {
          usage.inputTokens = chunk.usageMetadata.promptTokenCount ?? usage.inputTokens
          usage.outputTokens = chunk.usageMetadata.candidatesTokenCount ?? usage.outputTokens
          if (chunk.usageMetadata.thoughtsTokenCount !== undefined) {
            usage.reasoningTokens = chunk.usageMetadata.thoughtsTokenCount
          }
          yield { type: 'usage', usage: { ...usage } }
        }

        const candidate = chunk.candidates?.[0]
        if (!candidate) {
          if (chunk.promptFeedback?.blockReason) stopReason = 'refusal'
          continue
        }
        if (candidate.finishReason) {
          stopReason = mapFinishReason(candidate.finishReason, calls.size > 0)
        }

        for (const part of candidate.content?.parts ?? []) {
          if (part.text) {
            if (part.thought) yield { type: 'thinking_delta', thinking: part.text }
            else yield { type: 'text_delta', text: part.text }
          }
          if (part.functionCall?.name) {
            const index = calls.size
            const existing = [...calls.values()].find(
              (call) => call.name === part.functionCall?.name,
            )
            const call =
              existing ??
              (() => {
                const next: GoogleStreamCall = {
                  id: part.functionCall?.id ?? `call_${index}`,
                  name: part.functionCall?.name ?? '',
                  args: {},
                  index,
                }
                calls.set(index, next)
                return next
              })()
            Object.assign(call.args, part.functionCall.args ?? {})
            if (call.args && Object.keys(part.functionCall.args ?? {}).length > 0) {
              yield {
                type: 'tool_call_delta',
                index: call.index,
                partialJson: JSON.stringify(part.functionCall.args),
              }
            }
            if (call.index === index && call.name) {
              yield { type: 'tool_call_start', index: call.index, id: call.id, name: call.name }
            }
          }
        }
      }

      // Tool calls are represented by complete JSON objects by Gemini. Emit
      // them only after the SSE stream ends so interleaved candidates cannot
      // cause the runtime to execute a partially assembled call.
      for (const call of calls.values()) {
        yield {
          type: 'tool_call_end',
          index: call.index,
          id: call.id,
          name: call.name,
          input: call.args,
        }
      }
      yield { type: 'usage', usage: { ...usage } }
      yield {
        type: 'done',
        stopReason: calls.size > 0 ? 'tool_use' : stopReason,
        usage: { ...usage },
      }
    } catch (err) {
      if (isAbortError(err)) {
        yield { type: 'done', stopReason: 'aborted', usage: { ...usage } }
      } else {
        yield { type: 'error', error: toGoogleModelError(err) }
      }
    }
  }

  #fetch(url: string, init: RequestInit = {}, requestSignal?: AbortSignal): Promise<Response> {
    if (!this.#options.apiKey) {
      return Promise.reject(ModelError.auth('GEMINI_API_KEY is not set'))
    }
    const separator = url.includes('?') ? '&' : '?'
    const signal = requestSignal
      ? AbortSignal.any([requestSignal, AbortSignal.timeout(this.#options.timeoutMs)])
      : AbortSignal.timeout(this.#options.timeoutMs)
    return fetch(`${url}${separator}key=${encodeURIComponent(this.#options.apiKey)}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
      signal,
    })
  }

  #modelForId(id: string): ModelInfo {
    return (
      this.#models.find((model) => model.id === id) ?? {
        id,
        label: id,
        contextWindow: this.#options.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        maxOutputTokens: this.#options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT,
        supportsTools: true,
        supportsThinking: /2\.5|3\./i.test(id),
        supportsEffort: /2\.5|3\./i.test(id),
        supportsWebSearch: false,
        supportsPromptCaching: false,
      }
    )
  }
}

function normalizeGoogleBaseURL(value: string): string {
  const raw = value.trim() || DEFAULT_BASE_URL
  try {
    const url = new URL(raw)
    if (!url.pathname || url.pathname === '/') url.pathname = '/v1beta'
    return url.toString().replace(/\/$/, '')
  } catch {
    return raw.replace(/\/$/, '')
  }
}

function stripProviderPrefix(spec: string): string {
  return /^(?:google|gemini):/i.test(spec) ? spec.slice(spec.indexOf(':') + 1) : spec
}

function toGoogleRequest(
  request: ModelRequest,
  info: ModelInfo | undefined,
): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: request.maxOutputTokens ?? info?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT,
  }
  if (request.temperature !== undefined) generationConfig.temperature = request.temperature
  if (info?.supportsThinking && request.effort) {
    generationConfig.thinkingConfig = {
      includeThoughts: true,
      thinkingBudget: googleThinkingBudget(request.effort),
    }
  }

  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: request.system.text }] },
    contents: toGoogleContents(request.messages),
    generationConfig,
  }
  if (request.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        })),
      },
    ]
  }
  return body
}

function toGoogleContents(messages: ModelRequest['messages']): GoogleContent[] {
  const toolNames = new Map<string, string>()
  const contents: GoogleContent[] = []

  for (const message of messages) {
    const textParts = message.content
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => ({ text: block.text }))
    const calls = message.content.filter((block) => block.type === 'tool_use')
    const results = message.content.filter((block) => block.type === 'tool_result')
    const parts: GooglePart[] = [...textParts]

    for (const block of calls) {
      if (block.type !== 'tool_use') continue
      toolNames.set(block.id, block.name)
      parts.push({ functionCall: { name: block.name, args: asObject(block.input) } })
    }
    for (const block of results) {
      if (block.type !== 'tool_result') continue
      const content =
        typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
      parts.push({
        functionResponse: {
          name: toolNames.get(block.toolUseId) ?? block.toolUseId,
          response: block.isError ? { error: content } : { output: content },
        },
      })
    }

    if (parts.length > 0) {
      contents.push({ role: message.role === 'assistant' ? 'model' : 'user', parts })
    }
  }
  return contents
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function googleThinkingBudget(effort: SingleAgentEffort): number {
  switch (effort) {
    case 'low':
      return 1_024
    case 'medium':
      return 4_096
    case 'high':
      return 8_192
    case 'xhigh':
      return 16_384
    case 'pro':
      return 24_576
    case 'max':
      return 32_768
  }
}

function mapFinishReason(reason: string, hasToolCalls: boolean): StopReason {
  if (hasToolCalls || (reason === 'STOP' && hasToolCalls)) return 'tool_use'
  switch (reason) {
    case 'MAX_TOKENS':
      return 'max_tokens'
    case 'SAFETY':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
      return 'refusal'
    case 'MALFORMED_FUNCTION_CALL':
      return 'error'
    default:
      return 'end_turn'
  }
}

async function assertGoogleResponse(response: Response): Promise<void> {
  if (response.ok) return
  const body = await response.text().catch(() => '')
  let message = body
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } }
    message = parsed.error?.message ?? body
  } catch {
    // Keep the plain response body.
  }
  throw new GoogleAPIError(
    message || `Google AI Studio returned HTTP ${response.status}`,
    response.status,
  )
}

async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const data = line.trim()
        if (!data.startsWith('data:')) continue
        const payload = data.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        yield JSON.parse(payload)
      }
    }
    buffer += decoder.decode()
    const data = buffer.trim()
    if (data.startsWith('data:')) {
      const payload = data.slice(5).trim()
      if (payload && payload !== '[DONE]') yield JSON.parse(payload)
    }
  } finally {
    reader.releaseLock()
  }
}

function toGoogleModelError(err: unknown): ModelError {
  if (err instanceof ModelError) return err
  if (err instanceof GoogleAPIError) {
    if (err.status === 401 || err.status === 403) return ModelError.auth(err.message)
    if (err.status === 429) return ModelError.rateLimit(err.message, err.status)
    if (err.status >= 500) return ModelError.overloaded(err.message, err.status)
    if (/context|token|too long/i.test(err.message)) return ModelError.contextOverflow(err.message)
    return ModelError.invalidRequest(err.message, err.status)
  }
  if (isAbortError(err)) return ModelError.aborted()
  if (err instanceof Error && err.name === 'TimeoutError') return ModelError.timeout(err.message)
  if (err instanceof TypeError) return ModelError.connection(err.message, err)
  return ModelError.unknown(err instanceof Error ? err.message : String(err), err)
}

export { toGoogleContents, toGoogleRequest }
