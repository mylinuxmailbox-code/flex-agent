/**
 * Provider-agnostic model wire types.
 *
 * Everything in Flex speaks this vocabulary. Provider SDKs (Anthropic,
 * OpenAI-compatible, future ones) are adapters that translate to and from
 * these shapes — nothing above `src/models/` should ever import a vendor SDK.
 */

// ---------------------------------------------------------------------------
// Effort
// ---------------------------------------------------------------------------

/**
 * Reasoning intensity requested from the primary agent.
 *
 * `ultracode` and `maxcode` are *orchestration* modes rather than raw effort:
 * they pin a main-agent effort and a subagent effort, then fan out. They live
 * on the same axis so `/effort` and the status bar have one thing to show.
 */
export type EffortLevel =
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'pro'
  | 'max'
  | 'ultracode'
  | 'maxcode'

export const EFFORT_LEVELS: readonly EffortLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'pro',
  'max',
  'ultracode',
  'maxcode',
] as const

/** Effort levels that mean "one agent, more thinking" — no subagent fan-out. */
export const SINGLE_AGENT_EFFORTS: readonly EffortLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'pro',
  'max',
] as const

export interface EffortProfile {
  /** The level the user asked for. */
  readonly level: EffortLevel
  /** Effort the main agent actually runs at. */
  readonly main: SingleAgentEffort
  /** Effort for spawned subagents, or null when the mode is single-agent. */
  readonly subagents: SingleAgentEffort | null
  /** How many subagents may run at once. */
  readonly maxSubagents: number
  /** Whether the mode plans before acting. */
  readonly planFirst: boolean
  /** Whether a dedicated final self-review pass runs before reporting done. */
  readonly selfReview: boolean
  /** Verification depth multiplier; drives how far the test/lint ladder climbs. */
  readonly verificationDepth: number
  /** Whether web research is expected rather than opportunistic. */
  readonly researchBias: number
}

export type SingleAgentEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'pro' | 'max'

const MAX_CONCURRENCY = 16

/**
 * The single source of truth for what each effort level actually *does*.
 *
 * `ultracode` = main xHigh + High subagents.
 * `maxcode`   = main Max  + Pro subagents.
 */
export function effortProfile(level: EffortLevel): EffortProfile {
  switch (level) {
    case 'low':
      return {
        level,
        main: 'low',
        subagents: null,
        maxSubagents: 0,
        planFirst: false,
        selfReview: false,
        verificationDepth: 0,
        researchBias: 0,
      }
    case 'medium':
      return {
        level,
        main: 'medium',
        subagents: null,
        maxSubagents: 0,
        planFirst: false,
        selfReview: false,
        verificationDepth: 1,
        researchBias: 0,
      }
    case 'high':
      return {
        level,
        main: 'high',
        subagents: null,
        maxSubagents: 0,
        planFirst: true,
        selfReview: false,
        verificationDepth: 1,
        researchBias: 0.5,
      }
    case 'xhigh':
      return {
        level,
        main: 'xhigh',
        subagents: null,
        maxSubagents: 0,
        planFirst: true,
        selfReview: true,
        verificationDepth: 2,
        researchBias: 1,
      }
    case 'pro':
      return {
        level,
        main: 'pro',
        subagents: null,
        maxSubagents: 0,
        planFirst: true,
        selfReview: true,
        verificationDepth: 2,
        researchBias: 1.5,
      }
    case 'max':
      return {
        level,
        main: 'max',
        subagents: null,
        maxSubagents: 0,
        planFirst: true,
        selfReview: true,
        verificationDepth: 3,
        researchBias: 2,
      }
    case 'ultracode':
      return {
        level,
        main: 'xhigh',
        subagents: 'high',
        maxSubagents: 4,
        planFirst: true,
        selfReview: true,
        verificationDepth: 2,
        researchBias: 1.5,
      }
    case 'maxcode':
      return {
        level,
        main: 'max',
        subagents: 'pro',
        maxSubagents: 6,
        planFirst: true,
        selfReview: true,
        verificationDepth: 3,
        researchBias: 2,
      }
  }
}

/** Clamp an agent-count request to what the runtime will actually run at once. */
export function clampConcurrency(n: number): number {
  if (!Number.isFinite(n)) return 1
  return Math.max(1, Math.min(MAX_CONCURRENCY, Math.floor(n)))
}

// ---------------------------------------------------------------------------
// Content
// ---------------------------------------------------------------------------

export interface TextBlock {
  type: 'text'
  text: string
}

export interface ThinkingBlock {
  type: 'thinking'
  thinking: string
  signature?: string
}

export interface RedactedThinkingBlock {
  type: 'redacted_thinking'
  data: string
}

export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

/** A tool the model executed on our behalf (server-side: web_search, bash, ...). */
export interface ServerToolUseBlock {
  type: 'server_tool_use'
  id: string
  name: string
  input: unknown
}

export type ToolResultContent =
  | string
  | Array<TextBlock | ThinkingBlock | ToolUseBlock | ServerToolUseBlock>

export interface ToolResultBlock {
  type: 'tool_result'
  toolUseId: string
  content: ToolResultContent
  isError?: boolean
}

export interface CitationBlock {
  type: 'citation'
  url: string
  title?: string
  citedText?: string
  encryptedIndex?: string
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ToolUseBlock
  | ServerToolUseBlock
  | ToolResultBlock
  | CitationBlock

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type Role = 'user' | 'assistant'

export interface AgentMessage {
  role: Role
  content: ContentBlock[]
}

export interface SystemPrompt {
  /** Primary instruction text. */
  text: string
  /** Tool-use specific guidance, kept separate so adapters can map it. */
  toolGuidance?: string
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export interface Usage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheCreationTokens?: number
  reasoningTokens?: number
}

export const EMPTY_USAGE: Usage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
})

export function totalUsage(usages: readonly Usage[]): Usage {
  return usages.reduce<Usage>(
    (acc, u) => ({
      inputTokens: acc.inputTokens + u.inputTokens,
      outputTokens: acc.outputTokens + u.outputTokens,
      cacheReadTokens: (acc.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0),
      cacheCreationTokens: (acc.cacheCreationTokens ?? 0) + (u.cacheCreationTokens ?? 0),
      reasoningTokens: (acc.reasoningTokens ?? 0) + (u.reasoningTokens ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0 },
  )
}

// ---------------------------------------------------------------------------
// Stop reasons
// ---------------------------------------------------------------------------

/**
 * Why the model stopped. `pause_turn` means a long-running turn yielded early
 * and is not resumed for us; `context_overflow` means the request was too large.
 */
export type StopReason =
  | 'end_turn'
  | 'tool_use'
  | 'max_tokens'
  | 'stop_sequence'
  | 'refusal'
  | 'pause_turn'
  | 'context_overflow'
  | 'error'
  | 'aborted'

/**
 * Map a Flex effort level onto the levels a provider actually accepts.
 *
 * Anthropic exposes low/medium/high/xhigh/max — there is no `pro`. Flex's `pro`
 * therefore rides on `xhigh` at the wire level and is differentiated by
 * orchestration instead: broader research, a longer verification ladder, and a
 * forced self-review pass (see `effortProfile`). That is a real behavioural
 * difference, not a relabelled one.
 */
export function toProviderEffort(effort: SingleAgentEffort): SingleAgentEffort {
  return effort === 'pro' ? 'xhigh' : effort
}

export function isToolStop(reason: StopReason | null | undefined): boolean {
  return reason === 'tool_use'
}

// ---------------------------------------------------------------------------
// Streaming events
// ---------------------------------------------------------------------------

export interface MessageStartEvent {
  type: 'message_start'
  id: string
  model: string
}

export interface TextDeltaEvent {
  type: 'text_delta'
  text: string
}

export interface ThinkingDeltaEvent {
  type: 'thinking_delta'
  thinking: string
}

export interface CitationDeltaEvent {
  type: 'citation_delta'
  citation: CitationBlock
}

export interface ToolCallStartEvent {
  type: 'tool_call_start'
  index: number
  id: string
  name: string
}

/** Partial JSON for an in-flight tool call. Never parsed here — adapters do that. */
export interface ToolCallDeltaEvent {
  type: 'tool_call_delta'
  index: number
  partialJson: string
}

export interface ToolCallEndEvent {
  type: 'tool_call_end'
  index: number
  id: string
  name: string
  input: unknown
}

export interface UsageEvent {
  type: 'usage'
  usage: Usage
}

export interface ErrorEvent {
  type: 'error'
  error: ModelError
}

export interface DoneEvent {
  type: 'done'
  stopReason: StopReason
  usage: Usage
}

export type StreamEvent =
  | MessageStartEvent
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | CitationDeltaEvent
  | ToolCallStartEvent
  | ToolCallDeltaEvent
  | ToolCallEndEvent
  | UsageEvent
  | ErrorEvent
  | DoneEvent

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ModelErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'overloaded'
  | 'connection'
  | 'timeout'
  | 'invalid_request'
  | 'context_overflow'
  | 'refusal'
  | 'aborted'
  | 'unknown'

export class ModelError extends Error {
  readonly kind: ModelErrorKind
  readonly status?: number
  /** True when retrying the identical request could plausibly succeed. */
  readonly retryable: boolean
  override readonly cause?: unknown

  constructor(
    message: string,
    opts: { kind: ModelErrorKind; status?: number; retryable?: boolean; cause?: unknown },
  ) {
    super(message, { cause: opts.cause })
    this.name = 'ModelError'
    this.kind = opts.kind
    this.status = opts.status
    this.retryable = opts.retryable ?? false
    this.cause = opts.cause
  }

  static auth(message = 'authentication failed'): ModelError {
    return new ModelError(message, { kind: 'auth' })
  }
  static rateLimit(message = 'rate limited', status = 429): ModelError {
    return new ModelError(message, { kind: 'rate_limit', status, retryable: true })
  }
  static overloaded(message = 'model overloaded', status = 529): ModelError {
    return new ModelError(message, { kind: 'overloaded', status, retryable: true })
  }
  static connection(message: string, cause?: unknown): ModelError {
    return new ModelError(message, { kind: 'connection', retryable: true, cause })
  }
  static timeout(message = 'request timed out'): ModelError {
    return new ModelError(message, { kind: 'timeout', retryable: true })
  }
  static invalidRequest(message: string, status = 400): ModelError {
    return new ModelError(message, { kind: 'invalid_request', status })
  }
  static contextOverflow(message = 'context window exceeded'): ModelError {
    return new ModelError(message, { kind: 'context_overflow', status: 400 })
  }
  static aborted(message = 'request aborted'): ModelError {
    return new ModelError(message, { kind: 'aborted' })
  }
  static unknown(message: string, cause?: unknown): ModelError {
    return new ModelError(message, { kind: 'unknown', cause })
  }
}

export function isAbortError(err: unknown): boolean {
  if (err instanceof ModelError) return err.kind === 'aborted'
  if (err instanceof Error) {
    if (err.name === 'AbortError' || err.name === 'APIUserAbortError') return true
    return /abort/i.test(err.message)
  }
  return false
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface Pricing {
  inputPerMTok: number
  outputPerMTok: number
  cacheReadPerMTok?: number
  cacheWritePerMTok?: number
}

export interface ModelInfo {
  /** Wire id passed to the provider. */
  id: string
  /** Short human label for the status bar. */
  label: string
  contextWindow: number
  maxOutputTokens: number
  supportsTools: boolean
  supportsThinking: boolean
  /** Native effort/reasoning control. When false, effort is emulated. */
  supportsEffort: boolean
  supportsWebSearch: boolean
  supportsPromptCaching: boolean
  /** Effort values this model natively accepts. */
  nativeEfforts?: readonly SingleAgentEffort[]
  /** True when effort changes do not invalidate the prompt cache (per-message effort). */
  perMessageEffort?: boolean
  pricing?: Pricing
  /** Set when the model id is a local alias rather than a provider id. */
  alias?: string
}

export interface ModelRequest {
  model: string
  system: SystemPrompt
  messages: AgentMessage[]
  tools: ModelTool[]
  maxOutputTokens?: number
  temperature?: number
  effort?: SingleAgentEffort
  /** Provider-native server tools, e.g. `web_search`. */
  serverTools?: ServerToolSpec[]
  stream?: boolean
  signal?: AbortSignal
  metadata?: Record<string, string>
}

export interface ModelResponse {
  id: string
  model: string
  content: ContentBlock[]
  stopReason: StopReason
  usage: Usage
}

/** A tool as advertised to the model. Kept minimal so providers can map it. */
export interface ModelTool {
  name: string
  description: string
  /** JSON Schema for the tool input. */
  inputSchema: Record<string, unknown>
}

export interface ServerToolSpec {
  type: string
  [key: string]: unknown
}
