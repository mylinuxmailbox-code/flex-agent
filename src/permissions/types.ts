/**
 * The permission vocabulary.
 *
 * Flex has exactly three postures, and every tool call in every provider —
 * built-in, plugin, or MCP — passes through `ToolAuthorizer.authorize` before
 * it executes. There is no code path from an agent decision to a side effect
 * that skips this file's concepts.
 */

export type RiskLevel = 'safe' | 'low' | 'medium' | 'high' | 'critical'

export const RISK_ORDER: Record<RiskLevel, number> = {
  safe: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
}

export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b
}

export type PermissionMode =
  /** Ask about anything above the configured auto threshold. */
  | 'ask'
  /** Auto-allow anything the classifier rates safe or low; ask above. */
  | 'auto'
  /** `--full-control`: no prompts, no normal sandbox, but still logged. */
  | 'full-control'

export type PermissionDecision =
  /** Proceed. */
  | { outcome: 'allow' }
  /** Proceed this once only. */
  | { outcome: 'allow-once' }
  /** Proceed for the remainder of the current task. */
  | { outcome: 'allow-for-task' }
  /** Refuse. The agent sees the reason and must find another route. */
  | { outcome: 'deny'; reason: string }

/** Everything the classifier and policy engine reason about. */
export interface ActionDescription {
  /** Tool name, e.g. `run_command`, or `mcp__github__create_issue`. */
  tool: string
  /** Free-text summary of what the agent says it is doing. */
  purpose?: string
  /** Raw tool input, before interpretation. */
  input: unknown
  /** Files this action will read. */
  readPaths?: string[]
  /** Files this action will write, create, move, or delete. */
  writePaths?: string[]
  /** Network destinations this action will contact. */
  network?: NetworkTarget[]
  /** Shell command string, when applicable. */
  command?: string
  /** Working directory the action runs in. */
  cwd?: string
  /**
   * Signals the tool asserts about itself, independent of any command text.
   *
   * A tool knows what it does; the classifier cannot infer it from arguments.
   * Without this, `delete_file` looks identical to `write_file` as far as risk
   * is concerned, because both just name a path. Every tool whose nature is
   * destructive must declare that here — it is the only thing standing between
   * "delete a file" and "auto-approved delete a file".
   */
  signals?: RiskSignal[]
}

export interface NetworkTarget {
  host: string
  protocol?: 'http' | 'https' | 'ws' | 'wss' | 'ssh' | 'other'
  port?: number
  /** Human description of what data leaves, when known. */
  transmits?: string
}

export interface RiskAssessment {
  level: RiskLevel
  /** Short, user-facing reasons. Shown in the permission prompt. */
  reasons: string[]
  /** Machine-readable signals the policy engine can match on. */
  signals: RiskSignal[]
  /** True when the effect cannot be undone by the agent. */
  irreversible: boolean
  /** True when the action leaves the machine. */
  external: boolean
}

export type RiskSignal =
  | 'destructive-delete'
  | 'system-modification'
  | 'privilege-escalation'
  | 'credential-access'
  | 'secret-exposure'
  | 'remote-execution'
  | 'network-exfiltration'
  | 'cloud-destruction'
  | 'production-modification'
  | 'outside-workspace-write'
  | 'permission-change'
  | 'account-security-change'
  | 'force-push'
  | 'history-rewrite'
  | 'dependency-install'
  | 'package-publish'
  | 'large-download'
  | 'long-running'

export interface AuthorizeRequest extends ActionDescription {
  /** The risk computed by the classifier; supplied for logging. */
  risk?: RiskAssessment
  /** Monotonic id used to match a prompt to its response. */
  requestId?: string
}

export interface AuthorizeResult {
  decision: PermissionDecision
  risk: RiskAssessment
  /** How the decision was reached — shown in debug mode. */
  source: 'classifier' | 'policy' | 'user' | 'full-control' | 'pre-granted'
}

/**
 * The gate every tool call passes through.
 *
 * Implementations must be safe to call concurrently.
 */
export interface ToolAuthorizer {
  authorize(request: AuthorizeRequest): Promise<AuthorizeResult>
  readonly mode: PermissionMode
}

/** A permission prompt the UI must render and answer. */
export interface PermissionPrompt {
  requestId: string
  action: ActionDescription
  risk: RiskAssessment
  /** Rendered command preview or file summary, already truncated for display. */
  preview: string
}

/** User's answer to a prompt. */
export type PermissionChoice = 'allow-once' | 'allow-for-task' | 'deny'
