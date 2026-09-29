import type { ModelProvider } from '../../models/provider.js'
import {
  type AgentMessage,
  type ContentBlock,
  type EffortProfile,
  isAbortError,
  ModelError,
  type StopReason,
  type ToolUseBlock,
  type Usage,
} from '../../models/types.js'
import type { Logger } from '../../observability/logger.js'
import type { ToolAuthorizer } from '../../permissions/types.js'
import type { Sandbox } from '../../sandbox/types.js'
import { skillRegistry } from '../../skills/registry.js'
import type { ToolRegistry } from '../../tools/registry.js'
import type { ToolContext, ToolEvent, ToolResult } from '../../tools/types.js'
import type { AgentEvent, AgentState, PlanStep } from '../events.js'
import { buildSystemPrompt, type PromptContext } from '../system-prompt.js'

import { AsyncQueue } from './async-queue.js'

/**
 * The agent loop.
 *
 * One turn is: ask the model, stream what it says, run whatever tools it asked
 * for, feed the results back, repeat until it stops asking for tools. Every
 * tool call passes the permission engine before it runs, whether it came from a
 * built-in tool, a plugin, or an MCP server.
 *
 * The loop emits events and never touches the terminal. That is what makes it
 * testable and what lets the UI stay responsive without the runtime knowing the
 * UI exists.
 */

export interface AgentRuntimeOptions {
  provider: ModelProvider
  tools: ToolRegistry
  permissions: ToolAuthorizer
  sandbox: Sandbox
  logger: Logger
  model: string
  effort: EffortProfile
  promptContext: Omit<PromptContext, 'tools' | 'effort'>
  /** Rough context ceiling before compaction. Defaults to 80% of the window. */
  contextLimitTokens?: number
  sessionId: string
}

export interface RunOptions {
  signal: AbortSignal
  /** Resume a paused turn rather than starting fresh. */
  continueTurn?: boolean
}

/** Guard against a model that keeps calling tools forever. */
const MAX_TURNS = 200

export class AgentRuntime {
  readonly #opts: AgentRuntimeOptions
  #messages: AgentMessage[] = []
  #turn = 0
  #state: AgentState = 'idle'
  #plan: PlanStep[] = []
  #usage: Usage = { inputTokens: 0, outputTokens: 0 }
  #lastStopReason: StopReason = 'end_turn'
  /** Per-tool-call effect on tracked file changes, for the final diff view. */
  readonly #changedFiles = new Set<string>()
  constructor(options: AgentRuntimeOptions) {
    this.#opts = options
  }

  get messages(): readonly AgentMessage[] {
    return this.#messages
  }

  get state(): AgentState {
    return this.#state
  }

  get plan(): readonly PlanStep[] {
    return this.#plan
  }

  get usage(): Usage {
    return this.#usage
  }

  get changedFiles(): readonly string[] {
    return [...this.#changedFiles]
  }

  get lastStopReason(): StopReason {
    return this.#lastStopReason
  }

  /** Point the loop at a different provider/model mid-session. */
  setProvider(provider: ModelProvider): void {
    ;(this.#opts as { provider: ModelProvider }).provider = provider
  }

  /** Point the loop at a different model mid-session. */
  setModel(model: string): void {
    ;(this.#opts as { model: string }).model = model
  }

  /** Change effort without discarding the conversation. */
  setEffort(effort: EffortProfile): void {
    ;(this.#opts as { effort: EffortProfile }).effort = effort
  }

  get provider(): ModelProvider {
    return this.#opts.provider
  }

  get sessionId(): string {
    return this.#opts.sessionId
  }

  /** Restore conversation, plan, and modified files from a saved session. */
  loadState(
    messages: readonly AgentMessage[],
    plan: readonly PlanStep[],
    changedFiles: readonly string[],
  ): void {
    this.#messages = [...messages]
    this.#plan = [...plan]
    this.#changedFiles.clear()
    for (const f of changedFiles) this.#changedFiles.add(f)
  }

  /** Drop the conversation but keep configuration. `/clear`. */
  reset(): void {
    this.#messages = []
    this.#turn = 0
    this.#plan = []
    this.#usage = { inputTokens: 0, outputTokens: 0 }
    this.#changedFiles.clear()
    this.#setState('idle')
  }

  /**
   * Run a user turn to completion, yielding events as they happen.
   *
   * The generator is the contract: the caller can abandon it at any point
   * (Ctrl+C, quit) and the underlying request is aborted with it.
   */
  async *run(input: string, options: RunOptions): AsyncGenerator<AgentEvent> {
    // Turn limits protect one request, not the lifetime of a session.
    if (!options.continueTurn) this.#turn = 0
    this.#setState('thinking')
    if (input.trim()) {
      this.#messages.push({ role: 'user', content: [{ type: 'text', text: input }] })
    }

    while (this.#turn < MAX_TURNS) {
      if (options.signal.aborted) {
        yield { type: 'done', stopReason: 'aborted' }
        return
      }
      this.#turn++
      yield { type: 'turn_start', turn: this.#turn }

      const window = this.#opts.provider.resolveModel(this.#opts.model)?.contextWindow ?? 200_000
      const contextLimit = this.#opts.contextLimitTokens ?? Math.floor(window * 0.8)
      if (estimateTokens(this.#messages) > contextLimit) {
        const compacted = this.#compactContext()
        if (compacted.didCompact) {
          yield {
            type: 'context_compacted',
            beforeTokens: compacted.beforeTokens,
            afterTokens: compacted.afterTokens,
          }
          continue
        }
      }

      const systemPrompt = buildSystemPrompt({
        ...this.#opts.promptContext,
        tools: this.#opts.tools,
        effort: this.#opts.effort,
        skills: skillRegistry.findRelevant(input, 2),
      })

      const request = {
        model: this.#opts.model,
        system: systemPrompt,
        messages: this.#messages,
        tools: this.#opts.tools.modelTools(),
        effort: this.#opts.effort.main,
        signal: options.signal,
      }

      // --- stream one model turn -------------------------------------------
      const assistantContent: ContentBlock[] = []
      const toolUses: ToolUseBlock[] = []
      let stopReason: StopReason = 'end_turn'
      let turnUsage: Usage = { inputTokens: 0, outputTokens: 0 }
      let textBuffer = ''
      let sawError: ModelError | null = null

      try {
        for await (const event of this.#opts.provider.stream(request)) {
          switch (event.type) {
            case 'text_delta':
              textBuffer += event.text
              yield { type: 'text_delta', text: event.text }
              break
            case 'thinking_delta':
              yield { type: 'thinking_delta', text: event.thinking }
              break
            case 'citation_delta':
              if (event.citation.url) {
                yield {
                  type: 'citation',
                  url: event.citation.url,
                  title: event.citation.title,
                }
              }
              break
            case 'tool_call_end':
              toolUses.push({
                type: 'tool_use',
                id: event.id,
                name: event.name,
                input: event.input,
              })
              break
            case 'usage':
              turnUsage = event.usage
              break
            case 'done':
              stopReason = event.stopReason
              turnUsage = event.usage
              break
            case 'error':
              sawError = event.error
              break
            default:
              break
          }
        }
      } catch (err) {
        if (isAbortError(err)) {
          yield { type: 'done', stopReason: 'aborted' }
          return
        }
        const modelError = err instanceof ModelError ? err : ModelError.unknown(String(err), err)
        yield { type: 'error', error: modelError }
        this.#setState('error')
        return
      }

      if (sawError) {
        // An error mid-stream: report it, but keep whatever text arrived so the
        // user can see how far it got.
        yield { type: 'error', error: sawError }
        this.#setState('error')
        return
      }

      // Flush the buffered text as one block so the model sees a coherent
      // assistant message rather than a stream of fragments.
      if (textBuffer) assistantContent.push({ type: 'text', text: textBuffer })
      for (const use of toolUses) assistantContent.push(use)

      this.#usage = {
        inputTokens: this.#usage.inputTokens + turnUsage.inputTokens,
        outputTokens: this.#usage.outputTokens + turnUsage.outputTokens,
      }
      this.#lastStopReason = stopReason

      if (assistantContent.length > 0) {
        this.#messages.push({ role: 'assistant', content: assistantContent })
      }

      yield {
        type: 'usage',
        usage: turnUsage,
        contextUsed: Math.min(estimateTokens(this.#messages), window),
        contextWindow: window,
      }
      yield { type: 'turn_end', turn: this.#turn, stopReason }

      // --- what happens next is decided by the stop reason -----------------
      if (stopReason === 'aborted') {
        yield { type: 'done', stopReason: 'aborted' }
        return
      }
      if (stopReason === 'context_overflow') {
        const compacted = this.#compactContext()
        if (!compacted.didCompact) {
          yield {
            type: 'notice',
            level: 'warn',
            text:
              'The conversation exceeded the model context window and there was nothing left to compact. ' +
              'Start a fresh task with /clear.',
          }
          this.#setState('error')
          break
        }
        yield {
          type: 'context_compacted',
          beforeTokens: compacted.beforeTokens,
          afterTokens: compacted.afterTokens,
        }
        continue
      }
      if (stopReason === 'refusal') {
        this.#setState('done')
        yield {
          type: 'notice',
          level: 'warn',
          text: 'The model declined to continue with that request.',
        }
        break
      }
      if (stopReason === 'pause_turn') {
        // A paused turn is not finished. Ask the model to carry on rather than
        // reporting completion the user would then have to trigger again.
        this.#messages.push({
          role: 'user',
          content: [{ type: 'text', text: 'Continue.' }],
        })
        continue
      }
      if (stopReason === 'max_tokens' && toolUses.length > 0) {
        // Truncated tool JSON is not runnable. Say so instead of executing it.
        this.#messages.push({
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Your last message was cut off before the tool call finished. Re-issue the tool call with fewer arguments.',
            },
          ],
        })
        continue
      }
      if (toolUses.length === 0) {
        this.#setState('done')
        break
      }

      // --- run the tools the model asked for --------------------------------
      this.#setState('acting')
      const results = yield* this.#runTools(toolUses, options)
      this.#messages.push({ role: 'user', content: results })
    }

    this.#setState('done')
    yield { type: 'done', stopReason: this.#lastStopReason }
  }

  /**
   * Authorize then execute a batch of tool calls.
   *
   * Authorization happens for the whole batch before anything executes, so a
   * permission prompt never appears after an irreversible action has already
   * happened. Execution of approved calls is concurrent — the model chose them
   * together precisely because they are independent.
   */
  async *#runTools(
    toolUses: readonly ToolUseBlock[],
    options: RunOptions,
  ): AsyncGenerator<AgentEvent, ContentBlock[]> {
    const results: ContentBlock[] = []
    const approved: Array<{ use: ToolUseBlock; display: string }> = []

    for (const use of toolUses) {
      const tool = this.#opts.tools.get(use.name)
      if (!tool) {
        results.push(toolResult(use.id, `Unknown tool: ${use.name}`, true))
        yield {
          type: 'tool_end',
          id: use.id,
          name: use.name,
          display: `${use.name} (unknown)`,
          isError: true,
          durationMs: 0,
          summary: 'no such tool',
        }
        continue
      }

      let input: unknown
      try {
        input = tool.inputSchema.parse(use.input ?? {})
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        results.push(
          toolResult(
            use.id,
            `Invalid arguments for ${use.name}: ${message}. Fix the arguments and try again.`,
            true,
          ),
        )
        yield {
          type: 'tool_end',
          id: use.id,
          name: use.name,
          display: `${use.name} (bad input)`,
          isError: true,
          durationMs: 0,
          summary: 'invalid arguments',
        }
        continue
      }

      const ctx = this.#toolContext(undefined, options.signal)
      let display = use.name
      try {
        const action = tool.plan(input as never, ctx)
        const verdict = await this.#opts.permissions.authorize({
          ...action,
          input,
        })

        if (verdict.decision.outcome === 'deny') {
          results.push(
            toolResult(
              use.id,
              `Permission denied: ${verdict.decision.reason}. Choose a different approach.`,
              true,
            ),
          )
          yield {
            type: 'permission_denied',
            id: use.id,
            name: use.name,
            reason: verdict.decision.reason,
          }
          continue
        }
        display = action.command ? `run ${truncate(action.command, 50)}` : `${use.name}`
        approved.push({ use, display })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        results.push(toolResult(use.id, `Could not plan ${use.name}: ${message}`, true))
      }
    }

    if (approved.length === 0) return results

    // Emit the starts in one batch so the UI can collapse them into a group.
    for (const { use, display } of approved) {
      yield { type: 'tool_start', id: use.id, name: use.name, display }
    }

    // Tools emit progress from inside their own async execution, so it is
    // funnelled through a queue and drained here in arrival order.
    const progress = new AsyncQueue<AgentEvent>()
    const executions = approved.map(({ use, display }) =>
      this.#executeOne(use, display, progress, options.signal),
    )
    const settled = Promise.allSettled(executions)
    void settled.then(() => progress.close())

    for await (const event of progress.drain()) {
      yield event
    }
    const outcomes = await settled

    for (const outcome of outcomes) {
      if (outcome.status !== 'fulfilled') {
        yield {
          type: 'error',
          error:
            outcome.reason instanceof Error ? outcome.reason : new Error(String(outcome.reason)),
        }
        continue
      }
      if (!outcome.value) continue
      const { use, display, result, durationMs } = outcome.value
      results.push(toolResult(use.id, result.content, result.isError === true))
      yield {
        type: 'tool_end',
        id: use.id,
        name: use.name,
        display: result.display ?? display,
        isError: result.isError === true,
        durationMs,
        summary: result.display ?? '',
      }
    }

    void options
    return results
  }

  async #executeOne(
    use: ToolUseBlock,
    display: string,
    progress: AsyncQueue<AgentEvent>,
    signal: AbortSignal,
  ): Promise<{
    use: ToolUseBlock
    display: string
    result: ToolResult
    durationMs: number
  } | null> {
    const tool = this.#opts.tools.get(use.name)
    if (!tool) return null
    const started = Date.now()
    const ctx = this.#toolContext((event) => {
      // A plan update is session-level UI state, not tool-local output, so it
      // is promoted to its own event rather than shown as tool chatter.
      if (event.type === 'plan') {
        progress.push({ type: 'plan', steps: event.steps })
        return
      }
      progress.push({ type: 'tool_progress', id: use.id, event })
    }, signal)
    try {
      const result = await tool.execute(use.input as never, ctx)
      return { use, display, result, durationMs: Date.now() - started }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return {
        use,
        display,
        result: { content: `Error: ${message}`, isError: true },
        durationMs: Date.now() - started,
      }
    }
  }

  #toolContext(
    onEvent?: (event: ToolEvent) => void,
    signal: AbortSignal = new AbortController().signal,
  ): ToolContext {
    return {
      cwd: this.#opts.promptContext.workspaceRoot,
      workspaceRoot: this.#opts.promptContext.workspaceRoot,
      permissions: this.#opts.permissions,
      sandbox: this.#opts.sandbox,
      logger: this.#opts.logger,
      sessionId: this.#opts.sessionId,
      signal,
      emit: (event: ToolEvent) => {
        onEvent?.(event)
      },
      noteFileChange: (path: string) => {
        this.#changedFiles.add(path)
      },
    }
  }

  #setState(state: AgentState): void {
    this.#state = state
  }

  /**
   * Shrink the transcript when it outgrows the window.
   *
   * The recent window is kept verbatim because verbatim tool results are what
   * the model needs to continue correctly. Older turns are dropped first, and
   * only as a last resort is a summary substituted.
   */
  #compactContext(): { didCompact: boolean; beforeTokens: number; afterTokens: number } {
    const before = estimateTokens(this.#messages)
    if (this.#messages.length <= 4)
      return { didCompact: false, beforeTokens: before, afterTokens: before }

    const keep = 4
    const _dropped = this.#messages.length - keep
    const head = this.#messages.slice(0, 1)
    const tail = this.#messages.slice(-keep)
    const summary = summariseDropped(this.#messages.slice(1, -keep))
    this.#messages = [...head, summary, ...tail]
    const after = estimateTokens(this.#messages)
    return { didCompact: true, beforeTokens: before, afterTokens: after }
  }
}

function toolResult(id: string, content: string, isError: boolean): ContentBlock {
  return { type: 'tool_result', toolUseId: id, content, isError }
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > max ? `${single.slice(0, max - 1)}…` : single
}

/** Cheap, stable token estimate. Deliberately not a tokenizer. */
export function estimateTokens(messages: readonly AgentMessage[]): number {
  let chars = 0
  for (const message of messages) {
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          chars += block.text.length
          break
        case 'tool_result':
          chars +=
            typeof block.content === 'string'
              ? block.content.length
              : JSON.stringify(block.content).length
          break
        default:
          chars += JSON.stringify(block).length
      }
    }
  }
  return Math.ceil(chars / 4)
}

/** A compact stand-in for turns that were dropped to free context. */
function summariseDropped(dropped: readonly AgentMessage[]): AgentMessage {
  const lines: string[] = []
  for (const message of dropped) {
    for (const block of message.content) {
      if (block.type === 'text') {
        const first = block.text.split('\n')[0]
        if (first) lines.push(`${message.role}: ${truncate(first, 120)}`)
      } else if (block.type === 'tool_use') {
        lines.push(`${message.role}: called ${block.name}`)
      } else if (block.type === 'tool_result') {
        const text = typeof block.content === 'string' ? block.content : ''
        const first = text.split('\n')[0]
        lines.push(`  result: ${truncate(first ?? '', 100)}`)
      }
    }
  }
  return {
    role: 'user',
    content: [
      {
        type: 'text',
        text: `[Earlier conversation compacted to free context. ${dropped.length} messages summarised.]\n${lines
          .slice(-60)
          .join('\n')}`,
      },
    ],
  }
}
