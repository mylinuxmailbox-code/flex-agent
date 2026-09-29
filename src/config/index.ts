import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { flexDirs } from '../sandbox/index.js'

/**
 * Configuration.
 *
 * Five layers, each overriding the one before it:
 *
 *   defaults → global (~/.flex/config.json) → project (.flex/config.json)
 *            → session (CLI flags + /commands) → explicit user request
 *
 * Later layers win per-key rather than wholesale, so a project that only sets
 * `sandbox.network` does not wipe out the user's model preference.
 */

export const effortSchema = z.enum([
  'low',
  'medium',
  'high',
  'xhigh',
  'pro',
  'max',
  'ultracode',
  'maxcode',
])

export const permissionModeSchema = z.enum(['ask', 'auto', 'full-control'])
export const networkModeSchema = z.enum(['disabled', 'restricted', 'allowed'])

export const providerTypeSchema = z.enum(['anthropic', 'openai-compatible', 'google'])

const modelOverrideSchema = z.object({
  id: z.string(),
  label: z.string().optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  supportsTools: z.boolean().optional(),
  supportsThinking: z.boolean().optional(),
  supportsEffort: z.boolean().optional(),
})

/**
 * One model provider.
 *
 * The key under `providers` is the provider's name and doubles as the
 * `provider:model` prefix. `anthropic`, `google` and `openai` are recognised
 * built-ins and need no `type`; any other name is an OpenAI-compatible endpoint
 * unless `type` says otherwise.
 */
export const providerConfigSchema = z.object({
  type: providerTypeSchema.optional(),
  label: z.string().optional(),
  enabled: z.boolean().optional(),
  baseURL: z.string().optional(),
  /** Literal key. Prefer `apiKeyEnv`; the config file is created mode 0600. */
  apiKey: z.string().optional(),
  /** Name of the environment variable holding the key. */
  apiKeyEnv: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  defaultModel: z.string().optional(),
  models: z.array(z.union([z.string(), modelOverrideSchema])).optional(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  /** OpenAI-compatible only: which token-limit parameter the server understands. */
  maxTokensParam: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
  /** OpenAI-compatible only: send `reasoning_effort`. Default: by model name. */
  reasoningEffort: z.boolean().optional(),
})

export type ProviderConfig = z.infer<typeof providerConfigSchema>

/** Every value is optional; a partial config is valid and normal. */
export const flexConfigSchema = z.object({
  model: z.string().optional(),
  providers: z.record(z.string(), providerConfigSchema).optional(),
  effort: effortSchema.optional(),
  permissions: z
    .object({
      mode: permissionModeSchema.optional(),
      /** Anything at or below this level proceeds without asking. */
      autoThreshold: z.enum(['safe', 'low', 'medium', 'high', 'critical']).optional(),
      /** Signals that are never auto-approved, whatever the threshold. */
      neverAuto: z.array(z.string()).optional(),
    })
    .optional(),

  sandbox: z
    .object({
      enabled: z.boolean().optional(),
      network: networkModeSchema.optional(),
      allowedHosts: z.array(z.string()).optional(),
      deniedHosts: z.array(z.string()).optional(),
      limits: z
        .object({
          memoryMb: z.number().optional(),
          outputBytes: z.number().optional(),
          wallClockMs: z.number().optional(),
        })
        .optional(),
    })
    .optional(),

  web: z
    .object({
      provider: z
        .enum(['auto', 'anthropic', 'brave', 'exa', 'tavily', 'duckduckgo', 'none'])
        .optional(),
      apiKey: z.string().optional(),
      maxResults: z.number().int().min(1).max(50).optional(),
      allowedDomains: z.array(z.string()).optional(),
      blockedDomains: z.array(z.string()).optional(),
    })
    .optional(),

  mcp: z
    .object({
      /** Server name → stdio command. */
      servers: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
      enabled: z.array(z.string()).optional(),
      disabled: z.array(z.string()).optional(),
    })
    .optional(),

  plugins: z
    .object({
      enabled: z.array(z.string()).optional(),
      disabled: z.array(z.string()).optional(),
      /** Extra directories searched for plugins. */
      paths: z.array(z.string()).optional(),
    })
    .optional(),

  ui: z
    .object({
      theme: z.string().optional(),
      maxFps: z.number().int().min(1).max(60).optional(),
      showThinking: z.boolean().optional(),
    })
    .optional(),
})

export type FlexConfig = z.infer<typeof flexConfigSchema>

export type ConfigLayer = 'defaults' | 'global' | 'project' | 'session'

export interface ResolvedConfig {
  /** The merged result. */
  readonly value: FlexConfig
  /** Which layer last set each top-level key — shown by `/config`. */
  readonly provenance: Record<keyof FlexConfig, ConfigLayer | undefined>
}

const DEFAULTS: FlexConfig = {
  model: 'claude-opus-5-5',
  effort: 'high',
  permissions: { mode: 'ask', autoThreshold: 'low' },
  sandbox: { enabled: true, network: 'disabled' },
  web: { provider: 'auto', maxResults: 10 },
  mcp: { servers: {}, enabled: [], disabled: [] },
  plugins: { enabled: [], disabled: [], paths: [] },
  ui: { maxFps: 30, showThinking: false },
}

export function globalConfigPath(): string {
  return join(flexDirs().configDir, 'config.json')
}

export function projectConfigPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.flex', 'config.json')
}

function readJson(path: string): FlexConfig | null {
  try {
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    const result = flexConfigSchema.safeParse(parsed)
    if (result.success) return result.data
    // A malformed config must not stop Flex from starting; it is reported and
    // the previous layer is used instead.
    process.stderr.write(
      `flex: ignoring invalid config at ${path}: ${result.error.issues[0]?.message ?? 'invalid'}\n`,
    )
    return null
  } catch (err) {
    process.stderr.write(
      `flex: could not read config at ${path}: ${err instanceof Error ? err.message : String(err)}\n`,
    )
    return null
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function mergeValue(base: unknown, overlay: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(overlay)) {
    const out: Record<string, unknown> = { ...base }
    for (const [key, value] of Object.entries(overlay)) {
      if (value === undefined) continue
      out[key] = mergeValue(base[key], value)
    }
    return out
  }
  // Arrays and scalars are replaced, not concatenated: a project that lists
  // `plugins.disabled` means exactly that list.
  return overlay
}

/** Deep-merge plain objects; later layers win per key. */
export function merge(base: FlexConfig, overlay: FlexConfig): FlexConfig {
  return mergeValue(base, overlay) as FlexConfig
}

/**
 * A repository controls its own `.flex/config.json`, and a repository you just
 * cloned is not trusted. Anything that could redirect a credential or run a
 * program is therefore ignored at the project layer and reported once:
 * provider endpoints and keys, and MCP server definitions. Per-user config is
 * where those belong.
 */
export function sanitizeProjectConfig(config: FlexConfig, source = 'project config'): FlexConfig {
  const ignored: string[] = []
  const out: FlexConfig = { ...config }

  if (config.providers) {
    const providers: NonNullable<FlexConfig['providers']> = {}
    for (const [name, spec] of Object.entries(config.providers)) {
      const { baseURL, apiKey, apiKeyEnv, headers, ...safe } = spec
      if (baseURL || apiKey || apiKeyEnv || headers)
        ignored.push(`providers.${name}.{baseURL,apiKey,apiKeyEnv,headers}`)
      providers[name] = safe
    }
    out.providers = providers
  }
  if (config.mcp?.servers && Object.keys(config.mcp.servers).length > 0) {
    ignored.push('mcp.servers')
    out.mcp = { ...config.mcp, servers: undefined }
  }
  if (config.web?.apiKey) {
    ignored.push('web.apiKey')
    out.web = { ...config.web, apiKey: undefined }
  }
  if (ignored.length > 0) {
    process.stderr.write(
      `flex: ${source} may not set ${ignored.join(', ')} (a repository cannot redirect credentials or start programs). Put them in your user config.\n`,
    )
  }
  return out
}

export function loadConfig(options: {
  workspaceRoot: string
  /** Overrides from CLI flags. Highest precedence. */
  session?: FlexConfig
}): ResolvedConfig {
  const provenance = {} as Record<keyof FlexConfig, ConfigLayer | undefined>
  let value: FlexConfig = structuredClone(DEFAULTS)
  for (const key of Object.keys(DEFAULTS) as (keyof FlexConfig)[]) provenance[key] = 'defaults'

  const global = readJson(globalConfigPath())
  if (global) {
    value = merge(value, global)
    for (const key of Object.keys(global) as (keyof FlexConfig)[]) {
      if (global[key] !== undefined) provenance[key] = 'global'
    }
  }

  const rawProject = readJson(projectConfigPath(options.workspaceRoot))
  const project = rawProject ? sanitizeProjectConfig(rawProject) : null
  if (project) {
    value = merge(value, project)
    for (const key of Object.keys(project) as (keyof FlexConfig)[]) {
      if (project[key] !== undefined) provenance[key] = 'project'
    }
  }

  if (options.session) {
    value = merge(value, options.session)
    for (const key of Object.keys(options.session) as (keyof FlexConfig)[]) {
      if (options.session[key] !== undefined) provenance[key] = 'session'
    }
  }

  return { value, provenance }
}

export function saveGlobalConfig(patch: FlexConfig): void {
  const path = globalConfigPath()
  const current = readJson(path) ?? {}
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(merge(current, patch), null, 2)}\n`, { mode: 0o600 })
}

export function saveProjectConfig(workspaceRoot: string, patch: FlexConfig): void {
  const path = projectConfigPath(resolve(workspaceRoot))
  const current = readJson(path) ?? {}
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(merge(current, patch), null, 2)}\n`, { mode: 0o600 })
}

/** `FLEX_HOME` lets tests and sandboxes relocate all Flex state. */
export function configHome(): string {
  return process.env.FLEX_HOME ?? join(homedir(), '.flex')
}

/** Human-readable dump of the effective config with the layer each key came from. */
export function describeConfig(resolved: ResolvedConfig): string {
  const redact = (key: string, value: unknown): unknown =>
    /key|token|secret|authorization/i.test(key) && typeof value === 'string' && value
      ? '***'
      : value
  const lines: string[] = []
  for (const [key, value] of Object.entries(resolved.value)) {
    const layer = resolved.provenance[key as keyof FlexConfig] ?? 'defaults'
    lines.push(`${key}  [${layer}]`)
    lines.push(
      ...JSON.stringify(value, redact, 2)
        .split('\n')
        .map((l) => `  ${l}`),
    )
  }
  return lines.join('\n')
}
