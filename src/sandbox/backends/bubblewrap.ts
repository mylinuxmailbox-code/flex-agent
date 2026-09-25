import { existsSync, mkdirSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execa } from 'execa'
import type { Logger } from '../../observability/logger.js'
import {
  type ExecHandle,
  type ExecSpec,
  expandPath,
  type Sandbox,
  type SandboxBackend,
  type SandboxInfo,
  type SandboxPolicy,
} from '../types.js'

/**
 * Linux isolation via bubblewrap.
 *
 * This is a real boundary, not a wrapper script: the child gets its own mount,
 * pid, ipc, uts and (when network is disabled) network namespace, and the host
 * filesystem is mounted read-only with only the granted roots writable. Escape
 * requires a kernel bug, not a configuration mistake.
 *
 * The environment is scrubbed on the way in. The agent process has an
 * ANTHROPIC_API_KEY in its environment; a command it runs should not.
 */

const BIN = '/usr/bin/bwrap'
const PRLIMIT = '/usr/bin/prlimit'

/** Env var names that must never reach a command the model chose. */
const SECRET_NAME_RE =
  /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|SESSION|COOKIE|PRIVATE|CERT|DSN|^PAT$|^GH_|^GITHUB_|^AWS_|^AZURE_|^GCP_|^GOOGLE_|^OPENAI_|^ANTHROPIC_|^CLAUDE_|^NPM_|^DOCKER_|^STRIPE_|^SLACK_|^SENDGRID_|^TWILIO_)/i

export interface BubblewrapOptions {
  /** Keep the user in their real $HOME. Off by default — see below. */
  allowRealHome?: boolean
  /** Extra env var names to forward even though they look secret-shaped. */
  envPassthrough?: readonly string[]
}

export class BubblewrapBackend implements SandboxBackend {
  readonly name = 'bubblewrap'

  async probe(): Promise<{ usable: boolean; detail: string }> {
    try {
      await execa(BIN, ['--version'], { timeout: 5000 })
    } catch (err) {
      return {
        usable: false,
        detail: `bubblewrap is not available at ${BIN}: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
    // `--version` succeeds even when the kernel forbids user namespaces, which
    // is the failure that actually matters. Prove isolation works.
    try {
      const result = await execa(
        BIN,
        [
          '--ro-bind',
          '/',
          '/',
          '--proc',
          '/proc',
          '--dev',
          '/dev',
          '--unshare-user',
          '--unshare-pid',
          '--unshare-net',
          '--die-with-parent',
          '/bin/true',
        ],
        { timeout: 5000, reject: false },
      )
      if (result.exitCode !== 0) {
        return {
          usable: false,
          detail: `bubblewrap cannot create namespaces here: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
        }
      }
      return { usable: true, detail: 'bubblewrap with user, mount, pid and network namespaces' }
    } catch (err) {
      return { usable: false, detail: `bubblewrap probe failed: ${String(err)}` }
    }
  }

  async create(
    policy: SandboxPolicy,
    logger: Logger,
    opts: BubblewrapOptions = {},
  ): Promise<Sandbox> {
    return new BubblewrapSandbox(policy, logger, opts)
  }
}

class BubblewrapSandbox implements Sandbox {
  readonly policy: SandboxPolicy
  readonly info: SandboxInfo
  readonly #logger: Logger
  readonly #opts: BubblewrapOptions
  /** Per-sandbox scratch HOME so writes to ~ land somewhere disposable. */
  readonly #sandboxHome: string
  /** Mounted over denied paths so they read as empty inside the sandbox. */
  readonly #emptyDir: string

  constructor(policy: SandboxPolicy, logger: Logger, opts: BubblewrapOptions) {
    this.policy = policy
    this.#logger = logger
    this.#opts = opts
    this.#sandboxHome = mkdtempSync(join(tmpdir(), 'flex-home-'))
    this.#emptyDir = mkdtempSync(join(tmpdir(), 'flex-empty-'))
    mkdirSync(this.#sandboxHome, { recursive: true, mode: 0o700 })

    this.info = {
      backend: 'bubblewrap',
      status: 'active',
      isolated: true,
      detail:
        policy.network.mode === 'disabled'
          ? 'isolated: mount + pid + network namespaces, read-only filesystem outside the workspace'
          : 'isolated: mount + pid namespaces, read-only filesystem outside the workspace (network reachable)',
      command: [BIN],
    }
  }

  writableRoots(): readonly string[] {
    return [...this.policy.writeRoots, this.#sandboxHome, tmpdir()]
  }

  canRead(path: string): boolean {
    if (this.policy.denyPaths.some((d) => isUnder(path, expandPath(d)))) return false
    return (
      this.policy.readRoots.some((r) => isUnder(path, r)) ||
      this.writableRoots().some((r) => isUnder(path, r))
    )
  }

  canWrite(path: string): boolean {
    if (this.policy.denyWritePaths.some((d) => isUnder(path, expandPath(d)))) return false
    return this.writableRoots().some((r) => isUnder(path, r))
  }

  describe(spec: ExecSpec): { argv: string[]; wrapped: boolean } {
    if (spec.bypass) return { argv: [spec.command, ...spec.args], wrapped: false }
    return { argv: this.#argv(spec), wrapped: true }
  }

  async exec(
    spec: ExecSpec,
    onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void,
  ): Promise<ExecHandle> {
    const argv = spec.bypass ? [spec.command, ...spec.args] : this.#argv(spec)
    const env = spec.bypass ? (spec.env ?? process.env) : this.#childEnv(spec)
    const timeoutMs = Math.min(
      spec.timeoutMs ?? this.policy.limits.wallClockMs,
      this.policy.limits.wallClockMs,
    )
    const started = Date.now()

    let stdout = ''
    let stderr = ''
    let truncated = false
    const cap = this.policy.limits.outputBytes

    this.#logger.debug('sandbox.exec', { argv: argv.slice(0, 2), isolated: !spec.bypass })

    try {
      const subprocess = execa(argv[0] as string, argv.slice(1), {
        cwd: spec.cwd,
        env,
        timeout: timeoutMs,
        reject: false,
        stripFinalNewline: false,
        input: spec.stdin,
        buffer: false,
      })
      const childPid = subprocess.pid

      subprocess.stdout?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        if (stdout.length + text.length > cap) {
          stdout += text.slice(0, Math.max(0, cap - stdout.length))
          truncated = true
          return
        }
        stdout += text
        onOutput?.(text, 'stdout')
      })
      subprocess.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf8')
        if (stderr.length + text.length > cap) {
          stderr += text.slice(0, Math.max(0, cap - stderr.length))
          truncated = true
          return
        }
        stderr += text
        onOutput?.(text, 'stderr')
      })

      const result = await subprocess
      const timedOut = result.timedOut === true
      return {
        pid: childPid,
        exitCode: timedOut ? null : (result.exitCode ?? null),
        signal: result.signal ?? null,
        stdout,
        stderr,
        truncated,
        durationMs: Date.now() - started,
        timedOut,
      }
    } catch (err) {
      this.#logger.error('sandbox.exec failed', { error: String(err), argv: argv.slice(0, 3) })
      return {
        exitCode: null,
        signal: null,
        stdout,
        stderr: `${stderr}\nbwrap failed to start: ${err instanceof Error ? err.message : String(err)}`,
        truncated,
        durationMs: Date.now() - started,
        timedOut: false,
      }
    }
  }

  /** Full argv for a command, wrapper included. Used in permission previews. */
  #argv(spec: ExecSpec): string[] {
    const argv: string[] = [BIN]

    // Read-only root first, then punch writable holes in exactly the granted
    // roots. bwrap applies mounts in order, so later mounts win.
    argv.push('--ro-bind', '/', '/')
    argv.push('--proc', '/proc', '--dev', '/dev', '--tmpfs', '/run')

    for (const root of this.policy.writeRoots) {
      if (existsSync(root)) argv.push('--bind', root, root)
    }
    // Scratch space the command is expected to need.
    argv.push('--bind', this.#sandboxHome, this.#sandboxHome)
    if (existsSync(tmpdir())) argv.push('--bind', tmpdir(), tmpdir())

    // Deny lists: shadow the real path so it reads as empty rather than as
    // "permission denied". Directories get an empty directory bound over them;
    // files get /dev/null. bwrap can only mount onto an existing path — a
    // nonexistent target aborts startup — so absent paths are skipped, since
    // they hold nothing to protect.
    for (const denied of this.policy.denyPaths) {
      const p = expandPath(denied)
      const stats = statSafe(p)
      if (!stats) continue
      argv.push('--ro-bind', stats.isDirectory() ? this.#emptyDir : '/dev/null', p)
    }

    // Namespaces.
    argv.push(
      '--unshare-user',
      '--unshare-pid',
      '--unshare-ipc',
      '--unshare-uts',
      '--unshare-cgroup',
    )
    if (this.policy.network.mode === 'disabled') {
      argv.push('--unshare-net')
    }

    argv.push('--die-with-parent', '--new-session', '--hostname', 'flex-sandbox')

    // Clear first, then set. bwrap passes its own environment to the child, so
    // without --clearenv every secret in Flex's process env is handed straight
    // to whatever command the model chose to run. --setenv only overrides the
    // names it mentions; it does not remove the rest.
    argv.push('--clearenv')
    for (const [key, value] of Object.entries(this.#childEnv(spec))) {
      argv.push('--setenv', key, value)
    }
    argv.push('--chdir', spec.cwd)

    // bwrap has no rlimit flags, so limits are applied by a prlimit wrapper
    // inside the namespace. Wall-clock is enforced by the caller's timeout.
    argv.push('--', ...this.#limitWrapper(spec.command), ...spec.args)
    return argv
  }

  /**
   * `prlimit` prefixes the real command with the policy's rlimits.
   *
   * RLIMIT_NPROC is deliberately not set: it counts every process the real uid
   * already owns, so on a busy desktop it locks the sandbox out entirely.
   */
  #limitWrapper(command: string): string[] {
    const limits = this.policy.limits
    const args: string[] = []
    if (limits.memoryMb) args.push(`--as=${limits.memoryMb * 1024 * 1024}`)
    if (limits.fileSizeMb) args.push(`--fsize=${limits.fileSizeMb * 1024 * 1024}`)
    if (limits.cpuSeconds) args.push(`--cpu=${limits.cpuSeconds}`)
    if (args.length === 0) return [command]
    return [PRLIMIT, ...args, '--', command]
  }

  /**
   * The environment a model-chosen command sees.
   *
   * Identity and helper variables pass through so builds work; anything
   * secret-shaped is dropped. A compromised test script should not be able to
   * print the user's API keys.
   */
  #childEnv(spec: ExecSpec): Record<string, string> {
    const source = spec.env ?? process.env
    const out: Record<string, string> = {}
    const passthrough = new Set(this.#opts.envPassthrough ?? [])
    for (const [key, value] of Object.entries(source)) {
      if (value === undefined) continue
      if (passthrough.has(key) || !SECRET_NAME_RE.test(key)) {
        out[key] = value
      }
    }
    out.HOME = this.#sandboxHome
    out.FLEX_SANDBOX = '1'
    if (this.policy.network.mode === 'disabled') {
      // Make failures legible instead of mysterious timeouts.
      out.NO_PROXY = '*'
      out.http_proxy = ''
      out.https_proxy = ''
    }
    return out
  }
}

/** True when `child` is `parent` or lives beneath it. Handles parent === '/'. */
function isUnder(child: string, parent: string): boolean {
  if (parent === '/') return child.startsWith('/')
  if (child === parent) return true
  return child.startsWith(`${parent}/`)
}

/** `statSync` that answers "does not exist" with null instead of throwing. */
function statSafe(path: string): import('node:fs').Stats | null {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

/** Factory used by the sandbox registry. */
export function createBubblewrapBackend(): SandboxBackend {
  return new BubblewrapBackend()
}
