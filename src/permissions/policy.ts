import { type ClassifierContext, isInside, RiskClassifier } from './classifier.js'
import type {
  ActionDescription,
  AuthorizeRequest,
  AuthorizeResult,
  NetworkTarget,
  PermissionChoice,
  PermissionDecision,
  PermissionMode,
  PermissionPrompt,
  RiskAssessment,
  RiskLevel,
  ToolAuthorizer,
} from './types.js'
import { RISK_ORDER, type RiskSignal } from './types.js'

/** The UI implements this to ask the user. The engine never touches stdin itself. */
export interface PermissionPrompter {
  prompt(request: PermissionPrompt): Promise<PermissionChoice>
}

export interface PermissionEngineOptions {
  mode: PermissionMode
  classifier: RiskClassifier
  prompter?: PermissionPrompter
  /** In `auto` mode, anything at or below this level proceeds silently. */
  autoThreshold?: RiskLevel
  /** In `ask` mode, anything at or above this level always prompts. */
  askThreshold?: RiskLevel
  /** Signals that may never be auto-approved, regardless of level. */
  neverAuto?: readonly RiskSignal[]
  /** Log every decision. */
  onDecision?: (result: AuthorizeResult, action: ActionDescription) => void
  /** Extra read/write roots the session may use without prompting. */
  grantedReadRoots?: readonly string[]
  grantedWriteRoots?: readonly string[]
}

/** An approval the user granted for the rest of the current task. */
interface TaskGrant {
  tool: string
  /** Optional predicate narrowing what the grant covers. */
  matches?: (action: ActionDescription) => boolean
  description: string
}

/**
 * The single decision point for every consequential operation.
 *
 * Order of resolution:
 *   1. full-control mode (allow, but still classified + logged)
 *   2. an outstanding task grant
 *   3. an explicit root grant (path inside an allowed read/write root)
 *   4. a hard `neverAuto` signal (always ask, even in auto mode)
 *   5. the mode's threshold — allow or ask
 */
export class PermissionEngine implements ToolAuthorizer {
  mode: PermissionMode
  readonly #opts: PermissionEngineOptions
  readonly #taskGrants: TaskGrant[] = []
  #requestSeq = 0
  #prompter: PermissionPrompter | undefined

  constructor(opts: PermissionEngineOptions) {
    this.#opts = opts
    this.mode = opts.mode
    this.#prompter = opts.prompter
  }

  setMode(mode: PermissionMode): void {
    this.mode = mode
  }

  /**
   * Attach or detach the UI prompt after construction.
   *
   * The session creates the engine before the UI exists, so the dialog is
   * injected later. Without this the engine would silently fail closed on
   * anything risky and the agent would stall with no visible reason.
   */
  setPrompter(prompter: PermissionPrompter | undefined): void {
    this.#prompter = prompter
  }

  get classifier(): RiskClassifier {
    return this.#opts.classifier
  }

  /** `/permissions` uses this to show what is currently pre-approved. */
  activeGrants(): readonly { description: string; tool: string }[] {
    return this.#taskGrants.map((g) => ({ description: g.description, tool: g.tool }))
  }

  clearGrants(): void {
    this.#taskGrants.length = 0
  }

  async authorize(request: AuthorizeRequest): Promise<AuthorizeResult> {
    const risk = request.risk ?? this.#opts.classifier.assess(request)
    const requestId = request.requestId ?? `perm-${++this.#requestSeq}`

    const decision = await this.#resolve(request, risk, requestId)
    const result: AuthorizeResult = { decision, risk, source: this.#sourceFor(request, risk) }
    this.#opts.onDecision?.(result, request)
    return result
  }

  #sourceFor(request: AuthorizeRequest, risk: RiskAssessment): AuthorizeResult['source'] {
    // Denials always come from the user or a hard refusal, never from a threshold.
    if (this.mode === 'full-control') return 'full-control'
    const granted = this.#taskGrants.find(
      (g) => g.tool === request.tool && (g.matches?.(request) ?? true),
    )
    if (granted) return 'pre-granted'
    const threshold =
      this.mode === 'auto'
        ? (this.#opts.autoThreshold ?? 'low')
        : (this.#opts.askThreshold ?? 'low')
    if (RISK_ORDER[risk.level] <= RISK_ORDER[threshold] && !this.#hasNeverAuto(risk)) {
      return 'policy'
    }
    return 'user'
  }

  #hasNeverAuto(risk: RiskAssessment): boolean {
    const blocked = this.#opts.neverAuto ?? DEFAULT_NEVER_AUTO
    return risk.signals.some((s) => blocked.includes(s))
  }

  async #resolve(
    request: AuthorizeRequest,
    risk: RiskAssessment,
    requestId: string,
  ): Promise<PermissionDecision> {
    // 1. Full control is an explicit, visible, informed choice.
    if (this.mode === 'full-control') return { outcome: 'allow' }

    // 2. A grant the user already made for this task.
    const grant = this.#taskGrants.find(
      (g) => g.tool === request.tool && (g.matches?.(request) ?? true),
    )
    if (grant) return { outcome: 'allow' }

    // 3. A hard block on auto-approval.
    if (this.#hasNeverAuto(risk)) return this.#ask(request, risk, requestId)

    // 4. Path-level grants narrow `outside-workspace-write` rather than blanket-allowing.
    if (risk.level !== 'safe' && !risk.signals.includes('destructive-delete')) {
      if (this.#pathsAreGranted(request)) return { outcome: 'allow' }
    }

    // 5. Mode threshold.
    const threshold =
      this.mode === 'auto'
        ? (this.#opts.autoThreshold ?? 'low')
        : (this.#opts.askThreshold ?? 'low')
    if (RISK_ORDER[risk.level] <= RISK_ORDER[threshold]) return { outcome: 'allow' }

    return this.#ask(request, risk, requestId)
  }

  #pathsAreGranted(request: AuthorizeRequest): boolean {
    const writes = request.writePaths ?? []
    if (writes.length === 0) return false
    const allowed = [
      ...(this.#opts.grantedWriteRoots ?? []),
      ...(this.#opts.grantedReadRoots ?? []),
    ]
    if (allowed.length === 0) return false
    return writes.every((p) => allowed.some((root) => isInside(p, root)))
  }

  async #ask(
    request: AuthorizeRequest,
    risk: RiskAssessment,
    requestId: string,
  ): Promise<PermissionDecision> {
    const prompter = this.#prompter
    if (!prompter) {
      // No UI to ask through (e.g. headless mode): fail closed at medium and above.
      if (RISK_ORDER[risk.level] >= RISK_ORDER.medium) {
        return {
          outcome: 'deny',
          reason: 'no interactive prompt available; refusing a risky operation',
        }
      }
      return { outcome: 'allow' }
    }

    let choice: PermissionChoice
    try {
      choice = await prompter.prompt({
        requestId,
        action: request,
        risk,
        preview: renderPreview(request),
      })
    } catch (err) {
      return {
        outcome: 'deny',
        reason: `permission prompt failed: ${err instanceof Error ? err.message : String(err)}`,
      }
    }

    switch (choice) {
      case 'allow-once':
        return { outcome: 'allow-once' }
      case 'allow-for-task':
        this.#taskGrants.push({
          tool: request.tool,
          description: `${request.tool} for this task`,
          matches: request.command
            ? (a) => sameCommandFamily(a.command, request.command)
            : undefined,
        })
        return { outcome: 'allow-for-task' }
      case 'deny':
        return { outcome: 'deny', reason: 'the user denied this action' }
    }
  }
}

/**
 * Signals that are never silently auto-approved, even in auto mode and even at
 * a low level. These are the ones where a wrong guess is unrecoverable.
 */
export const DEFAULT_NEVER_AUTO: readonly RiskSignal[] = [
  'destructive-delete',
  'privilege-escalation',
  'credential-access',
  'secret-exposure',
  'remote-execution',
  'network-exfiltration',
  'cloud-destruction',
  'production-modification',
  'account-security-change',
  'package-publish',
  'force-push',
  'permission-change',
]

/** `npm test` and `npm run test:watch` should share one grant; `npm publish` must not. */
function sameCommandFamily(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  const head = (s: string) => s.trim().split(/\s+/).slice(0, 2).join(' ')
  return head(a) === head(b)
}

/** A compact, safe one-liner for the permission dialog. */
export function renderPreview(action: ActionDescription): string {
  if (action.command) return `$ ${action.command}`
  const writes = action.writePaths ?? []
  const reads = action.readPaths ?? []
  if (writes.length > 0) {
    const shown = writes.slice(0, 3).join(', ')
    return writes.length > 3 ? `write: ${shown} (+${writes.length - 3} more)` : `write: ${shown}`
  }
  if (reads.length > 0) {
    const shown = reads.slice(0, 3).join(', ')
    return reads.length > 3 ? `read: ${shown} (+${reads.length - 3} more)` : `read: ${shown}`
  }
  const net = action.network ?? []
  if (net.length > 0) return `network: ${net.map(describeTarget).join(', ')}`
  return action.purpose ?? action.tool
}

function describeTarget(t: NetworkTarget): string {
  return t.port ? `${t.host}:${t.port}` : t.host
}

/** Convenience for tools: build a classifier for a workspace. */
export function createClassifier(ctx: ClassifierContext): RiskClassifier {
  return new RiskClassifier(ctx)
}
