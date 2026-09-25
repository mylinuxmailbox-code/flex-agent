import type { Logger } from '../observability/logger.js'

/**
 * What the agent can reach, and with what limits.
 *
 * A policy is data. Backends consume it; none of them interpret it differently.
 */
export interface SandboxPolicy {
  /** Directories readable without a separate grant. */
  readonly readRoots: readonly string[]
  /** Directories writable without a separate grant. */
  readonly writeRoots: readonly string[]
  /** Never readable, regardless of grants. */
  readonly denyPaths: readonly string[]
  /** Never writable, regardless of grants. */
  readonly denyWritePaths: readonly string[]
  readonly network: NetworkPolicy
  readonly limits: ResourceLimits
}

export type NetworkMode = 'disabled' | 'restricted' | 'allowed'

export interface NetworkPolicy {
  readonly mode: NetworkMode
  /** When restricted/allowed: hostnames or `*.suffix` patterns. */
  readonly allowHosts?: readonly string[]
  readonly denyHosts?: readonly string[]
}

export interface ResourceLimits {
  readonly cpuSeconds?: number
  readonly memoryMb?: number
  readonly processCount?: number
  readonly fileSizeMb?: number
  readonly outputBytes: number
  readonly wallClockMs: number
}

export const DEFAULT_LIMITS: ResourceLimits = {
  outputBytes: 256 * 1024,
  wallClockMs: 120_000,
  processCount: 256,
  memoryMb: 4096,
}

/** Paths that stay off-limits even inside a workspace-rooted sandbox. */
export const DEFAULT_DENY_PATHS: readonly string[] = [
  '~/.ssh',
  '~/.aws',
  '~/.config/gcloud',
  '~/.config/gh',
  '~/.azure',
  '~/.kube',
  '~/.gnupg',
  '~/.docker/config.json',
  '~/.netrc',
  '~/.npmrc',
  '~/.pypirc',
  '~/.password-store',
  '/etc/shadow',
  '/etc/gshadow',
  '/etc/sudoers',
  '~/.claude.json',
  '~/.claude/.credentials.json',
  '~/.config/flex/credentials.json',
]

export type SandboxStatus =
  /** Commands run with no isolation. Must be surfaced in the UI. */
  | 'unavailable'
  /** Isolation is active. */
  | 'active'
  /** A backend exists but refused to initialize; `detail` says why. */
  | 'degraded'

export interface SandboxInfo {
  readonly backend: string
  readonly status: SandboxStatus
  /** True when `status !== 'active'` — the UI must warn. */
  readonly isolated: boolean
  readonly detail: string
  /** The actual argv template used, for the debug view. */
  readonly command?: readonly string[]
}

export interface ExecSpec {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly stdin?: string
  /** Strip the sandbox wrapper and run on the host directly. Only full-control does this. */
  readonly bypass?: boolean
}

export interface ExecHandle {
  readonly pid?: number
  readonly exitCode: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
  readonly durationMs: number
  readonly timedOut: boolean
}

export interface Sandbox {
  readonly info: SandboxInfo
  readonly policy: SandboxPolicy
  /** Run a command under the active policy. */
  exec(
    spec: ExecSpec,
    onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void,
  ): Promise<ExecHandle>
  /** Check a path against the policy without running anything. */
  canRead(path: string): boolean
  canWrite(path: string): boolean
  /** Roots a tool may resolve paths into without an extra grant. */
  writableRoots(): readonly string[]
  /** Full argv including the wrapper, for the permission prompt preview. */
  describe(spec: ExecSpec): { argv: string[]; wrapped: boolean }
}

export interface SandboxBackend {
  readonly name: string
  /** Can this backend actually isolate on this machine right now? */
  probe(): Promise<{ usable: boolean; detail: string }>
  create(policy: SandboxPolicy, logger: Logger): Promise<Sandbox>
}

/** Resolve `~` and relative segments; expand without touching the filesystem. */
export function expandPath(path: string, home = process.env.HOME ?? ''): string {
  if (path.startsWith('~/')) return `${home}/${path.slice(2)}`
  if (path === '~') return home
  return path
}
