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

/** Every value is optional; a partial config is valid and normal. */
export const flexConfigSchema = z.object({
  model: z.string().optional(),
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
      provider: z.enum(['anthropic', 'brave', 'exa', 'tavily', 'none']).optional(),
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
  web: { provider: 'anthropic', maxResults: 10 },
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

/** Shallow-merge per top-level key; nested objects merge one level deeper. */
function merge(base: FlexConfig, overlay: FlexConfig): FlexConfig {
  const out: FlexConfig = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue
    const k = key as keyof FlexConfig
    const existing = out[k]
    if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value) &&
      typeof existing === 'object' &&
      existing !== null &&
      !Array.isArray(existing)
    ) {
      out[k] = { ...existing, ...value } as never
    } else {
      out[k] = value as never
    }
  }
  return out
}

export function loadConfig(options: {
  workspaceRoot: string
  /** Overrides from CLI flags. Highest precedence. */
  session?: FlexConfig
}): ResolvedConfig {
  const provenance = {} as Record<keyof FlexConfig, ConfigLayer | undefined>
  let value = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS) as (keyof FlexConfig)[]) provenance[key] = 'defaults'

  const global = readJson(globalConfigPath())
  if (global) {
    value = merge(value, global)
    for (const key of Object.keys(global) as (keyof FlexConfig)[]) provenance[key] = 'global'
  }

  const project = readJson(projectConfigPath(options.workspaceRoot))
  if (project) {
    value = merge(value, project)
    for (const key of Object.keys(project) as (keyof FlexConfig)[]) provenance[key] = 'project'
  }

  if (options.session) {
    value = merge(value, options.session)
    for (const key of Object.keys(options.session) as (keyof FlexConfig)[]) {
      provenance[key] = 'session'
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
