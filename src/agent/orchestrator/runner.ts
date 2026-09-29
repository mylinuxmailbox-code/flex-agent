import type { ModelProvider } from '../../models/provider.js'
import {
  type AgentMessage,
  type EffortProfile,
  isAbortError,
  type SingleAgentEffort,
  type Usage,
} from '../../models/types.js'
import type { Logger } from '../../observability/logger.js'
import type { ToolAuthorizer } from '../../permissions/types.js'
import type { Sandbox } from '../../sandbox/types.js'
import type { ToolRegistry } from '../../tools/registry.js'
import type { ToolContext, ToolResult } from '../../tools/types.js'
import { toJsonSchema } from '../../tools/types.js'
import { roleDefinition, roleSystemPrompt, type SubagentRole } from '../subagents/roles.js'

/**
 * Subagent orchestration.
 *
 * This is what makes Ultracode and Maxcode real rather than a label. The main
 * agent stays authoritative: it decides what is worth delegating, reads the
 * structured results, and owns the final answer. Subagents are parallel *and*
 * scoped — each gets its own role, its own tool allowlist, and no ability to
 * edit files unless its role says so.
 *
 * Two properties matter more than raw parallelism:
 *
 *  - A subagent's report replaces its transcript. The main agent gets summary,
 *    findings, evidence, risks and confidence — not 40k tokens of tool output.
 *  - Subagent tool calls go through the same PermissionEngine. A subagent
 *    cannot exceed the user's authority by being spawned.
 */

export interface SubagentSpec {
  /** Unique within a fan-out. */
  id: string
  role: SubagentRole
  /** The specific, self-contained brief. */
  task: string
  /** Defaults to the orchestrator's configured subagent effort. */
  effort?: SingleAgentEffort
  /** Overrides the role's allowlist when a task genuinely needs more. */
  tools?: readonly string[]
  model?: string
}

export interface SubagentResult {
  id: string
  role: SubagentRole
  label: string
  /** The subagent's final message. */
  report: string
  usage: Usage
  durationMs: number
  status: 'completed' | 'failed' | 'cancelled'
  error?: string
  /** Tool calls made, for the agents panel. */
  toolCalls: number
}

export interface FanOutOptions {
  specs: readonly SubagentSpec[]
  signal: AbortSignal
  /** Called as each subagent finishes, for live progress. */
  onResult?: (result: SubagentResult) => void
  /** Called when a subagent starts a tool call, for the agents panel. */
  onActivity?: (id: string, text: string) => void
  /** Hard cap regardless of the effort profile. */
  maxConcurrency?: number
}

export interface SubagentRunnerDeps {
  provider: ModelProvider
  tools: ToolRegistry
  permissions: ToolAuthorizer
  sandbox: Sandbox
  logger: Logger
  workspaceRoot: string
  model: string
  effort: EffortProfile
  sessionId: string
  /** Tools a subagent may use for side effects (shell, write). */
  mutatingTools: readonly string[]
}

export class SubagentRunner {
  readonly #deps: SubagentRunnerDeps

  constructor(deps: SubagentRunnerDeps) {
    this.#deps = deps
  }

  /** Keep delegated work on the same provider/model as the main agent. */
  setProvider(provider: ModelProvider, model: string): void {
    this.#deps.provider = provider
    this.#deps.model = model
  }

  setEffort(effort: EffortProfile): void {
    this.#deps.effort = effort
  }

  /**
   * Run every spec, concurrently up to the cap, and collect the results.
   *
   * Concurrency is bounded by the effort profile: Ultracode allows 4, Maxcode 6.
   * Spawning more does not make the answer better, it just makes it expensive
   * and harder to read.
   */
  async fanOut(options: FanOutOptions): Promise<SubagentResult[]> {
    const cap = options.maxConcurrency ?? Math.max(1, this.#deps.effort.maxSubagents || 4)
    const queue = [...options.specs]
    const results: SubagentResult[] = []

    const worker = async (): Promise<void> => {
      for (;;) {
        const spec = queue.shift()
        if (!spec) return
        if (options.signal.aborted) {
          results.push(this.#cancelled(spec))
          continue
        }
        const result = await this.#runOne(spec, options)
        results.push(result)
        options.onResult?.(result)
      }
    }

    await Promise.all(Array.from({ length: Math.min(cap, options.specs.length) }, worker))

    // Report in the order the orchestrator asked for, not completion order.
    const byId = new Map(results.map((r) => [r.id, r]))
    return options.specs.map((s) => byId.get(s.id) ?? this.#cancelled(s))
  }

  async #runOne(spec: SubagentSpec, options: FanOutOptions): Promise<SubagentResult> {
    const started = Date.now()
    const definition = roleDefinition(spec.role)
    let toolCalls = 0
    let report = ''
    let usage: Usage = { inputTokens: 0, outputTokens: 0 }

    const allowed = this.#toolsFor(spec)
    const effort = spec.effort ?? this.#deps.effort.subagents ?? 'high'
    const model = spec.model ?? this.#deps.model

    try {
      let events = this.#deps.provider.stream({
        model,
        system: { text: roleSystemPrompt(spec.role, spec.task) },
        messages: [{ role: 'user', content: [{ type: 'text', text: spec.task }] }],
        tools: allowed
          .map((name) => this.#deps.tools.get(name))
          .filter(Boolean)
          .map((tool) => ({
            name: tool!.name,
            description: tool!.description,
            inputSchema: this.#jsonSchema(tool!),
          })),
        effort,
        signal: options.signal,
      })

      // Drive the subagent loop: stream, run tools, feed back, repeat.
      const drive = (async () => {
        for (let turn = 0; turn < 24; turn++) {
          const collected: string[] = []
          const pending: Array<{ id: string; name: string; input: unknown }> = []

          for await (const event of events) {
            if (event.type === 'text_delta') collected.push(event.text)
            else if (event.type === 'tool_call_end') {
              pending.push({ id: event.id, name: event.name, input: event.input })
            } else if (event.type === 'usage') usage = event.usage
            else if (event.type === 'done') break
            else if (event.type === 'error') throw event.error
          }

          if (pending.length === 0) {
            report = collected.join('')
            return
          }

          const results = await Promise.all(
            pending.map(async (call) => {
              toolCalls++
              options.onActivity?.(spec.id, `${definition.label}: ${call.name}`)
              return this.#callTool(call, allowed, spec, options.signal)
            }),
          )

          // Continue the subagent's conversation with the tool results.
          const messages: AgentMessage[] = [
            {
              role: 'assistant',
              content: [
                ...(collected.length > 0
                  ? [{ type: 'text' as const, text: collected.join('') }]
                  : []),
                ...pending.map((c) => ({
                  type: 'tool_use' as const,
                  id: c.id,
                  name: c.name,
                  input: c.input,
                })),
              ],
            },
            {
              role: 'user',
              content: results.map((r) => ({
                type: 'tool_result' as const,
                toolUseId: r.toolUseId,
                content: r.content,
                isError: r.isError,
              })),
            },
          ]

          const followUp = this.#deps.provider.stream({
            model,
            system: { text: roleSystemPrompt(spec.role, spec.task) },
            messages,
            tools: allowed
              .map((name) => this.#deps.tools.get(name))
              .filter(Boolean)
              .map((tool) => ({
                name: tool!.name,
                description: tool!.description,
                inputSchema: this.#jsonSchema(tool!),
              })),
            effort,
            signal: options.signal,
          })
          events = followUp
        }
        report = report || 'Subagent reached its turn limit without reporting.'
      })()

      await drive
    } catch (err) {
      if (isAbortError(err)) {
        return { ...this.#cancelled(spec), durationMs: Date.now() - started, toolCalls }
      }
      return {
        id: spec.id,
        role: spec.role,
        label: definition.label,
        report: '',
        usage,
        durationMs: Date.now() - started,
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
        toolCalls,
      }
    }

    return {
      id: spec.id,
      role: spec.role,
      label: definition.label,
      report: report.trim(),
      usage,
      durationMs: Date.now() - started,
      status: 'completed',
      toolCalls,
    }
  }

  /**
   * Run one tool call on a subagent's behalf.
   *
   * Authorization is identical to the main agent's — a subagent is not a
   * privilege level. A denied call comes back as a tool_result error so the
   * subagent can adjust, exactly as it would for the main agent.
   */
  async #callTool(
    call: { id: string; name: string; input: unknown },
    allowed: readonly string[],
    spec: SubagentSpec,
    signal: AbortSignal,
  ): Promise<{ toolUseId: string; content: string; isError: boolean }> {
    const tool = this.#deps.tools.get(call.name)
    if (!tool || !allowed.includes(call.name)) {
      return {
        toolUseId: call.id,
        content: `Tool "${call.name}" is not available to a ${spec.role} subagent.`,
        isError: true,
      }
    }

    let input: unknown
    try {
      input = tool.inputSchema.parse(call.input ?? {})
    } catch (err) {
      return {
        toolUseId: call.id,
        content: `Invalid arguments: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }

    const ctx: ToolContext = {
      cwd: this.#deps.workspaceRoot,
      workspaceRoot: this.#deps.workspaceRoot,
      permissions: this.#deps.permissions,
      sandbox: this.#deps.sandbox,
      logger: this.#deps.logger.child({ subagent: spec.id, role: spec.role }),
      sessionId: `${this.#deps.sessionId}:${spec.id}`,
      signal,
      emit: () => {},
      noteFileChange: () => {},
    }

    const action = tool.plan(input as never, ctx)
    const verdict = await this.#deps.permissions.authorize({ ...action, input })
    if (verdict.decision.outcome === 'deny') {
      return {
        toolUseId: call.id,
        content: `Permission denied: ${verdict.decision.reason}. Work without it.`,
        isError: true,
      }
    }

    try {
      const result: ToolResult = await tool.execute(input as never, ctx)
      return { toolUseId: call.id, content: result.content, isError: result.isError === true }
    } catch (err) {
      return {
        toolUseId: call.id,
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      }
    }
  }

  #toolsFor(spec: SubagentSpec): readonly string[] {
    if (spec.tools) return spec.tools
    const definition = roleDefinition(spec.role)
    if (definition.allowedTools) return definition.allowedTools
    // A role with no allowlist gets everything except the tools that change
    // the world, unless it is explicitly an implementer-style role.
    const all = this.#deps.tools.visible().map((t) => t.name)
    const mutating = new Set(this.#deps.mutatingTools)
    return all.filter((name) => !mutating.has(name) || spec.role === 'implementer')
  }

  #cancelled(spec: SubagentSpec): SubagentResult {
    return {
      id: spec.id,
      role: spec.role,
      label: roleDefinition(spec.role).label,
      report: '',
      usage: { inputTokens: 0, outputTokens: 0 },
      durationMs: 0,
      status: 'cancelled',
      toolCalls: 0,
    }
  }

  #jsonSchema(tool: NonNullable<ReturnType<ToolRegistry['get']>>): Record<string, unknown> {
    return toJsonSchema(tool.inputSchema)
  }
}

/** Render results as the block the main agent reasons over. */
export function formatSubagentResults(results: readonly SubagentResult[]): string {
  return results
    .map((r) => {
      if (r.status === 'cancelled') return `## ${r.label}\n\nCancelled.`
      if (r.status === 'failed') return `## ${r.label}\n\nFailed: ${r.error ?? 'unknown error'}`
      return `## ${r.label}\n\n${r.report}`
    })
    .join('\n\n')
}
