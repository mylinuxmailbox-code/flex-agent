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
  /**
   * Whether commands run inside a sandbox. When false (the default for a
   * session with no working backend), commands that are not plainly read-only
   * are treated as at least medium risk.
   */
  sandboxIsolated?: boolean
  /** Log every decision. */
  onDecision?: (result: AuthorizeResult, action: ActionDescription) => void
  /** Extra read/write roots the session may use without prompting. */
  grantedReadRoots?: readonly string[]
  grantedWriteRoots?: readonly string[]
}

/**
 * An approval the user granted for the rest of the current task.
 *
 * A grant remembers how risky the approved action was. A later action only
 * rides on it if it is no riskier and raises no signal the approved one did not:
 * approving `npm test` must not approve `npm test && rm -rf /`.
 */
interface TaskGrant {
  tool: string
  command?: string
  level: RiskLevel
  signals: readonly RiskSignal[]
  description: string
}

/** Commands that only read, and are safe to run even with no sandbox. */
const READ_ONLY_COMMAND =
  /^\s*(ls|pwd|cat|head|tail|wc|echo|printf|which|whoami|date|uname|stat|file|tree|du|df|grep|rg|diff|sort|uniq|basename|dirname|realpath|git\s+(status|diff|log|show|branch|rev-parse|ls-files|remote\s+-v|blame|describe))\b/
const SHELL_METACHARACTERS = /[;&|<>`\n]|\$\(|\$\{/

export function isReadOnlyCommand(command: string): boolean {
  return READ_ONLY_COMMAND.test(command) && !SHELL_METACHARACTERS.test(command)
}

/**
 * The single decision point for every consequential operation.
 *
 * Order of resolution:
 *   1. full-control mode (allow, but still classified + logged)
 *   2. an outstanding task grant that covers this action's risk
 *   3. a hard `neverAuto` signal (always ask, even in auto mode)
 *   4. an explicit root grant (path inside an allowed write root)
 *   5. the mode's rule:
 *        auto: anything at or below `autoThreshold` proceeds
 *        ask:  anything above `askThreshold` (default `safe`) is asked about
 */
export class PermissionEngine implements ToolAuthorizer {
  readonly #opts: PermissionEngineOptions
  readonly #taskGrants: TaskGrant[] = []
  #mode: PermissionMode
  #requestSeq = 0
  #prompter: PermissionPrompter | undefined

  constructor(opts: PermissionEngineOptions) {
    this.#opts = opts
    this.#mode = opts.mode
    this.#prompter = opts.prompter
  }

  get mode(): PermissionMode {
    return this.#mode
  }

  /** Switch posture mid-session (`/auto`, `/permissions`). Grants are dropped. */
  setMode(mode: PermissionMode): void {
    if (mode === this.#mode) return
    this.#mode = mode
    this.clearGrants()
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

  /** Called at the start of every user turn: "for this task" means this task. */
  clearGrants(): void {
    this.#taskGrants.length = 0
  }

  async authorize(request: AuthorizeRequest): Promise<AuthorizeResult> {
    const risk = this.#floor(request, request.risk ?? this.#opts.classifier.assess(request))
    const requestId = request.requestId ?? `perm-${++this.#requestSeq}`

    const { decision, source } = await this.#resolve(request, risk, requestId)
    const result: AuthorizeResult = { decision, risk, source }
    this.#opts.onDecision?.(result, request)
    return result
  }

  /**
   * Without isolation nothing contains a command, so "safe" can only mean
   * "known to only read". Anything else is at least medium.
   */
  #floor(request: AuthorizeRequest, risk: RiskAssessment): RiskAssessment {
    if (this.#opts.sandboxIsolated !== false) return risk
    if (!request.command || isReadOnlyCommand(request.command)) return risk
    if (RISK_ORDER[risk.level] >= RISK_ORDER.medium) return risk
    return {
      ...risk,
      level: 'medium',
      reasons: [
        ...risk.reasons.filter((r) => r !== 'no risk signals detected'),
        'runs without a sandbox',
      ],
    }
  }

  #hasNeverAuto(risk: RiskAssessment): boolean {
    const blocked = this.#opts.neverAuto ?? DEFAULT_NEVER_AUTO
    return risk.signals.some((s) => blocked.includes(s))
  }

  #covered(request: AuthorizeRequest, risk: RiskAssessment): boolean {
    return this.#taskGrants.some(
      (g) =>
        g.tool === request.tool &&
        sameCommandFamily(g.command, request.command) &&
        RISK_ORDER[risk.level] <= RISK_ORDER[g.level] &&
        risk.signals.every((s) => g.signals.includes(s)) &&
        !(
          request.command &&
          SHELL_CHAIN.test(request.command) &&
          !SHELL_CHAIN.test(g.command ?? '')
        ),
    )
  }

  async #resolve(
    request: AuthorizeRequest,
    risk: RiskAssessment,
    requestId: string,
  ): Promise<{ decision: PermissionDecision; source: AuthorizeResult['source'] }> {
    const asked = async () => ({
      decision: await this.#ask(request, risk, requestId),
      source: 'user' as const,
    })

    // 1. Full control is an explicit, visible, informed choice.
    if (this.#mode === 'full-control')
      return { decision: { outcome: 'allow' }, source: 'full-control' }

    // 2. A grant the user already made for this task, if this action is within it.
    if (this.#covered(request, risk))
      return { decision: { outcome: 'allow' }, source: 'pre-granted' }

    // 3. A hard block on auto-approval.
    if (this.#hasNeverAuto(risk)) return asked()

    // 4. Path-level grants narrow `outside-workspace-write` rather than blanket-allowing.
    if (risk.level !== 'safe' && !risk.signals.includes('destructive-delete')) {
      if (this.#pathsAreGranted(request))
        return { decision: { outcome: 'allow' }, source: 'policy' }
    }

    // 5. Mode rule. `ask` is stricter than `auto` by default: it prompts for
    // anything above `safe`; `auto` also lets `low` (e.g. dependency installs) through.
    const threshold =
      this.#mode === 'auto'
        ? (this.#opts.autoThreshold ?? 'low')
        : (this.#opts.askThreshold ?? 'safe')
    if (RISK_ORDER[risk.level] <= RISK_ORDER[threshold]) {
      return { decision: { outcome: 'allow' }, source: 'policy' }
    }
    return asked()
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
          command: request.command,
          level: risk.level,
          signals: risk.signals,
          description: request.command
            ? `${request.tool}: ${request.command.trim().split(/\s+/).slice(0, 2).join(' ')} …`
            : `${request.tool} for this task`,
        })
        return { outcome: 'allow-for-task' }
      case 'deny':
        return { outcome: 'deny', reason: 'the user denied this action' }
    }
  }
}

const SHELL_CHAIN = /&&|\|\||;|\||`|\$\(|\n/

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
  if (!a && !b) return true
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
