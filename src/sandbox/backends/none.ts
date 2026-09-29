import { execa } from 'execa'
import type { Logger } from '../../observability/logger.js'
import { scrubEnv } from '../env.js'
import { isUnder, spawnDetached } from '../process.js'
import {
  type ExecHandle,
  type ExecSpec,
  expandPath,
  type Sandbox,
  type SandboxBackend,
  type SandboxInfo,
  type SandboxPolicy,
  type SpawnedProcess,
} from '../types.js'

/**
 * The fallback when no isolation backend is usable.
 *
 * It is not silent. `info.isolated` is false and `info.detail` explains what is
 * missing, because the status bar has to show `⚠ UNSANDBOXED` rather than
 * implying protection that does not exist.
 */
export class NoSandboxBackend implements SandboxBackend {
  readonly name = 'none'

  /**
   * `scrubEnv` drops secret-shaped variables from what commands see. It is on
   * for the "no backend available" fallback, and off for `--full-control`,
   * where the user asked for the command to run exactly as they would.
   */
  constructor(private readonly options: { scrubEnv?: boolean } = {}) {}

  async probe(): Promise<{ usable: boolean; detail: string }> {
    return { usable: true, detail: 'commands run directly on the host' }
  }

  async create(policy: SandboxPolicy, logger: Logger): Promise<Sandbox> {
    return new NoSandbox(policy, logger, this.options.scrubEnv ?? true)
  }
}

class NoSandbox implements Sandbox {
  readonly policy: SandboxPolicy
  readonly info: SandboxInfo
  readonly #logger: Logger

  readonly #scrub: boolean

  constructor(policy: SandboxPolicy, logger: Logger, scrub: boolean) {
    this.policy = policy
    this.#logger = logger
    this.#scrub = scrub
    this.info = {
      backend: 'none',
      status: 'unavailable',
      isolated: false,
      detail:
        'No sandbox backend is available on this system. Commands run with your full user permissions. ' +
        'Permission prompts still apply.',
    }
  }

  writableRoots(): readonly string[] {
    return this.policy.writeRoots
  }

  canRead(path: string): boolean {
    return !this.policy.denyPaths.some((d) => isUnder(path, expandPath(d)))
  }

  canWrite(path: string): boolean {
    return !this.policy.denyWritePaths.some((d) => isUnder(path, expandPath(d)))
  }

  #env(spec: ExecSpec): Record<string, string | undefined> {
    const merged = { ...process.env, ...spec.env }
    return this.#scrub ? scrubEnv(merged) : merged
  }

  spawn(
    spec: ExecSpec,
    onOutput: (chunk: string, stream: 'stdout' | 'stderr') => void,
  ): SpawnedProcess {
    return spawnDetached([spec.command, ...spec.args], spec.cwd, this.#env(spec), onOutput)
  }

  describe(spec: ExecSpec): { argv: string[]; wrapped: boolean } {
    return { argv: [spec.command, ...spec.args], wrapped: false }
  }

  async exec(
    spec: ExecSpec,
    onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void,
  ): Promise<ExecHandle> {
    const started = Date.now()
    let stdout = ''
    let stderr = ''
    let truncated = false
    const cap = this.policy.limits.outputBytes

    try {
      const subprocess = execa(spec.command, [...spec.args], {
        cwd: spec.cwd,
        env: this.#env(spec) as Record<string, string>,
        extendEnv: false,
        timeout: spec.timeoutMs ?? this.policy.limits.wallClockMs,
        reject: false,
        input: spec.stdin,
        buffer: false,
        ...(spec.signal ? { cancelSignal: spec.signal } : {}),
      })
      const childPid = subprocess.pid
      subprocess.stdout?.on('data', (c: Buffer) => {
        const text = c.toString('utf8')
        if (stdout.length + text.length > cap) {
          stdout += text.slice(0, Math.max(0, cap - stdout.length))
          truncated = true
          return
        }
        stdout += text
        onOutput?.(text, 'stdout')
      })
      subprocess.stderr?.on('data', (c: Buffer) => {
        const text = c.toString('utf8')
        if (stderr.length + text.length > cap) {
          stderr += text.slice(0, Math.max(0, cap - stderr.length))
          truncated = true
          return
        }
        stderr += text
        onOutput?.(text, 'stderr')
      })
      const result = await subprocess
      return {
        pid: childPid,
        exitCode: result.timedOut ? null : (result.exitCode ?? null),
        signal: result.signal ?? null,
        stdout,
        stderr,
        truncated,
        durationMs: Date.now() - started,
        timedOut: result.timedOut === true,
      }
    } catch (err) {
      this.#logger.error('unsandboxed exec failed', { error: String(err) })
      return {
        exitCode: null,
        signal: null,
        stdout,
        stderr: `${stderr}\n${err instanceof Error ? err.message : String(err)}`,
        truncated,
        durationMs: Date.now() - started,
        timedOut: false,
      }
    }
  }
}
