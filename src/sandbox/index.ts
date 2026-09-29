import { mkdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Logger } from '../observability/logger.js'
import { flexHome } from '../paths.js'
import { BubblewrapBackend } from './backends/bubblewrap.js'
import { NoSandboxBackend } from './backends/none.js'
import {
  DEFAULT_DENY_PATHS,
  DEFAULT_LIMITS,
  type ResourceLimits,
  type Sandbox,
  type SandboxBackend,
  type SandboxPolicy,
} from './types.js'

export { BubblewrapBackend } from './backends/bubblewrap.js'
export { NoSandboxBackend } from './backends/none.js'
export * from './types.js'

export interface SandboxRequest {
  workspaceRoot: string
  network?: SandboxPolicy['network']
  limits?: Partial<ResourceLimits>
  /** Extra paths to hide, on top of the default deny list. */
  denyPaths?: readonly string[]
  /** Extra directories the agent may write to without a grant. */
  additionalWriteRoots?: readonly string[]
  /** `--full-control` and `/sandbox off` both land here. */
  disabled?: boolean
  logger: Logger
}

export interface SandboxResolution {
  sandbox: Sandbox
  /** Why this backend was chosen, for the debug view. */
  reason: string
}

/**
 * Pick the strongest isolation available on this machine.
 *
 * Order matters: a working boundary is always preferred, and falling back to
 * the host is a visible, logged decision rather than a silent default.
 */
export async function createSandbox(request: SandboxRequest): Promise<SandboxResolution> {
  const policy = buildPolicy(request)

  if (request.disabled) {
    return {
      sandbox: await new NoSandboxBackend({ scrubEnv: false }).create(policy, request.logger),
      reason: 'sandboxing disabled for this session',
    }
  }

  const candidates = backendsForPlatform()
  for (const backend of candidates) {
    const probe = await backend.probe()
    if (probe.usable) {
      const sandbox = await backend.create(policy, request.logger)
      return { sandbox, reason: `${backend.name}: ${probe.detail}` }
    }
    request.logger.debug('sandbox backend unavailable', {
      backend: backend.name,
      detail: probe.detail,
    })
  }

  const reason = candidates.map((b) => `${b.name} unavailable`).join('; ')
  return {
    sandbox: await new NoSandboxBackend().create(policy, request.logger),
    reason: `${reason}; running unsandboxed`,
  }
}

function backendsForPlatform(): SandboxBackend[] {
  switch (process.platform) {
    case 'linux':
      return [new BubblewrapBackend(), new NoSandboxBackend()]
    case 'darwin':
      // Seatbelt is deprecated but still the only unprivileged option; probing
      // it decides whether we advertise isolation.
      return [new BubblewrapBackend(), new NoSandboxBackend()]
    default:
      return [new NoSandboxBackend()]
  }
}

/** Flex's own directories, always writable, never needing a grant. */
export function flexDirs(): {
  configDir: string
  cacheDir: string
  stateDir: string
  logDir: string
} {
  const base = flexHome()
  const configDir = join(base, 'config')
  const cacheDir = join(base, 'cache')
  const stateDir = join(base, 'state')
  const logDir = join(base, 'logs')
  for (const dir of [base, configDir, cacheDir, stateDir, logDir]) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    } catch {
      /* Flex must still start if its state dir is not writable. */
    }
  }
  return { configDir, cacheDir, stateDir, logDir }
}

export function buildPolicy(request: SandboxRequest): SandboxPolicy {
  const { cacheDir } = flexDirs()
  return {
    readRoots: [resolve(request.workspaceRoot), homedir(), '/usr', '/etc', '/opt', '/bin', '/lib'],
    writeRoots: [
      resolve(request.workspaceRoot),
      tmpdir(),
      cacheDir,
      ...(request.additionalWriteRoots ?? []).map((r) => resolve(r)),
    ],
    denyPaths: [...DEFAULT_DENY_PATHS, ...(request.denyPaths ?? [])],
    denyWritePaths: [...DEFAULT_DENY_PATHS, ...(request.denyPaths ?? [])],
    network: request.network ?? { mode: 'disabled' },
    limits: { ...DEFAULT_LIMITS, ...request.limits },
  }
}
