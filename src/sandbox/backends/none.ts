import { execa } from 'execa'
import type { Logger } from '../../observability/logger.js'
import type {
  ExecHandle,
  ExecSpec,
  Sandbox,
  SandboxBackend,
  SandboxInfo,
  SandboxPolicy,
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

  async probe(): Promise<{ usable: boolean; detail: string }> {
    return { usable: true, detail: 'commands run directly on the host' }
  }

  async create(policy: SandboxPolicy, logger: Logger): Promise<Sandbox> {
    return new NoSandbox(policy, logger)
  }
}

class NoSandbox implements Sandbox {
  readonly policy: SandboxPolicy
  readonly info: SandboxInfo
  readonly #logger: Logger

  constructor(policy: SandboxPolicy, logger: Logger) {
    this.policy = policy
    this.#logger = logger
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

  canRead(): boolean {
    return true
  }

  canWrite(path: string): boolean {
    return !this.policy.denyWritePaths.some((d) => path.startsWith(d))
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
        env: { ...process.env, ...spec.env },
        timeout: spec.timeoutMs ?? this.policy.limits.wallClockMs,
        reject: false,
        input: spec.stdin,
        buffer: false,
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
