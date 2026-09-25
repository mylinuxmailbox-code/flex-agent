import { z } from 'zod'
import type { PlanStep } from '../agent/events.js'
import type { Logger } from '../observability/logger.js'
import type { ActionDescription, ToolAuthorizer } from '../permissions/types.js'
import type { Sandbox } from '../sandbox/types.js'

/** Progress and display hints streamed from a running tool to the UI. */
export type ToolEvent =
  | { type: 'status'; text: string }
  | { type: 'output'; stream: 'stdout' | 'stderr'; chunk: string }
  | { type: 'progress'; ratio: number; label?: string }
  | { type: 'diff'; path: string; diff: string }
  | { type: 'files-changed'; paths: string[] }
  | { type: 'plan'; steps: PlanStep[] }

/** What the model sees back. Kept small on purpose — it becomes context. */
export interface ToolResult {
  content: string
  isError?: boolean
  /** Structured extras that never enter the model's context. */
  metadata?: Record<string, unknown>
  /** One-line summary for the collapsed tool-call row in the UI. */
  display?: string
}

export interface ToolContext {
  /** Process working directory for this session. */
  readonly cwd: string
  /** Repository/workspace root. Filesystem tools resolve paths against this. */
  readonly workspaceRoot: string
  readonly permissions: ToolAuthorizer
  readonly sandbox: Sandbox
  readonly logger: Logger
  readonly sessionId: string
  /** Aborts when the user cancels (Esc / Ctrl+C). */
  readonly signal: AbortSignal
  emit(event: ToolEvent): void
  /** Track a file the user should be able to review afterwards. */
  noteFileChange(path: string): void
}

/**
 * A capability the agent can invoke.
 *
 * `plan` is mandatory and runs *before* authorization: it is how a tool tells
 * the security layer what it is about to touch. A tool that under-reports here
 * can bypass the classifier, so `plan` must be conservative — report every path
 * and network destination the execute path could possibly use.
 */
export interface Tool<TSchema extends z.ZodType = z.ZodType> {
  readonly name: string
  readonly description: string
  readonly inputSchema: TSchema
  /** True for tools that cannot mutate anything. Used for auto-approval and UI hints. */
  readonly readOnly: boolean
  /** Grouping for `/help` and the tool palette. */
  readonly category: ToolCategory
  /** Describe the action for the risk classifier, before it runs. */
  plan(input: z.output<TSchema>, ctx: ToolContext): ActionDescription
  execute(input: z.output<TSchema>, ctx: ToolContext): Promise<ToolResult>
  /** Overrides the default prompt guidance injected into the system prompt. */
  readonly promptGuidance?: string
}

export type ToolCategory =
  | 'filesystem'
  | 'search'
  | 'shell'
  | 'git'
  | 'web'
  | 'code'
  | 'testing'
  | 'task'
  | 'memory'

/** Convert a tool's zod schema to the JSON Schema the model sees. */
export function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'output', unrepresentable: 'any' }) as Record<
    string,
    unknown
  >
  // Every Flex tool takes a single object argument; make that explicit.
  if (json.type !== 'object') {
    return { type: 'object', properties: { input: json }, required: ['input'] }
  }
  return json
}

export function ok(
  content: string,
  display?: string,
  metadata?: Record<string, unknown>,
): ToolResult {
  return { content, display, metadata }
}

export function fail(content: string, display?: string): ToolResult {
  return { content, isError: true, display: display ?? 'error' }
}

/** Error text goes back to the model as evidence, not as a thrown exception. */
export function errorResult(err: unknown, display?: string): ToolResult {
  const message = err instanceof Error ? err.message : String(err)
  return { content: `Error: ${message}`, isError: true, display: display ?? 'error' }
}
