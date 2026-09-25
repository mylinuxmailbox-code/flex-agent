import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { execa } from 'execa'
import type { AgentEvent } from '../agent/events.js'
import { SubagentRunner } from '../agent/orchestrator/runner.js'
import { AgentRuntime } from '../agent/runtime/loop.js'
import { loadConfig } from '../config/index.js'
import { readProjectInstructions, summariseRepository } from '../context/repo.js'
import { mcpManager } from '../mcp/registry.js'
import { AnthropicProvider } from '../models/anthropic.js'
import { OpenAICompatibleProvider } from '../models/openai-compatible.js'
import type { ModelProvider } from '../models/provider.js'
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
  /** `--full-control` also disables the sandbox. */
  fullControl: boolean
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
  }) {
    this.config = init.config
    this.logger = init.logger
    this.sandbox = init.sandbox
    this.tools = init.tools
    this.permissions = init.permissions
    this.runtime = init.runtime
    this.providers = init.providers
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

    const { sandbox, reason } = await createSandbox({
      workspaceRoot,
      disabled: config.fullControl,
      network: { mode: 'disabled' },
      logger,
    })
    logger.info('sandbox ready', {
      backend: sandbox.info.backend,
      isolated: sandbox.info.isolated,
      reason,
    })

    // Config first: it decides the model, effort, sandbox posture and network
    // policy that everything below is built from.
    const resolved = loadConfig({
      workspaceRoot,
      session: {
        model: config.model,
        effort: config.effort,
        permissions: { mode: config.permissionMode },
        ...(config.fullControl ? { sandbox: { enabled: false } } : {}),
      },
    })
    const effectiveEffort = resolved.value.effort ?? config.effort
    const effectiveModel = resolved.value.model ?? config.model

    const tools = new ToolRegistry()
    registerBuiltinTools(tools)

    const profile = effortProfile(effectiveEffort)
    const providers = buildProviders(config)
    const provider =
      providers.find((p) => p.resolveModel(effectiveModel)) ?? (providers[0] as ModelProvider)

    const classifier = new RiskClassifier({
      workspaceRoot,
      tempDir: join(dirs.cacheDir, 'tmp'),
      cacheDir: dirs.cacheDir,
    })

    // The prompter is attached later by the UI; until then the engine fails
    // closed on anything risky, which is the safe default.
    const permissions = new PermissionEngine({
      mode: config.permissionMode,
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

    const id = config.sessionId ?? sessionId()

    // Subagent delegation is only advertised when the effort profile actually
    // fans out; in single-agent modes the model never sees the option at all.
    if (profile.subagents) {
      const mutatingTools = tools
        .visible()
        .filter((t) => !t.readOnly)
        .map((t) => t.name)
      const runner = new SubagentRunner({
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
      tools.register(createSpawnSubagentTool(runner, profile.maxSubagents))
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
        notices: buildNotices(config, sandbox),
        platform: `${process.platform} ${process.arch}`,
        today: new Date().toISOString().slice(0, 10),
        gitBranch,
        sandboxNote: sandbox.info.isolated
          ? `${sandbox.info.backend} (${sandbox.info.detail})`
          : `UNSANDBOXED — ${sandbox.info.detail}`,
      },
    })

    return new Session({ config, logger, sandbox, tools, permissions, providers, runtime })
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

  /** Swap model. Returns an error string when the spec is not resolvable. */
  setModel(spec: string): { ok: true; label: string } | { ok: false; reason: string } {
    for (const provider of this.providers) {
      const info = provider.resolveModel(spec)
      if (!info) continue
      this.#activeModel = info.id
      this.runtime.setModel(info.id)
      return { ok: true, label: info.label }
    }
    const known = this.providers.flatMap((p) => p.listModels().map((m) => m.id))
    return { ok: false, reason: `Unknown model "${spec}". Known: ${known.slice(0, 8).join(', ')}…` }
  }

  setEffort(effort: EffortLevel): void {
    this.#activeEffort = effort
    this.runtime.setEffort(effortProfile(effort))
  }

  setPermissionMode(mode: PermissionMode): void {
    this.config.permissionMode = mode
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

  private resolveProvider(model: string): ModelProvider | undefined {
    for (const provider of this.providers) {
      if (provider.resolveModel(model)) return provider
    }
    return this.providers[0]
  }
}

function buildProviders(config: SessionConfig): ModelProvider[] {
  const providers: ModelProvider[] = [
    new AnthropicProvider({
      apiKey: config.apiKey ?? process.env.ANTHROPIC_API_KEY,
      baseURL: config.baseURL ?? process.env.ANTHROPIC_BASE_URL,
    }),
  ]
  // An OpenAI-compatible endpoint is opt-in via env, so a user with only an
  // Anthropic key never trips over a half-configured DeepSeek/Ollama block.
  const openaiBase = process.env.FLEX_OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL
  const openaiKey = process.env.FLEX_OPENAI_API_KEY ?? process.env.OPENAI_API_KEY
  if (openaiBase) {
    providers.push(
      new OpenAICompatibleProvider({
        baseURL: openaiBase,
        apiKey: openaiKey ?? 'not-needed',
        defaultModel: process.env.FLEX_OPENAI_MODEL,
      }),
    )
  }
  if (config.providerId === 'openai' && providers.length < 2) {
    providers.push(
      new OpenAICompatibleProvider({
        baseURL: openaiBase ?? 'http://127.0.0.1:11434/v1',
        apiKey: openaiKey ?? 'ollama',
        defaultModel: process.env.FLEX_OPENAI_MODEL,
      }),
    )
  }
  return providers
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
