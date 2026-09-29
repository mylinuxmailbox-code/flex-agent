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
  /** Replaces the standard system prompt. Subagents run under a role prompt instead. */
  systemText?: string
  /** Model turns allowed per request. Defaults to 200. */
  maxTurns?: number
  /**
   * When the turn cap is reached, spend one last tool-less turn asking for a
   * report instead of stopping mid-work. Subagents need this: their caller is
   * waiting for an answer, not a "stopped" notice.
   */
  finalizeOnLimit?: boolean
  /** Called for every file a tool reports changing (subagents feed the parent's list). */
  onFileChange?: (path: string) => void
  /** Search/fetch settings from config, passed to tools. */
  web?: ToolContext['web']
}

export interface RunOptions {
  signal: AbortSignal
  /** Resume a paused turn rather than starting fresh. */
  continueTurn?: boolean
}

/** Guard against a model that keeps calling tools forever. */
const DEFAULT_MAX_TURNS = 200

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

  /** Record a file as changed in this session (also called by subagents). */
  trackFile(path: string): void {
    this.#changedFiles.add(path)
    this.#opts.onFileChange?.(path)
  }

  get lastStopReason(): StopReason {
    return this.#lastStopReason
  }

  /** Point the loop at a different model mid-session. */
  setModel(model: string): void {
    ;(this.#opts as { model: string }).model = model
  }

  /** Change effort without discarding the conversation. */
  setEffort(effort: EffortProfile): void {
    ;(this.#opts as { effort: EffortProfile }).effort = effort
  }

  get model(): string {
    return this.#opts.model
  }

  get effort(): EffortProfile {
    return this.#opts.effort
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
    this.#setState('thinking')
    // The turn budget is per user request, not per session.
    this.#turn = 0
    // A previous run may have been cut off between a tool_use and its result.
    this.#repairHistory()
    if (input.trim()) this.#pushUserText(input)

    const maxTurns = this.#opts.maxTurns ?? DEFAULT_MAX_TURNS
    while (this.#turn < maxTurns) {
      if (options.signal.aborted) {
        yield { type: 'done', stopReason: 'aborted' }
        return
      }
      this.#turn++
      yield { type: 'turn_start', turn: this.#turn }

      // Compact before the request that would overflow, not after it failed.
      const proactive = this.#maybeCompact()
      if (proactive) yield proactive

      // On the final permitted turn a finalising runtime asks for the report
      // and offers no tools, so the model has no choice but to answer.
      const finalTurn = this.#opts.finalizeOnLimit === true && this.#turn === maxTurns
      if (finalTurn) {
        this.#pushUserText(
          'You are out of turns. Do not call any more tools. Write your final report now from what you have found so far, and say plainly what you did not get to.',
        )
      }

      const systemPrompt =
        this.#opts.systemText !== undefined
          ? { text: this.#opts.systemText }
          : buildSystemPrompt({
              ...this.#opts.promptContext,
              tools: this.#opts.tools,
              effort: this.#opts.effort,
              skills: skillRegistry.findRelevant(input, 2),
            })

      const request = {
        model: this.#opts.model,
        system: systemPrompt,
        messages: this.#messages,
        tools: finalTurn ? [] : this.#opts.tools.modelTools(),
        effort: this.#opts.effort.main,
        signal: options.signal,
      }

      // --- stream one model turn -------------------------------------------
      const assistantContent: ContentBlock[] = []
      const toolUses: ToolUseBlock[] = []
      let thinkingBuffer = ''
      let thinkingSignature: string | undefined
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
              thinkingBuffer += event.thinking
              yield { type: 'thinking_delta', text: event.thinking }
              break
            case 'thinking_signature':
              thinkingSignature = event.signature
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
                ...(event.providerMeta ? { providerMeta: event.providerMeta } : {}),
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
      // A signed thinking block must be replayed first and unmodified when
      // tools are used; unsigned reasoning is display-only and never stored.
      if (thinkingBuffer && thinkingSignature) {
        assistantContent.push({
          type: 'thinking',
          thinking: thinkingBuffer,
          signature: thinkingSignature,
        })
      }
      if (textBuffer) assistantContent.push({ type: 'text', text: textBuffer })
      // Tool calls from a truncated or cancelled turn may be incomplete. They are
      // not run, and not kept: a tool_use with no result makes the history invalid.
      const runnable = stopReason === 'max_tokens' || stopReason === 'aborted' ? [] : toolUses
      for (const use of runnable) assistantContent.push(use)

      this.#usage = {
        inputTokens: this.#usage.inputTokens + turnUsage.inputTokens,
        outputTokens: this.#usage.outputTokens + turnUsage.outputTokens,
      }
      this.#lastStopReason = stopReason

      if (assistantContent.length > 0) {
        this.#messages.push({ role: 'assistant', content: assistantContent })
      }

      const window = this.#opts.provider.resolveModel(this.#opts.model)?.contextWindow ?? 200_000
      yield {
        type: 'usage',
        usage: turnUsage,
        contextUsed: Math.min(turnUsage.inputTokens, window),
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
        this.#pushUserText('Continue.')
        continue
      }
      if (stopReason === 'max_tokens' && toolUses.length > 0) {
        yield {
          type: 'notice',
          level: 'warn',
          text: 'The model hit its output limit in the middle of a tool call; asking it to retry.',
        }
        // Truncated tool JSON is not runnable. Say so instead of executing it.
        this.#pushUserText(
          'Your last message was cut off before the tool call finished. Re-issue the tool call with fewer arguments.',
        )
        continue
      }
      if (runnable.length === 0) {
        this.#setState('done')
        break
      }

      // --- run the tools the model asked for --------------------------------
      this.#setState('acting')
      const results = yield* this.#runTools(runnable, options)
      this.#messages.push({ role: 'user', content: results })
      if (options.signal.aborted) {
        yield { type: 'done', stopReason: 'aborted' }
        return
      }
    }

    if (this.#turn >= maxTurns && this.#state !== 'done') {
      yield {
        type: 'notice',
        level: 'warn',
        text: `Stopped after ${maxTurns} model turns in one request. Say "continue" to keep going.`,
      }
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
    const approved: Array<{ use: ToolUseBlock; display: string; input: unknown }> = []

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

      const ctx = this.#toolContext(options.signal)
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
        approved.push({ use, display, input })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        results.push(toolResult(use.id, `Could not plan ${use.name}: ${message}`, true))
        yield {
          type: 'tool_end',
          id: use.id,
          name: use.name,
          display: `${use.name} (failed)`,
          isError: true,
          durationMs: 0,
          summary: 'could not plan',
        }
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
    const executions = approved.map(({ use, display, input }) =>
      this.#executeOne(use, display, input, progress, options.signal),
    )
    // The queue closes once *every* tool has finished. Closing on the first one
    // would drop the progress of the rest.
    const settled = Promise.allSettled(executions).finally(() => progress.close())

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

    // Every tool_use needs exactly one result, whatever happened to it; a gap
    // makes the whole conversation unsendable.
    const answered = new Set(
      results.flatMap((b) => (b.type === 'tool_result' ? [b.toolUseId] : [])),
    )
    for (const use of toolUses) {
      if (!answered.has(use.id)) {
        results.push(toolResult(use.id, `${use.name} did not produce a result.`, true))
      }
    }
    const order = new Map(toolUses.map((u, i) => [u.id, i]))
    results.sort(
      (a, b) =>
        (a.type === 'tool_result' ? (order.get(a.toolUseId) ?? 0) : 0) -
        (b.type === 'tool_result' ? (order.get(b.toolUseId) ?? 0) : 0),
    )
    return results
  }

  async #executeOne(
    use: ToolUseBlock,
    display: string,
    input: unknown,
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
    const ctx = this.#toolContext(signal, (event) => {
      // A plan update is session-level UI state, not tool-local output, so it
      // is promoted to its own event rather than shown as tool chatter.
      if (event.type === 'plan') {
        progress.push({ type: 'plan', steps: event.steps })
        return
      }
      progress.push({ type: 'tool_progress', id: use.id, event })
    })
    try {
      const result = await tool.execute(input as never, ctx)
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

  #toolContext(signal: AbortSignal, onEvent?: (event: ToolEvent) => void): ToolContext {
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
      web: this.#opts.web,
      noteFileChange: (path: string) => this.trackFile(path),
    }
  }

  #setState(state: AgentState): void {
    this.#state = state
  }

  /** Append user text, merging into a trailing user turn so roles keep alternating. */
  #pushUserText(text: string): void {
    const last = this.#messages.at(-1)
    if (last?.role === 'user') {
      this.#messages[this.#messages.length - 1] = {
        role: 'user',
        content: [...last.content, { type: 'text', text }],
      }
      return
    }
    this.#messages.push({ role: 'user', content: [{ type: 'text', text }] })
  }

  /**
   * Make the stored conversation valid to send.
   *
   * A run cut off by Esc, a crash, or a resumed session can leave an assistant
   * `tool_use` with no matching result. Every provider rejects that, so the gap
   * is filled with an explicit "interrupted" result.
   */
  #repairHistory(): void {
    const repaired: AgentMessage[] = []
    for (let i = 0; i < this.#messages.length; i++) {
      const message = this.#messages[i] as AgentMessage
      repaired.push(message)
      if (message.role !== 'assistant' || typeof message.content === 'string') continue
      const uses = message.content.filter((b): b is ToolUseBlock => b.type === 'tool_use')
      if (uses.length === 0) continue
      const next = this.#messages[i + 1]
      const answered = new Set(
        next?.role === 'user'
          ? next.content.flatMap((b) => (b.type === 'tool_result' ? [b.toolUseId] : []))
          : [],
      )
      const missing = uses.filter((u) => !answered.has(u.id))
      if (missing.length === 0) continue
      const fill = missing.map((u) =>
        toolResult(u.id, 'This tool call was interrupted before it finished.', true),
      )
      if (next?.role === 'user') {
        this.#messages[i + 1] = { role: 'user', content: [...fill, ...next.content] }
      } else {
        repaired.push({ role: 'user', content: fill })
      }
    }
    this.#messages = repaired
  }

  #contextLimit(): number {
    const window = this.#opts.provider.resolveModel(this.#opts.model)?.contextWindow ?? 200_000
    return this.#opts.contextLimitTokens ?? Math.floor(window * 0.8)
  }

  #maybeCompact(): AgentEvent | null {
    if (estimateTokens(this.#messages) < this.#contextLimit()) return null
    const result = this.compact()
    if (!result.didCompact) return null
    return {
      type: 'context_compacted',
      beforeTokens: result.beforeTokens,
      afterTokens: result.afterTokens,
    }
  }

  /** Shrink the transcript now. Used by `/compact`, and automatically near the limit. */
  compact(): { didCompact: boolean; beforeTokens: number; afterTokens: number } {
    return this.#compactContext()
  }

  /**
   * Shrink the transcript when it outgrows the window.
   *
   * The first message (the task) and the most recent exchanges are kept
   * verbatim, because verbatim tool results are what the model needs to
   * continue correctly. The middle is replaced by a short digest. The cut is
   * always placed at a plain user message so a tool_use is never separated from
   * its result.
   */
  #compactContext(): { didCompact: boolean; beforeTokens: number; afterTokens: number } {
    const before = estimateTokens(this.#messages)
    const none = { didCompact: false, beforeTokens: before, afterTokens: before }
    const keep = 6
    let cut = this.#messages.length - keep
    const isPlainUser = (m: AgentMessage | undefined) =>
      m?.role === 'user' && !m.content.some((b) => b.type === 'tool_result')
    while (cut > 1 && !isPlainUser(this.#messages[cut])) cut--
    if (cut <= 1) return none

    const first = this.#messages[0] as AgentMessage
    const tailFirst = this.#messages[cut] as AgentMessage
    const digest = summariseDropped(this.#messages.slice(1, cut))
    const merged: AgentMessage = {
      role: 'user',
      content: [...first.content, ...digest.content, ...tailFirst.content],
    }
    this.#messages = [merged, ...this.#messages.slice(cut + 1)]
    return { didCompact: true, beforeTokens: before, afterTokens: estimateTokens(this.#messages) }
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
