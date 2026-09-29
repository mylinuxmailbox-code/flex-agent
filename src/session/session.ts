import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { execa } from 'execa'
import type { AgentEvent } from '../agent/events.js'
import { SubagentRunner } from '../agent/orchestrator/runner.js'
import { AgentRuntime } from '../agent/runtime/loop.js'
import { loadCredentials } from '../config/credentials.js'
import { loadConfig, type ResolvedConfig } from '../config/index.js'
import { readProjectInstructions, summariseRepository } from '../context/repo.js'
import { mcpManager } from '../mcp/registry.js'
import type { ModelProvider } from '../models/provider.js'
import { createModelProviders, normalizeProviderId, resolveProvider } from '../models/registry.js'
import { type EffortLevel, effortProfile } from '../models/types.js'
import { createLogger, defaultLogDir, type Logger, nullLogger } from '../observability/logger.js'
import { RiskClassifier } from '../permissions/classifier.js'
import { PermissionEngine } from '../permissions/policy.js'
import type { PermissionChoice, PermissionMode, PermissionPrompt } from '../permissions/types.js'
import { pluginManager } from '../plugins/manager.js'
import { createSandbox, flexDirs } from '../sandbox/index.js'
import type { Sandbox } from '../sandbox/types.js'
import { registerBuiltinTools } from '../tools/index.js'
import { ToolRegistry } from '../tools/registry.js'
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
  model: string
  effort: EffortLevel
  permissionMode: PermissionMode
  workspaceRoot: string
  /** `--full-control` disables prompts and the sandbox. */
  fullControl: boolean
  /** Disable only isolation while retaining the permission engine. */
  noSandbox?: boolean
  debug: boolean
  providerId?: string
  baseURL?: string
  apiKey?: string
  sessionId?: string
}

export interface PromptRequest {
  prompt: PermissionPrompt
  resolve: (choice: PermissionChoice) => void
}

export class Session {
  readonly config: SessionConfig
  readonly logger: Logger
  readonly sandbox: Sandbox
  readonly tools: ToolRegistry
  readonly permissions: PermissionEngine
  readonly runtime: AgentRuntime
  readonly providers: ModelProvider[]

  #abort: AbortController | null = null
  #activeProvider: ModelProvider
  #subagentRunner: SubagentRunner | null = null
  #activeModel: string
  #activeEffort: EffortLevel
  #createdAt: number = Date.now()

  private constructor(init: {
    config: SessionConfig
    logger: Logger
    sandbox: Sandbox
    tools: ToolRegistry
    permissions: PermissionEngine
    runtime: AgentRuntime
    providers: ModelProvider[]
    subagentRunner?: SubagentRunner | null
  }) {
    this.config = init.config
    this.logger = init.logger
    this.sandbox = init.sandbox
    this.tools = init.tools
    this.permissions = init.permissions
    this.runtime = init.runtime
    this.providers = init.providers
    this.#activeProvider = init.runtime.provider
    this.#subagentRunner = init.subagentRunner ?? null
    this.#activeModel = init.config.model
    this.#activeEffort = init.config.effort
  }

  static async create(config: SessionConfig): Promise<Session> {
    const dirs = flexDirs()
    mkdirSync(join(dirs.stateDir, 'sessions'), { recursive: true, mode: 0o700 })

    const logger = config.debug
      ? createLogger({ level: 'debug', dir: defaultLogDir(), stderr: true, sessionId: sessionId() })
      : createLogger({ level: 'info', dir: defaultLogDir() })

    const workspaceRoot = resolve(config.workspaceRoot)

    // Resolve configuration before constructing security-sensitive resources.
    // The previous order silently ignored project sandbox/network settings.
    const requestedProvider = normalizeProviderId(config.providerId)
    const resolved = loadConfig({
      workspaceRoot,
      session: {
        ...(config.model ? { model: config.model } : {}),
        ...(requestedProvider ? { provider: requestedProvider } : {}),
        effort: config.effort,
        permissions: { mode: config.permissionMode },
        ...(config.fullControl || config.noSandbox ? { sandbox: { enabled: false } } : {}),
      },
    })
    const effectiveEffort = resolved.value.effort ?? config.effort
    const effectiveProviderId = resolved.value.provider ?? config.providerId
    const effectiveModel = selectInitialModel(
      resolved.value.model,
      resolved.provenance.model,
      config.model,
      effectiveProviderId,
      resolved.value.providers,
    )
    const effectivePermissionMode = config.fullControl
      ? 'full-control'
      : (resolved.value.permissions?.mode ?? config.permissionMode)
    const effectiveConfig: SessionConfig = {
      ...config,
      model: effectiveModel,
      effort: effectiveEffort,
      permissionMode: effectivePermissionMode,
      workspaceRoot,
      fullControl: config.fullControl || effectivePermissionMode === 'full-control',
    }

    const { sandbox, reason } = await createSandbox({
      workspaceRoot,
      disabled:
        effectiveConfig.fullControl ||
        config.noSandbox ||
        resolved.value.sandbox?.enabled === false,
      network: {
        mode: resolved.value.sandbox?.network ?? 'disabled',
        allowHosts: resolved.value.sandbox?.allowedHosts,
        denyHosts: resolved.value.sandbox?.deniedHosts,
      },
      ...(resolved.value.sandbox?.limits
        ? { limits: definedLimits(resolved.value.sandbox.limits) }
        : {}),
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
    const providers = buildProviders(effectiveConfig, resolved, effectiveModel, effectiveProviderId)
    const selected = resolveProvider(providers, effectiveModel, effectiveProviderId)
    if (!selected) {
      throw new Error(
        `No provider can resolve model "${effectiveModel}". Configure a provider or choose another model.`,
      )
    }
    const provider = selected.provider

    const classifier = new RiskClassifier({
      workspaceRoot,
      tempDir: join(dirs.cacheDir, 'tmp'),
      cacheDir: dirs.cacheDir,
    })

    // The prompter is attached later by the UI; until then the engine fails
    // closed on anything risky, which is the safe default.
    const permissions = new PermissionEngine({
      mode: effectivePermissionMode,
      classifier,
      autoThreshold: (resolved.value.permissions?.autoThreshold as 'low') ?? 'low',
      askThreshold: 'low',
      onDecision: (result, action) => {
        logger.info('permission decision', {
          tool: action.tool,
          outcome: result.decision.outcome,
          level: result.risk.level,
          source: result.source,
        })
      },
    })

    const id = effectiveConfig.sessionId ?? sessionId()

    // Subagent delegation is only advertised when the effort profile actually
    // fans out; in single-agent modes the model never sees the option at all.
    let subagentRunner: SubagentRunner | null = null
    if (profile.subagents) {
      const mutatingTools = tools
        .visible()
        .filter((t) => !t.readOnly)
        .map((t) => t.name)
      subagentRunner = new SubagentRunner({
        provider,
        tools,
        permissions,
        sandbox,
        logger,
        workspaceRoot,
        model: effectiveModel,
        effort: profile,
        sessionId: id,
        mutatingTools,
      })
      tools.register(createSpawnSubagentTool(subagentRunner, profile.maxSubagents))
      logger.info('subagent orchestration enabled', {
        main: profile.main,
        subagents: profile.subagents,
        max: profile.maxSubagents,
      })
    }

    // External capability sources come last so their tools are registered after
    // the built-ins, and so a failure in any of them cannot stop the session.
    try {
      const mcpConfigs = await mcpManager.loadConfigs(workspaceRoot)
      if (mcpConfigs.length > 0) {
        const result = await mcpManager.registerServers(mcpConfigs, tools)
        logger.info('mcp servers connected', {
          connected: result.connected,
          failed: result.failed,
        })
      }
    } catch (err) {
      logger.warn('mcp registration failed', { error: String(err) })
    }

    try {
      await pluginManager.loadAll(workspaceRoot, tools)
    } catch (err) {
      logger.warn('plugin loading failed', { error: String(err) })
    }

    const [repoSummary, projectInstructions, gitBranch] = await Promise.all([
      summariseRepository(workspaceRoot),
      readProjectInstructions(workspaceRoot),
      currentBranch(workspaceRoot),
    ])

    const runtime = new AgentRuntime({
      provider,
      tools,
      permissions,
      sandbox,
      logger,
      model: effectiveModel,
      effort: profile,
      sessionId: id,
      promptContext: {
        workspaceRoot,
        repoSummary,
        projectInstructions,
        notices: buildNotices(effectiveConfig, sandbox),
        platform: `${process.platform} ${process.arch}`,
        today: new Date().toISOString().slice(0, 10),
        gitBranch,
        sandboxNote: sandbox.info.isolated
          ? `${sandbox.info.backend} (${sandbox.info.detail})`
          : `UNSANDBOXED — ${sandbox.info.detail}`,
      },
    })

    return new Session({
      config: effectiveConfig,
      logger,
      sandbox,
      tools,
      permissions,
      providers,
      runtime,
      subagentRunner,
    })
  }

  static async resume(
    persisted: PersistedSession,
    overrides?: Partial<SessionConfig>,
  ): Promise<Session> {
    const session = await Session.create({
      model: overrides?.model ?? persisted.model,
      effort: overrides?.effort ?? persisted.effort,
      permissionMode: overrides?.permissionMode ?? persisted.permissionMode,
      workspaceRoot: overrides?.workspaceRoot ?? persisted.workspaceRoot,
      fullControl: overrides?.fullControl ?? persisted.permissionMode === 'full-control',
      debug: overrides?.debug ?? false,
      sessionId: persisted.id,
      ...overrides,
    })
    session.#createdAt = persisted.createdAt
    session.runtime.loadState(persisted.messages, persisted.plan, persisted.changedFiles)
    return session
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
    const provider = this.resolveProvider(this.#activeModel)
    return provider?.resolveModel(this.#activeModel)?.label ?? this.#activeModel
  }

  get contextWindow(): number {
    const provider = this.resolveProvider(this.#activeModel)
    return provider?.resolveModel(this.#activeModel)?.contextWindow ?? 200_000
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

  /** Swap model/provider. Returns an error string when the spec is not resolvable. */
  setModel(spec: string): { ok: true; label: string } | { ok: false; reason: string } {
    const selected = resolveProvider(this.providers, spec, this.config.providerId)
    if (selected) {
      const info = selected.provider.resolveModel(selected.model)
      if (info) {
        this.#activeProvider = selected.provider
        this.#activeModel = info.id
        this.runtime.setProvider(selected.provider)
        this.runtime.setModel(info.id)
        this.#subagentRunner?.setProvider(selected.provider, info.id)
        return { ok: true, label: info.label }
      }
    }
    const known = this.providers.flatMap((p) => p.listModels().map((m) => `${p.id}:${m.id}`))
    return { ok: false, reason: `Unknown model "${spec}". Known: ${known.slice(0, 8).join(', ')}…` }
  }

  setEffort(effort: EffortLevel): void {
    this.#activeEffort = effort
    const profile = effortProfile(effort)
    this.runtime.setEffort(profile)

    if (profile.subagents && !this.#subagentRunner) {
      const runner = new SubagentRunner({
        provider: this.#activeProvider,
        tools: this.tools,
        permissions: this.permissions,
        sandbox: this.sandbox,
        logger: this.logger,
        workspaceRoot: this.config.workspaceRoot,
        model: this.#activeModel,
        effort: profile,
        sessionId: this.runtime.sessionId,
        mutatingTools: this.tools
          .visible()
          .filter((tool) => !tool.readOnly)
          .map((tool) => tool.name),
      })
      this.tools.register(createSpawnSubagentTool(runner, profile.maxSubagents))
      this.#subagentRunner = runner
    } else if (profile.subagents && this.#subagentRunner) {
      this.#subagentRunner.setEffort(profile)
    } else if (!profile.subagents && this.#subagentRunner) {
      this.tools.unregister('spawn_subagent')
      this.#subagentRunner = null
    }
  }

  setPermissionMode(mode: PermissionMode): void {
    this.config.permissionMode = mode
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

    // Point the loop at whatever provider, model and effort are current right now.
    this.runtime.setProvider(this.#activeProvider)
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

  private resolveProvider(model: string): ModelProvider | undefined {
    return (
      resolveProvider(this.providers, model, this.config.providerId)?.provider ??
      this.#activeProvider
    )
  }
}

function selectInitialModel(
  configuredModel: string | undefined,
  modelLayer: ResolvedConfig['provenance']['model'],
  sessionModel: string,
  providerId?: string,
  configuredProviders?: ResolvedConfig['value']['providers'],
): string {
  if (sessionModel || (configuredModel && modelLayer !== 'defaults')) {
    return configuredModel ?? sessionModel
  }

  switch (normalizeProviderId(providerId)) {
    case 'openai-compatible':
      return 'gpt-4o'
    case 'google':
      return 'gemini-2.5-flash'
    case 'anthropic':
      return 'claude-opus-5-5'
    default: {
      const hasGoogle =
        configuredProviders?.google?.apiKey ||
        configuredProviders?.google?.baseURL ||
        process.env.FLEX_GOOGLE_BASE_URL ||
        process.env.FLEX_GOOGLE_API_KEY ||
        process.env.FLEX_GEMINI_API_KEY ||
        process.env.GEMINI_API_KEY ||
        process.env.GOOGLE_API_KEY ||
        process.env.GOOGLE_AI_API_KEY ||
        process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
        process.env.GOOGLE_AI_STUDIO_API_KEY
      const hasOpenAI =
        configuredProviders?.openai?.apiKey ||
        configuredProviders?.openai?.baseURL ||
        process.env.FLEX_OPENAI_BASE_URL ||
        process.env.FLEX_OPENAI_API_KEY ||
        process.env.OPENAI_API_KEY ||
        process.env.DEEPSEEK_API_KEY ||
        process.env.MISTRAL_API_KEY ||
        process.env.GROQ_API_KEY ||
        process.env.TOGETHER_API_KEY ||
        process.env.FIREWORKS_API_KEY ||
        process.env.OPENROUTER_API_KEY
      const hasAnthropic =
        configuredProviders?.anthropic?.apiKey ||
        configuredProviders?.anthropic?.authToken ||
        configuredProviders?.anthropic?.baseURL ||
        process.env.ANTHROPIC_API_KEY ||
        process.env.ANTHROPIC_AUTH_TOKEN ||
        process.env.ANTHROPIC_BASE_URL
      if (hasGoogle && !hasAnthropic && !hasOpenAI) return 'gemini-2.5-flash'
      if (hasOpenAI && !hasAnthropic) {
        return 'gpt-4o'
      }
      return configuredModel ?? 'claude-opus-5-5'
    }
  }
}

function buildProviders(
  config: SessionConfig,
  resolved: ResolvedConfig,
  model: string,
  providerId?: string,
): ModelProvider[] {
  const configured = resolved.value.providers
  const stored = loadCredentials()
  const preferred = normalizeProviderId(providerId)
  const genericKey = config.apiKey
  const genericBaseURL = config.baseURL
  const env = process.env

  return createModelProviders({
    providerId,
    model,
    anthropic: {
      ...configured?.anthropic,
      ...(preferred === 'anthropic' || !preferred
        ? {
            apiKey: genericKey ?? configured?.anthropic?.apiKey,
            baseURL: genericBaseURL ?? configured?.anthropic?.baseURL,
          }
        : {}),
      apiKey:
        env.ANTHROPIC_API_KEY ??
        stored.anthropic?.apiKey ??
        genericKey ??
        configured?.anthropic?.apiKey,
      baseURL:
        env.ANTHROPIC_BASE_URL ??
        (preferred === 'anthropic' || !preferred ? genericBaseURL : undefined) ??
        configured?.anthropic?.baseURL,
      authToken:
        env.ANTHROPIC_AUTH_TOKEN ?? stored.anthropic?.authToken ?? configured?.anthropic?.authToken,
    },
    openai: {
      ...configured?.openai,
      label: configured?.openai?.label,
      apiKey:
        env.FLEX_OPENAI_API_KEY ??
        env.OPENAI_API_KEY ??
        env.DEEPSEEK_API_KEY ??
        env.MISTRAL_API_KEY ??
        env.GROQ_API_KEY ??
        env.TOGETHER_API_KEY ??
        env.FIREWORKS_API_KEY ??
        env.OPENROUTER_API_KEY ??
        (preferred === 'openai-compatible' ? genericKey : undefined) ??
        stored.openai?.apiKey ??
        configured?.openai?.apiKey,
      baseURL:
        env.FLEX_OPENAI_BASE_URL ??
        env.OPENAI_BASE_URL ??
        (preferred === 'openai-compatible' ? genericBaseURL : undefined) ??
        configured?.openai?.baseURL,
    },
    google: {
      ...configured?.google,
      apiKey:
        env.FLEX_GOOGLE_API_KEY ??
        env.FLEX_GEMINI_API_KEY ??
        env.GEMINI_API_KEY ??
        env.GOOGLE_API_KEY ??
        env.GOOGLE_AI_API_KEY ??
        (preferred === 'google' ? genericKey : undefined) ??
        stored.google?.apiKey ??
        configured?.google?.apiKey,
      baseURL:
        env.FLEX_GOOGLE_BASE_URL ??
        env.GOOGLE_AI_BASE_URL ??
        env.GEMINI_BASE_URL ??
        (preferred === 'google' ? genericBaseURL : undefined) ??
        configured?.google?.baseURL,
    },
  })
}

function definedLimits(limits: { memoryMb?: number; outputBytes?: number; wallClockMs?: number }): {
  memoryMb?: number
  outputBytes?: number
  wallClockMs?: number
} {
  return Object.fromEntries(Object.entries(limits).filter(([, value]) => value !== undefined)) as {
    memoryMb?: number
    outputBytes?: number
    wallClockMs?: number
  }
}

function buildNotices(config: SessionConfig, sandbox: Sandbox): string[] {
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

export { basename, homedir, nullLogger }
