import type { ModelProvider } from './provider.js'
import { collectStream } from './provider.js'
import { toGeminiSchema } from './schema.js'
import { readSSE } from './sse.js'
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
 * Google AI Studio (Gemini API) adapter.
 *
 * Talks to `generativelanguage.googleapis.com` over plain HTTPS + SSE rather
 * than through a vendor SDK: the wire format is small and stable, the adapter
 * stays dependency-free, and `baseURL` can point at any Gemini-compatible
 * gateway or a local test server.
 *
 * Details that matter more than they look:
 *
 *  - Roles are `user` and `model`, and consecutive turns of one role are
 *    merged. Tool results are `functionResponse` parts in a *user* turn.
 *  - Function calls carry no id on most models, so Flex mints one. Gemini 3
 *    additionally returns a `thoughtSignature` on the call that must be echoed
 *    back verbatim on the next request; it rides in `ToolUseBlock.providerMeta`.
 *  - Function declarations take an OpenAPI subset, not JSON Schema — see
 *    `toGeminiSchema`.
 *  - Auth is the `x-goog-api-key` header, never a query string, so the key does
 *    not land in proxy logs or error messages.
 */

export interface GoogleProviderOptions {
  apiKey?: string
  /** Defaults to the public v1beta endpoint. Must not end in a model path. */
  baseURL?: string
  headers?: Record<string, string>
  maxRetries?: number
  /** Milliseconds to wait for response *headers*. The stream itself is not timed. */
  timeoutMs?: number
  models?: ReadonlyArray<string | (Partial<ModelInfo> & { id: string })>
  defaultModel?: string
  id?: string
  label?: string
}

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'
const GEMINI_3_MEDIUM_UNSUPPORTED = /pro/i

function model(id: string, label: string, extra: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id,
    label,
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
    supportsTools: true,
    supportsThinking: true,
    supportsEffort: true,
    supportsWebSearch: false,
    supportsPromptCaching: false,
    provider: 'google',
    ...extra,
  }
}

/** Best first. Unlisted `gemini-*` ids are still accepted by `resolveModel`. */
export const GOOGLE_MODELS: readonly ModelInfo[] = [
  model('gemini-3.1-pro-preview', 'Gemini 3.1 Pro'),
  model('gemini-3-flash-preview', 'Gemini 3 Flash'),
  model('gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite'),
  model('gemini-2.5-pro', 'Gemini 2.5 Pro'),
  model('gemini-2.5-flash', 'Gemini 2.5 Flash'),
  model('gemini-2.5-flash-lite', 'Gemini 2.5 Flash-Lite'),
]

const ALIASES: Record<string, string> = {
  gemini: 'gemini-3.1-pro-preview',
  'gemini-pro': 'gemini-3.1-pro-preview',
  pro: 'gemini-3.1-pro-preview',
  flash: 'gemini-3-flash-preview',
  'gemini-flash': 'gemini-3-flash-preview',
  'flash-lite': 'gemini-3.1-flash-lite',
}

/** The value Gemini documents for replaying a call whose signature we never saw. */
const SKIP_SIGNATURE = 'skip_thought_signature_validator'

// --- wire types (only what is read or written) -----------------------------

interface GeminiPart {
  text?: string
  thought?: boolean
  thoughtSignature?: string
  functionCall?: { name: string; args?: unknown; id?: string }
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string }
}

interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

interface GeminiChunk {
  candidates?: Array<{
    content?: { parts?: GeminiPart[] }
    finishReason?: string
    finishMessage?: string
  }>
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    thoughtsTokenCount?: number
    cachedContentTokenCount?: number
    totalTokenCount?: number
  }
  promptFeedback?: { blockReason?: string }
  responseId?: string
  modelVersion?: string
  error?: { code?: number; message?: string; status?: string }
}

export class GoogleProvider implements ModelProvider {
  readonly id: string
  readonly label: string
  readonly aliases = ['gemini', 'ai-studio', 'aistudio', 'google-ai'] as const
  readonly #apiKey: string | undefined
  readonly #baseURL: string
  readonly #headers: Record<string, string>
  readonly #maxRetries: number
  readonly #timeoutMs: number
  readonly #defaultModel: string | undefined
  #models: ModelInfo[]

  constructor(options: GoogleProviderOptions = {}) {
    this.id = options.id ?? 'google'
    this.label = options.label ?? 'Google AI Studio'
    this.#apiKey =
      options.apiKey ??
      process.env.GEMINI_API_KEY ??
      process.env.GOOGLE_API_KEY ??
      process.env.GOOGLE_GENERATIVE_AI_API_KEY
    this.#baseURL = (options.baseURL ?? process.env.GEMINI_BASE_URL ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      '',
    )
    this.#headers = options.headers ?? {}
    this.#maxRetries = options.maxRetries ?? 2
    this.#timeoutMs = options.timeoutMs ?? 120_000
    this.#defaultModel = options.defaultModel
    const catalogue: ModelInfo[] = options.models
      ? options.models.map((m) =>
          typeof m === 'string' ? model(m, m) : { ...model(m.id, m.label ?? m.id), ...m },
        )
      : [...GOOGLE_MODELS]
    this.#models = catalogue.map((m) => ({ ...m, provider: this.id }))
  }

  configured(): boolean {
    return Boolean(this.#apiKey)
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    if (this.#apiKey) return { ok: true }
    return { ok: false, reason: 'GEMINI_API_KEY (or GOOGLE_API_KEY) is not set' }
  }

  listModels(): ModelInfo[] {
    return this.#models
  }

  resolveModel(spec: string): ModelInfo | undefined {
    let normalized = spec.trim()
    if (!normalized) {
      return this.#defaultModel ? this.resolveModel(this.#defaultModel) : this.#models[0]
    }
    normalized = normalized.replace(/^models\//, '')
    const lower = normalized.toLowerCase()
    const direct = this.#models.find((m) => m.id.toLowerCase() === lower)
    if (direct) return direct
    const aliased = ALIASES[lower]
    if (aliased) return this.#models.find((m) => m.id === aliased) ?? this.#models[0]
    // Any other Gemini/Gemma id is served by the same API; capabilities are
    // assumed from the family rather than rejecting a model released yesterday.
    if (/^(gemini|gemma)-/i.test(normalized)) {
      return model(normalized, normalized, {
        provider: this.id,
        supportsThinking: /^gemini-(2\.5|[3-9])/i.test(normalized),
        supportsEffort: /^gemini-(2\.5|[3-9])/i.test(normalized),
        contextWindow: /^gemma/i.test(normalized) ? 128_000 : 1_048_576,
        maxOutputTokens: /^gemma/i.test(normalized) ? 8_192 : 65_536,
        supportsTools: !/^gemma/i.test(normalized),
      })
    }
    return undefined
  }

  /** Replace the static catalogue with what the API says this key can call. */
  async refreshModels(signal?: AbortSignal): Promise<void> {
    if (!this.#apiKey) return
    try {
      const response = await fetch(`${this.#baseURL}/models?pageSize=200`, {
        headers: this.#requestHeaders(),
        signal: signal ?? AbortSignal.timeout(10_000),
      })
      if (!response.ok) return
      const body = (await response.json()) as {
        models?: Array<{
          name?: string
          displayName?: string
          inputTokenLimit?: number
          outputTokenLimit?: number
          supportedGenerationMethods?: string[]
        }>
      }
      const found: ModelInfo[] = []
      for (const m of body.models ?? []) {
        const id = m.name?.replace(/^models\//, '')
        if (!id || !/^gemini-/i.test(id)) continue
        if (!m.supportedGenerationMethods?.includes('generateContent')) continue
        if (/(tts|image|embedding|live|audio|transcribe|robotics|computer-use)/i.test(id)) continue
        const known = this.resolveModel(id)
        found.push({
          ...(known ?? model(id, id)),
          id,
          label: known && known.id === id ? known.label : (m.displayName ?? id),
          contextWindow: m.inputTokenLimit ?? known?.contextWindow ?? 1_048_576,
          maxOutputTokens: m.outputTokenLimit ?? known?.maxOutputTokens ?? 65_536,
          provider: this.id,
        })
      }
      if (found.length > 0) {
        // Keep the curated order for models we know; append the rest.
        const rank = (id: string) => {
          const i = GOOGLE_MODELS.findIndex((g) => g.id === id)
          return i === -1 ? GOOGLE_MODELS.length : i
        }
        this.#models = found.sort((a, b) => rank(a.id) - rank(b.id))
      }
    } catch {
      /* the static catalogue stays in place */
    }
  }

  stream(request: ModelRequest): AsyncGenerator<StreamEvent> {
    return this.#runStream(request)
  }

  complete(request: ModelRequest): Promise<ModelResponse> {
    return collectStream(this.#runStream(request))
  }

  // ---------------------------------------------------------------------------

  #requestHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      ...(this.#apiKey ? { 'x-goog-api-key': this.#apiKey } : {}),
      ...this.#headers,
    }
  }

  async *#runStream(request: ModelRequest): AsyncGenerator<StreamEvent> {
    const info = this.resolveModel(request.model)
    const wireModel = (info?.id ?? request.model).replace(/^models\//, '')
    let usage: Usage = { inputTokens: 0, outputTokens: 0 }

    if (!this.#apiKey) {
      yield {
        type: 'error',
        error: ModelError.auth('No Gemini API key. Set GEMINI_API_KEY (or GOOGLE_API_KEY).'),
      }
      return
    }

    try {
      const body = buildBody(request, wireModel, info)
      const response = await this.#post(`${wireModel}:streamGenerateContent?alt=sse`, body, request)
      if (!response.ok) {
        yield { type: 'error', error: await errorFromResponse(response) }
        return
      }
      if (!response.body) {
        yield { type: 'error', error: ModelError.connection('empty response body from Gemini') }
        return
      }

      yield { type: 'message_start', id: `gemini-${Date.now().toString(36)}`, model: wireModel }

      let callCount = 0
      let sawCall = false
      let finish: string | undefined
      let blocked: string | undefined
      let finishMessage: string | undefined
      let text = false

      for await (const message of readSSE(response.body)) {
        if (!message.data || message.data === '[DONE]') continue
        let chunk: GeminiChunk
        try {
          chunk = JSON.parse(message.data) as GeminiChunk
        } catch {
          continue
        }
        if (chunk.error) {
          yield {
            type: 'error',
            error: mapGeminiError(chunk.error.code, chunk.error.status, chunk.error.message),
          }
          return
        }
        if (chunk.usageMetadata) {
          const u = chunk.usageMetadata
          usage = {
            inputTokens: u.promptTokenCount ?? usage.inputTokens,
            // Thinking tokens are billed as output but reported separately.
            outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
            ...(u.cachedContentTokenCount ? { cacheReadTokens: u.cachedContentTokenCount } : {}),
            ...(u.thoughtsTokenCount ? { reasoningTokens: u.thoughtsTokenCount } : {}),
          }
        }
        if (chunk.promptFeedback?.blockReason) blocked = chunk.promptFeedback.blockReason

        const candidate = chunk.candidates?.[0]
        if (!candidate) continue
        if (candidate.finishReason) finish = candidate.finishReason
        if (candidate.finishMessage) finishMessage = candidate.finishMessage

        for (const part of candidate.content?.parts ?? []) {
          if (part.functionCall) {
            const index = callCount++
            sawCall = true
            const id = part.functionCall.id || `gemini-call-${index}-${Date.now().toString(36)}`
            const input = isPlainObject(part.functionCall.args) ? part.functionCall.args : {}
            const providerMeta: Record<string, unknown> = {}
            if (part.thoughtSignature) providerMeta.thoughtSignature = part.thoughtSignature
            if (part.functionCall.id) providerMeta.callId = part.functionCall.id
            yield { type: 'tool_call_start', index, id, name: part.functionCall.name }
            yield { type: 'tool_call_delta', index, partialJson: JSON.stringify(input) }
            yield {
              type: 'tool_call_end',
              index,
              id,
              name: part.functionCall.name,
              input,
              ...(Object.keys(providerMeta).length > 0 ? { providerMeta } : {}),
            }
          } else if (typeof part.text === 'string' && part.text !== '') {
            if (part.thought) yield { type: 'thinking_delta', thinking: part.text }
            else {
              text = true
              yield { type: 'text_delta', text: part.text }
            }
          }
        }
      }

      yield { type: 'usage', usage }

      if (blocked && !text && !sawCall) {
        yield {
          type: 'done',
          stopReason: 'refusal',
          usage,
        }
        return
      }
      if (finish === 'MALFORMED_FUNCTION_CALL' && !sawCall) {
        yield {
          type: 'error',
          error: new ModelError(
            `Gemini produced a malformed function call${finishMessage ? `: ${finishMessage}` : ''}. Retrying usually succeeds.`,
            { kind: 'invalid_request', retryable: true },
          ),
        }
        return
      }
      yield { type: 'done', stopReason: mapFinishReason(finish, sawCall), usage }
    } catch (err) {
      if (isAbortError(err) || request.signal?.aborted) {
        yield { type: 'done', stopReason: 'aborted', usage }
        return
      }
      yield { type: 'error', error: toModelError(err) }
    }
  }

  /** POST with retry on rate limits, overload and dropped connections. */
  async #post(path: string, body: unknown, request: ModelRequest): Promise<Response> {
    const url = `${this.#baseURL}/models/${path}`
    let attempt = 0
    for (;;) {
      const timeout = new AbortController()
      const timer = setTimeout(() => timeout.abort(), this.#timeoutMs)
      const signal = request.signal
        ? AbortSignal.any([request.signal, timeout.signal])
        : timeout.signal
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: this.#requestHeaders(),
          body: JSON.stringify(body),
          signal,
        })
        clearTimeout(timer)
        const retryable = response.status === 429 || response.status >= 500
        if (!retryable || attempt >= this.#maxRetries) return response
        const wait = retryDelay(response, attempt)
        await response.body?.cancel().catch(() => {})
        await sleep(wait, request.signal)
      } catch (err) {
        clearTimeout(timer)
        if (request.signal?.aborted) throw err
        if (attempt >= this.#maxRetries) {
          if (timeout.signal.aborted)
            throw ModelError.timeout(`Gemini did not respond within ${this.#timeoutMs}ms`)
          throw err
        }
        await sleep(retryDelay(undefined, attempt), request.signal)
      }
      attempt++
    }
  }
}

// ---------------------------------------------------------------------------
// request construction
// ---------------------------------------------------------------------------

function buildBody(
  request: ModelRequest,
  wireModel: string,
  info: ModelInfo | undefined,
): Record<string, unknown> {
  const system = [request.system.text, request.system.toolGuidance].filter(Boolean).join('\n\n')
  const requiresSignature = /^gemini-3/i.test(wireModel)

  const declarations = request.tools
    .map((tool) => {
      const parameters = toGeminiSchema(tool.inputSchema)
      return {
        name: tool.name,
        description: tool.description,
        ...(parameters ? { parameters } : {}),
      }
    })
    .filter((d) => d.name)

  const generationConfig: Record<string, unknown> = {
    maxOutputTokens: Math.min(
      request.maxOutputTokens ?? info?.maxOutputTokens ?? 65_536,
      info?.maxOutputTokens ?? 65_536,
    ),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
  }
  const thinking = thinkingConfig(wireModel, info, request.effort)
  if (thinking) generationConfig.thinkingConfig = thinking

  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: toContents(request.messages, requiresSignature),
    ...(declarations.length > 0
      ? {
          tools: [{ functionDeclarations: declarations }],
          toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
        }
      : {}),
    generationConfig,
  }
}

/**
 * Map Flex effort onto Gemini's two thinking dials: `thinkingLevel` on the 3
 * series and a token `thinkingBudget` on 2.5.
 */
export function thinkingConfig(
  wireModel: string,
  info: ModelInfo | undefined,
  effort: SingleAgentEffort | undefined,
): Record<string, unknown> | undefined {
  if (!info?.supportsThinking) return undefined
  const level = toProviderEffort(effort ?? 'high')
  if (/^gemini-[3-9]/i.test(wireModel)) {
    let mapped: 'low' | 'medium' | 'high' =
      level === 'low' ? 'low' : level === 'medium' ? 'medium' : 'high'
    // Pro-class 3.x models do not offer a medium level.
    if (mapped === 'medium' && GEMINI_3_MEDIUM_UNSUPPORTED.test(wireModel)) mapped = 'high'
    return { includeThoughts: true, thinkingLevel: mapped }
  }
  const budgets = { low: 1024, medium: 4096, high: 8192, xhigh: 16384, pro: 16384, max: 24576 }
  return { includeThoughts: true, thinkingBudget: budgets[level] }
}

export function toContents(
  messages: readonly AgentMessage[],
  requiresSignature: boolean,
): GeminiContent[] {
  // Gemini matches a function response to its call by name, so the name has to
  // be recovered from the assistant turn that made the call.
  const names = new Map<string, string>()
  const callIds = new Map<string, string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        names.set(block.id, block.name)
        const callId = block.providerMeta?.callId
        if (typeof callId === 'string') callIds.set(block.id, callId)
      }
    }
  }

  const contents: GeminiContent[] = []
  const push = (role: 'user' | 'model', parts: GeminiPart[]) => {
    if (parts.length === 0) return
    const last = contents[contents.length - 1]
    if (last && last.role === role) last.parts.push(...parts)
    else contents.push({ role, parts })
  }

  for (const message of messages) {
    if (message.role === 'assistant') {
      const parts: GeminiPart[] = []
      let firstCall = true
      for (const block of message.content) {
        if (block.type === 'text' && block.text) parts.push({ text: block.text })
        else if (block.type === 'tool_use') {
          const signature = block.providerMeta?.thoughtSignature
          parts.push({
            functionCall: {
              name: block.name,
              args: isPlainObject(block.input) ? block.input : {},
              ...(callIds.has(block.id) ? { id: callIds.get(block.id) } : {}),
            },
            ...(typeof signature === 'string'
              ? { thoughtSignature: signature }
              : requiresSignature && firstCall
                ? { thoughtSignature: SKIP_SIGNATURE }
                : {}),
          })
          firstCall = false
        }
      }
      push('model', parts)
      continue
    }

    const parts: GeminiPart[] = []
    for (const block of message.content) {
      if (block.type === 'tool_result') {
        const text =
          typeof block.content === 'string'
            ? block.content
            : block.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
        parts.push({
          functionResponse: {
            name: names.get(block.toolUseId) ?? 'unknown_tool',
            response: block.isError ? { error: text } : { output: text },
            ...(callIds.has(block.toolUseId) ? { id: callIds.get(block.toolUseId) } : {}),
          },
        })
      } else if (block.type === 'text' && block.text) {
        parts.push({ text: block.text })
      }
    }
    // Function responses must lead the turn, ahead of any free text.
    parts.sort((a, b) => Number(!!b.functionResponse) - Number(!!a.functionResponse))
    push('user', parts)
  }

  // A conversation must open with a user turn.
  if (contents[0]?.role === 'model')
    contents.unshift({ role: 'user', parts: [{ text: '(continue)' }] })
  return contents
}

// ---------------------------------------------------------------------------
// responses and errors
// ---------------------------------------------------------------------------

function mapFinishReason(reason: string | undefined, sawCall: boolean): StopReason {
  if (sawCall) return 'tool_use'
  switch (reason) {
    case 'MAX_TOKENS':
      return 'max_tokens'
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
    case 'LANGUAGE':
      return 'refusal'
    default:
      return 'end_turn'
  }
}

function mapGeminiError(
  code: number | undefined,
  status: string | undefined,
  message = 'Gemini request failed',
): ModelError {
  if (
    code === 401 ||
    code === 403 ||
    status === 'UNAUTHENTICATED' ||
    status === 'PERMISSION_DENIED'
  ) {
    return new ModelError(message, { kind: 'auth', status: code })
  }
  if (code === 429 || status === 'RESOURCE_EXHAUSTED') return ModelError.rateLimit(message, 429)
  if (code === 404 || status === 'NOT_FOUND') {
    return new ModelError(`Model or endpoint not found: ${message}`, {
      kind: 'invalid_request',
      status: 404,
    })
  }
  if (code === 400 || status === 'INVALID_ARGUMENT') {
    if (
      /token|context|too (long|large)|exceeds/i.test(message) &&
      /limit|maximum|exceed|too/i.test(message)
    ) {
      return ModelError.contextOverflow(message)
    }
    if (/api key/i.test(message)) return new ModelError(message, { kind: 'auth', status: 400 })
    return ModelError.invalidRequest(message, 400)
  }
  if ((code !== undefined && code >= 500) || status === 'UNAVAILABLE' || status === 'INTERNAL') {
    return new ModelError(message, { kind: 'overloaded', status: code, retryable: true })
  }
  return new ModelError(message, { kind: 'invalid_request', status: code })
}

async function errorFromResponse(response: Response): Promise<ModelError> {
  const raw = await response.text().catch(() => '')
  let message = raw.slice(0, 500) || response.statusText
  let status: string | undefined
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string; status?: string } }
    if (parsed.error?.message) message = parsed.error.message
    status = parsed.error?.status
  } catch {
    /* not JSON */
  }
  return mapGeminiError(response.status, status, message)
}

function toModelError(err: unknown): ModelError {
  if (err instanceof ModelError) return err
  if (
    err instanceof Error &&
    /fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|UND_ERR|socket/i.test(
      `${err.message} ${String(err.cause ?? '')}`,
    )
  ) {
    return ModelError.connection(`cannot reach Gemini: ${err.message}`, err)
  }
  if (err instanceof Error && err.name === 'TimeoutError') return ModelError.timeout(err.message)
  return ModelError.unknown(err instanceof Error ? err.message : String(err), err)
}

function retryDelay(response: Response | undefined, attempt: number): number {
  const header = response?.headers.get('retry-after')
  const seconds = header ? Number(header) : Number.NaN
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000)
  return Math.min(500 * 2 ** attempt, 8_000)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('aborted', 'AbortError'))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
