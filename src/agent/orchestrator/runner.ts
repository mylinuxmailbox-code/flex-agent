import type { ModelProvider } from '../../models/provider.js'
import {
  type EffortProfile,
  isAbortError,
  type SingleAgentEffort,
  type Usage,
} from '../../models/types.js'
import type { Logger } from '../../observability/logger.js'
import type { ToolAuthorizer } from '../../permissions/types.js'
import type { Sandbox } from '../../sandbox/types.js'
import { ToolRegistry } from '../../tools/registry.js'
import type { ToolContext } from '../../tools/types.js'
import { AgentRuntime } from '../runtime/loop.js'
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
  /** Tools a subagent may use for side effects (shell, write). May be a getter. */
  mutatingTools: readonly string[] | (() => readonly string[])
  /** Forward file changes to the parent's tracked list. */
  noteFileChange?: (path: string) => void
  web?: ToolContext['web']
}

/** A subagent that has not reported after this many model turns is asked to wrap up. */
const MAX_SUBAGENT_TURNS = 24

export class SubagentRunner {
  readonly #deps: SubagentRunnerDeps

  constructor(deps: SubagentRunnerDeps) {
    this.#deps = deps
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
    let lastTurnText = ''

    const allowed = this.#toolsFor(spec)
    const effort = spec.effort ?? this.#deps.effort.subagents ?? 'high'

    // A subagent is an ordinary agent loop with a narrower tool set and a role
    // prompt. Running the real loop (rather than a second, lighter one) means it
    // inherits everything the main loop does right: full history across turns,
    // signed-thinking replay, parallel tools, truncation recovery, permissions.
    const scoped = new ToolRegistry()
    for (const name of allowed) {
      const tool = this.#deps.tools.get(name)
      if (tool) scoped.register(tool)
    }

    const runtime = new AgentRuntime({
      provider: this.#deps.provider,
      tools: scoped,
      permissions: this.#deps.permissions,
      sandbox: this.#deps.sandbox,
      logger: this.#deps.logger.child({ subagent: spec.id, role: spec.role }),
      model: spec.model ?? this.#deps.model,
      effort: { ...this.#deps.effort, main: effort, subagents: null },
      sessionId: `${this.#deps.sessionId}:${spec.id}`,
      systemText: roleSystemPrompt(spec.role, spec.task),
      maxTurns: MAX_SUBAGENT_TURNS,
      finalizeOnLimit: true,
      onFileChange: this.#deps.noteFileChange,
      web: this.#deps.web,
      promptContext: {
        workspaceRoot: this.#deps.workspaceRoot,
        repoSummary: '',
        projectInstructions: '',
        notices: [],
        platform: `${process.platform} ${process.arch}`,
        today: new Date().toISOString().slice(0, 10),
      },
    })

    let failure: Error | null = null
    let aborted = false
    try {
      for await (const event of runtime.run(spec.task, { signal: options.signal })) {
        switch (event.type) {
          case 'turn_start':
            lastTurnText = ''
            break
          case 'text_delta':
            lastTurnText += event.text
            break
          case 'tool_start':
            toolCalls++
            options.onActivity?.(spec.id, `${definition.label}: ${event.name}`)
            break
          case 'error':
            failure = event.error
            break
          case 'done':
            if (event.stopReason === 'aborted') aborted = true
            break
          default:
            break
        }
        report = lastTurnText
      }
    } catch (err) {
      if (isAbortError(err)) aborted = true
      else failure = err instanceof Error ? err : new Error(String(err))
    }

    const usage = runtime.usage
    if (aborted || options.signal.aborted) {
      return { ...this.#cancelled(spec), usage, durationMs: Date.now() - started, toolCalls }
    }
    if (failure) {
      return {
        id: spec.id,
        role: spec.role,
        label: definition.label,
        report: '',
        usage,
        durationMs: Date.now() - started,
        status: 'failed',
        error: failure.message,
        toolCalls,
      }
    }
    return {
      id: spec.id,
      role: spec.role,
      label: definition.label,
      report: report.trim() || 'The subagent finished without writing a report.',
      usage,
      durationMs: Date.now() - started,
      status: 'completed',
      toolCalls,
    }
  }

  #toolsFor(spec: SubagentSpec): readonly string[] {
    // A subagent never spawns subagents: fan-out is the main agent's decision.
    const noRecursion = (names: readonly string[]) => names.filter((n) => n !== 'spawn_subagent')
    if (spec.tools) return noRecursion(spec.tools)
    const definition = roleDefinition(spec.role)
    if (definition.allowedTools) return noRecursion(definition.allowedTools)
    // A role with no allowlist gets everything except the tools that change
    // the world, unless it is explicitly an implementer-style role.
    // Read lazily: MCP and plugin tools register after this runner is built.
    const mutating = new Set(
      typeof this.#deps.mutatingTools === 'function'
        ? this.#deps.mutatingTools()
        : this.#deps.mutatingTools,
    )
    const all = this.#deps.tools.visible().map((t) => t.name)
    return noRecursion(all.filter((name) => !mutating.has(name) || spec.role === 'implementer'))
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
