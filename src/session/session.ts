import { join, resolve } from 'node:path'
import { execa } from 'execa'
import type { AgentEvent } from '../agent/events.js'
import { SubagentRunner } from '../agent/orchestrator/runner.js'
import { AgentRuntime } from '../agent/runtime/loop.js'
import { loadConfig, type ResolvedConfig } from '../config/index.js'
import { readProjectInstructions, summariseRepository } from '../context/repo.js'
import { mcpManager } from '../mcp/registry.js'
import type { ModelProvider } from '../models/provider.js'
import { buildProviders, pickDefaultModel } from '../models/registry.js'
import { ProviderRouter } from '../models/router.js'
import type { ModelInfo } from '../models/types.js'
import { type EffortLevel, effortProfile } from '../models/types.js'
import { createLogger, defaultLogDir, type Logger } from '../observability/logger.js'
import { RiskClassifier } from '../permissions/classifier.js'
import { PermissionEngine } from '../permissions/policy.js'
import type {
  PermissionChoice,
  PermissionMode,
  PermissionPrompt,
  RiskSignal,
} from '../permissions/types.js'
import { pluginManager } from '../plugins/manager.js'
import { createSandbox, flexDirs } from '../sandbox/index.js'
import type { NetworkPolicy, Sandbox } from '../sandbox/types.js'
import { registerBuiltinTools } from '../tools/index.js'
import { ToolRegistry } from '../tools/registry.js'
import { killAllBackground } from '../tools/shell/run.js'
import { createSpawnSubagentTool } from '../tools/task/spawn.js'
import { type PersistedSession, sessionPersistence } from './persistence.js'

/**
 * The composition root.
 *
 * Everything is constructed here and injected downward. Nothing below this
 * file reaches for a global, which is what makes the agent runnable in a test
 * with a fake provider and a no-op sandbox.
 */

export interface SessionConfig {
  /** Unset means "whatever config says", then the first provider that has a key. */
  model?: string
  effort?: EffortLevel
  permissionMode?: PermissionMode
  workspaceRoot: string
  /** `--full-control` also disables the sandbox. */
  fullControl?: boolean
  debug?: boolean
  /** Anthropic credential/endpoint overrides. Other providers come from env and config. */
  baseURL?: string
  apiKey?: string
  sessionId?: string
  /** Test seam: use these providers instead of building them from env and config. */
  providers?: ModelProvider[]
  /** Test seam: skip MCP servers and plugins. */
  extensions?: boolean
}

/** What the session is actually running with, after config and defaults. */
export interface ResolvedSessionConfig {
  model: string
  effort: EffortLevel
  permissionMode: PermissionMode
  workspaceRoot: string
  fullControl: boolean
  debug: boolean
  sessionId?: string
}

const FALLBACK_MODEL = 'claude-opus-5-5'

/** Drop keys whose value is undefined, so they cannot shadow a lower config layer. */
function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>
}

export interface PromptRequest {
  prompt: PermissionPrompt
  resolve: (choice: PermissionChoice) => void
}

export class Session {
  readonly config: ResolvedSessionConfig
  readonly router: ProviderRouter
  /** One-off messages worth showing before the UI takes over the terminal. */
  readonly startupNotices: string[]
  readonly resolvedConfig: ResolvedConfig
  readonly logger: Logger
  readonly sandbox: Sandbox
  readonly tools: ToolRegistry
  readonly permissions: PermissionEngine
  readonly runtime: AgentRuntime
  readonly providers: ModelProvider[]

  #abort: AbortController | null = null
  #activeModel: string
  #activeEffort: EffortLevel
  #createdAt: number = Date.now()
  readonly #syncSubagentTool: (profile: ReturnType<typeof effortProfile>) => void

  private constructor(init: {
    config: ResolvedSessionConfig
    router: ProviderRouter
    startupNotices: string[]
    resolvedConfig: ResolvedConfig
    logger: Logger
    sandbox: Sandbox
    tools: ToolRegistry
    permissions: PermissionEngine
    runtime: AgentRuntime
    providers: ModelProvider[]
    syncSubagentTool: (profile: ReturnType<typeof effortProfile>) => void
  }) {
    this.config = init.config
    this.router = init.router
    this.startupNotices = init.startupNotices
    this.resolvedConfig = init.resolvedConfig
    this.logger = init.logger
    this.sandbox = init.sandbox
    this.tools = init.tools
    this.permissions = init.permissions
    this.runtime = init.runtime
    this.providers = init.providers
    this.#syncSubagentTool = init.syncSubagentTool
    this.#activeModel = init.config.model
    this.#activeEffort = init.config.effort
  }

  static async create(config: SessionConfig): Promise<Session> {
    const dirs = flexDirs()
    const workspaceRoot = resolve(config.workspaceRoot)
    const startupNotices: string[] = []

    const logger = config.debug
      ? createLogger({ level: 'debug', dir: defaultLogDir(), stderr: true, sessionId: sessionId() })
      : createLogger({ level: 'info', dir: defaultLogDir() })

    // Config first: it decides the model, effort, sandbox posture and network
    // policy that everything below is built from. Only what the caller actually
    // specified goes in the session layer, so an unset flag cannot mask the file.
    const resolved = loadConfig({
      workspaceRoot,
      session: defined({
        model: config.model,
        effort: config.effort,
        permissions: config.permissionMode ? { mode: config.permissionMode } : undefined,
        sandbox: config.fullControl ? { enabled: false } : undefined,
      }),
    })
    const settings = resolved.value
    const effectiveEffort: EffortLevel = settings.effort ?? 'high'
    const permissionMode: PermissionMode = settings.permissions?.mode ?? 'ask'

    // --- providers and the starting model -----------------------------------
    const providers =
      config.providers ??
      buildProviders({
        providers: settings.providers,
        anthropic: { apiKey: config.apiKey, baseURL: config.baseURL },
      }).providers
    const router = new ProviderRouter(providers)

    let effectiveModel = settings.model ?? FALLBACK_MODEL
    if (resolved.provenance.model === 'defaults' || resolved.provenance.model === undefined) {
      // Nobody chose a model. Start on one whose provider can actually answer.
      let pick = pickDefaultModel(providers, '')
      if (!pick) {
        // A local server may only know its models after asking it.
        await Promise.race([router.refreshModels(), new Promise((r) => setTimeout(r, 3000))])
        pick = pickDefaultModel(providers, '')
      }
      effectiveModel = pick || FALLBACK_MODEL
    }
    const located = router.resolveModel(effectiveModel)
    if (located) effectiveModel = located.id
    const active = router.locate(effectiveModel)
    if (!active) {
      startupNotices.push(
        `No provider knows the model "${effectiveModel}". Use /model to pick one (see /providers).`,
      )
    } else if (!(active.provider.configured?.() ?? true)) {
      startupNotices.push(
        `${active.provider.label} has no credentials. ${credentialHint(active.provider.id)} Or pick another model with /model.`,
      )
    }

    // --- sandbox ---------------------------------------------------------------
    const sandboxDisabled = config.fullControl === true || settings.sandbox?.enabled === false
    const { sandbox, reason } = await createSandbox({
      workspaceRoot,
      disabled: sandboxDisabled,
      network: sandboxNetwork(settings.sandbox),
      limits: settings.sandbox?.limits ? defined(settings.sandbox.limits) : undefined,
      logger,
    })
    logger.info('sandbox ready', {
      backend: sandbox.info.backend,
      isolated: sandbox.info.isolated,
      reason,
    })

    const tools = new ToolRegistry()
    registerBuiltinTools(tools)

    const profile = effortProfile(effectiveEffort)

    const classifier = new RiskClassifier({
      workspaceRoot,
      tempDir: join(dirs.cacheDir, 'tmp'),
      cacheDir: dirs.cacheDir,
    })

    // The prompter is attached later by the UI; until then the engine fails
    // closed on anything risky, which is the safe default.
    const permissions = new PermissionEngine({
      mode: permissionMode,
      classifier,
      autoThreshold: settings.permissions?.autoThreshold ?? 'low',
      ...(settings.permissions?.neverAuto
        ? { neverAuto: settings.permissions.neverAuto as RiskSignal[] }
        : {}),
      sandboxIsolated: sandbox.info.isolated,
      onDecision: (result, action) => {
        logger.info('permission decision', {
          tool: action.tool,
          outcome: result.decision.outcome,
          level: result.risk.level,
          source: result.source,
        })
      },
    })

    const id = config.sessionId ?? sessionId()
    let runtimeRef: AgentRuntime | undefined

    // Subagent delegation is only advertised when the effort profile actually
    // fans out; in single-agent modes the model never sees the option at all.
    // `/effort` can switch between the two mid-session, so this is re-run then.
    const runner = new SubagentRunner({
      provider: router,
      tools,
      permissions,
      sandbox,
      logger,
      workspaceRoot,
      // Read at spawn time, so `/model` and `/effort` apply to later fan-outs.
      model: () => runtimeRef?.model ?? effectiveModel,
      effort: () => runtimeRef?.effort ?? profile,
      sessionId: id,
      // A getter, because MCP and plugin tools register after this point.
      mutatingTools: () =>
        tools
          .visible()
          .filter((t) => !t.readOnly)
          .map((t) => t.name),
      noteFileChange: (path) => runtimeRef?.trackFile(path),
      web: settings.web,
    })
    const syncSubagentTool = (p: ReturnType<typeof effortProfile>): void => {
      if (p.subagents) {
        tools.unregister('spawn_subagent')
        tools.register(createSpawnSubagentTool(runner, p.maxSubagents))
      } else {
        tools.unregister('spawn_subagent')
      }
    }
    syncSubagentTool(profile)
    if (profile.subagents) {
      logger.info('subagent orchestration enabled', {
        main: profile.main,
        subagents: profile.subagents,
        max: profile.maxSubagents,
      })
    }

    // External capability sources come last so their tools are registered after
    // the built-ins, and so a failure in any of them cannot stop the session.
    if (config.extensions !== false) {
      try {
        const loaded = await mcpManager.loadConfigs(workspaceRoot, {
          inline: settings.mcp?.servers,
          enabled: settings.mcp?.enabled,
          disabled: settings.mcp?.disabled,
        })
        for (const skip of loaded.skipped) {
          startupNotices.push(
            `MCP server "${skip.name}" from this project was not started: ${skip.reason}.`,
          )
        }
        if (loaded.configs.length > 0) {
          const result = await mcpManager.registerServers(loaded.configs, tools)
          logger.info('mcp servers connected', {
            connected: result.connected,
            failed: result.failed,
          })
          for (const f of result.failed) {
            startupNotices.push(`MCP server "${f.name}" failed to start: ${f.error}`)
          }
        }
      } catch (err) {
        logger.warn('mcp registration failed', { error: String(err) })
      }

      try {
        await pluginManager.loadAll(workspaceRoot, tools, {
          disabled: settings.plugins?.disabled,
          paths: settings.plugins?.paths,
          mcpEnabled: settings.mcp?.enabled,
        })
      } catch (err) {
        logger.warn('plugin loading failed', { error: String(err) })
      }
    }

    const [repoSummary, projectInstructions, gitBranch] = await Promise.all([
      summariseRepository(workspaceRoot),
      readProjectInstructions(workspaceRoot),
      currentBranch(workspaceRoot),
    ])

    const resolvedConfig: ResolvedSessionConfig = {
      model: effectiveModel,
      effort: effectiveEffort,
      permissionMode,
      workspaceRoot,
      fullControl: config.fullControl === true,
      debug: config.debug === true,
      sessionId: id,
    }

    const runtime = new AgentRuntime({
      provider: router,
      tools,
      permissions,
      sandbox,
      logger,
      model: effectiveModel,
      effort: profile,
      sessionId: id,
      web: settings.web,
      promptContext: {
        workspaceRoot,
        repoSummary,
        projectInstructions,
        notices: buildNotices(resolvedConfig, sandbox),
        platform: `${process.platform} ${process.arch}`,
        today: new Date().toISOString().slice(0, 10),
        gitBranch,
        sandboxNote: sandbox.info.isolated
          ? `${sandbox.info.backend} (${sandbox.info.detail})`
          : `UNSANDBOXED — ${sandbox.info.detail}`,
      },
    })
    runtimeRef = runtime

    sessionPersistence.onError = (err) =>
      logger.warn('could not save session', { error: String(err) })
    void sessionPersistence.prune().catch(() => undefined)

    return new Session({
      config: resolvedConfig,
      router,
      startupNotices,
      resolvedConfig: resolved,
      logger,
      sandbox,
      tools,
      permissions,
      providers,
      runtime,
      syncSubagentTool,
    })
  }

  static async resume(
    persisted: PersistedSession,
    overrides: Partial<SessionConfig> = {},
  ): Promise<Session> {
    // `undefined` in an override means "not specified", never "clear it".
    const given = defined(overrides)
    const session = await Session.create({
      model: persisted.model,
      effort: persisted.effort,
      permissionMode:
        persisted.permissionMode === 'full-control' ? undefined : persisted.permissionMode,
      workspaceRoot: persisted.workspaceRoot,
      fullControl: false,
      debug: false,
      ...given,
      sessionId: persisted.id,
    })
    session.#createdAt = persisted.createdAt
    session.runtime.loadState(persisted.messages, persisted.plan, persisted.changedFiles)
    return session
  }

  /** Compact the conversation now (`/compact`). */
  compact(): { didCompact: boolean; beforeTokens: number; afterTokens: number } {
    return this.runtime.compact()
  }

  /** Every provider with its readiness, for `/providers` and `/model`. */
  async describeProviders(refresh = false): Promise<
    Array<{
      id: string
      label: string
      configured: boolean
      ok: boolean
      reason?: string
      models: ModelInfo[]
      active: boolean
    }>
  > {
    if (refresh) await this.router.refreshModels().catch(() => undefined)
    const activeId = this.provider?.id
    return Promise.all(
      this.providers.map(async (p) => {
        const status = await Promise.race([
          p.available().catch((e: unknown) => ({ ok: false, reason: String(e) })),
          new Promise<{ ok: boolean; reason?: string }>((r) =>
            setTimeout(() => r({ ok: false, reason: 'timed out' }), 5000),
          ),
        ])
        return {
          id: p.id,
          label: p.label,
          configured: p.configured?.() ?? status.ok,
          ok: status.ok,
          reason: status.reason,
          models: p.listModels(),
          active: p.id === activeId,
        }
      }),
    )
  }

  /** Release everything that outlives a turn: MCP server processes, background jobs. */
  async close(): Promise<void> {
    this.interrupt()
    killAllBackground()
    await mcpManager.closeAll().catch(() => undefined)
  }

  get model(): string {
    return this.#activeModel
  }

  get effort(): EffortLevel {
    return this.#activeEffort
  }

  get isBusy(): boolean {
    return this.#abort !== null
  }

  get modelLabel(): string {
    return this.router.locate(this.#activeModel)?.info.label ?? this.#activeModel
  }

  get contextWindow(): number {
    return this.router.locate(this.#activeModel)?.info.contextWindow ?? 200_000
  }

  get provider(): ModelProvider | undefined {
    return this.router.locate(this.#activeModel)?.provider
  }

  /**
   * Attach the UI's permission dialog.
   *
   * The engine is built before the React tree exists, so the dialog is wired in
   * afterwards. This is the only place the two halves meet.
   */
  setPrompter(prompter: ((request: PromptRequest) => void) | null): void {
    this.permissions.setPrompter(
      prompter
        ? {
            prompt: (request) =>
              new Promise<PermissionChoice>((resolve) => {
                prompter({ prompt: request, resolve })
              }),
          }
        : undefined,
    )
  }

  /** Swap model. Returns an error string when the spec is not resolvable. */
  setModel(spec: string): { ok: true; label: string; id: string } | { ok: false; reason: string } {
    const info = this.router.resolveModel(spec)
    if (!info) {
      const known = this.router.listModels().map((m) => m.id)
      return {
        ok: false,
        reason: `Unknown model "${spec}". Known: ${known.slice(0, 8).join(', ')}${known.length > 8 ? ', …' : ''}. Use provider:model for anything not listed.`,
      }
    }
    this.#activeModel = info.id
    this.runtime.setModel(info.id)
    return { ok: true, label: info.label, id: info.id }
  }

  setEffort(effort: EffortLevel): void {
    this.#activeEffort = effort
    const profile = effortProfile(effort)
    this.runtime.setEffort(profile)
    this.#syncSubagentTool(profile)
  }

  setPermissionMode(mode: PermissionMode): void {
    this.config.permissionMode = mode
    // The engine is what enforces the mode; the config copy is only for display.
    this.permissions.setMode(mode)
  }

  /** Cancel whatever is running. Safe to call when nothing is. */
  interrupt(): void {
    this.#abort?.abort()
    this.#abort = null
  }

  /** Run one turn, streaming events to the consumer. */
  async *runTurn(input: string): AsyncGenerator<AgentEvent> {
    this.#abort?.abort()
    const controller = new AbortController()
    this.#abort = controller
    // "Allow for this task" lasts until the next thing the user asks for.
    this.permissions.clearGrants()

    // Point the loop at whatever model and effort are current right now.
    this.runtime.setModel(this.#activeModel)
    this.runtime.setEffort(effortProfile(this.#activeEffort))
    try {
      yield* this.runtime.run(input, { signal: controller.signal })
    } finally {
      this.#abort = null
      void sessionPersistence.save({
        id: this.runtime.sessionId,
        version: 1,
        createdAt: this.#createdAt,
        updatedAt: Date.now(),
        workspaceRoot: this.config.workspaceRoot,
        model: this.#activeModel,
        effort: this.#activeEffort,
        permissionMode: this.config.permissionMode,
        messages: [...this.runtime.messages],
        plan: [...this.runtime.plan],
        changedFiles: [...this.runtime.changedFiles],
      })
    }
  }

  // --- helpers used by the TUI ---------------------------------------------

  async gitStatus(): Promise<{ files: number; insertions: number; deletions: number } | null> {
    try {
      const { stdout } = await execa('git', ['diff', '--numstat'], {
        cwd: this.config.workspaceRoot,
        reject: false,
      })
      let files = 0
      let insertions = 0
      let deletions = 0
      for (const line of stdout.split('\n')) {
        if (!line.trim()) continue
        const [add, del] = line.split('\t')
        files++
        insertions += Number(add) || 0
        deletions += Number(del) || 0
      }
      return { files, insertions, deletions }
    } catch {
      return null
    }
  }
}

function credentialHint(providerId: string): string {
  switch (providerId) {
    case 'anthropic':
      return 'Set ANTHROPIC_API_KEY.'
    case 'google':
      return 'Set GEMINI_API_KEY (a Google AI Studio key).'
    case 'openai':
      return 'Set OPENAI_API_KEY.'
    default:
      return `Set the key for "${providerId}" (apiKeyEnv in your config).`
  }
}

function sandboxNetwork(sandbox: ResolvedConfig['value']['sandbox']): NetworkPolicy {
  const mode = sandbox?.network ?? 'disabled'
  if (mode === 'disabled') return { mode: 'disabled' }
  return { mode, allowHosts: sandbox?.allowedHosts ?? [], denyHosts: sandbox?.deniedHosts ?? [] }
}

function buildNotices(config: ResolvedSessionConfig, sandbox: Sandbox): string[] {
  const notices: string[] = []
  if (config.fullControl) {
    notices.push(
      'FULL CONTROL is enabled: commands run without permission prompts and without sandbox isolation.',
    )
  }
  if (!sandbox.info.isolated) {
    notices.push(
      `No sandbox is active on this system (${sandbox.info.detail}). Permission prompts still apply, but commands are not isolated.`,
    )
  }
  return notices
}

async function currentBranch(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      reject: false,
      timeout: 3000,
    })
    const branch = stdout.trim()
    return branch && branch !== 'HEAD' ? branch : undefined
  } catch {
    return undefined
  }
}

function sessionId(): string {
  return `s_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
}
