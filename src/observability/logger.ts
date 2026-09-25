import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 }

export interface LogFields {
  [key: string]: unknown
}

export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  child(bindings: LogFields): Logger
}

export interface LoggerOptions {
  level: LogLevel
  /** Directory for the JSONL log. Omit to disable file logging entirely. */
  dir?: string
  sessionId?: string
  /** Also mirror to stderr. Off by default so it never corrupts the TUI. */
  stderr?: boolean
  bindings?: LogFields
}

/**
 * Patterns whose *values* must never reach a log file or telemetry.
 *
 * This is a safety net, not a substitute for not logging secrets. It exists
 * because tool arguments, command strings and error messages all flow through
 * here, and any of them can contain a pasted token.
 */
const SECRET_PATTERNS: readonly {
  re: RegExp
  replace: (match: string, ...groups: string[]) => string
}[] = [
  {
    re: /\b(sk-[A-Za-z0-9_-]{8,})[A-Za-z0-9_-]*/g,
    replace: (m) => `${m.slice(0, 11)}…[redacted]`,
  },
  {
    re: /\b(gh[pousr]_[A-Za-z0-9]{8,})[A-Za-z0-9]*/g,
    replace: (m) => `${m.slice(0, 11)}…[redacted]`,
  },
  {
    re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replace: () => 'AKIA…[redacted]',
  },
  {
    re: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
    replace: () => 'eyJ…[redacted]',
  },
  {
    re: /(-----BEGIN [A-Z ]*PRIVATE KEY-----)([\s\S]*?)(-----END [A-Z ]*PRIVATE KEY-----)/g,
    replace: () => '-----BEGIN PRIVATE KEY-----…[redacted]…-----END PRIVATE KEY-----',
  },
  {
    re: /("(?:api[_-]?key|token|secret|password|passwd|authorization)"\s*[:=]\s*")([^"]+)(")/gi,
    replace: (_m, a: string, _v: string, c: string) => `${a}…[redacted]${c}`,
  },
  {
    re: /((?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH)[A-Z_]*\s*=\s*)([^\s"']+)/g,
    replace: (_m, a: string) => `${a}…[redacted]`,
  },
  {
    re: /(\b(?:password|passwd)\s*[:=]\s*)([^\s,;]+)/gi,
    replace: (_m, a: string) => `${a}…[redacted]`,
  },
]

/** Redact secrets from any string before it is written anywhere. */
export function redact(text: string): string {
  let out = text
  for (const { re, replace } of SECRET_PATTERNS) {
    re.lastIndex = 0
    out = out.replace(re, replace)
  }
  return out
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]'
  if (typeof value === 'string') return redact(value)
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redactValue(v, depth + 1))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (/^(password|passwd|secret|token|api[_-]?key|authorization|cookie)$/i.test(k)) {
      out[k] = '…[redacted]'
    } else {
      out[k] = redactValue(v, depth + 1)
    }
  }
  return out
}

export function createLogger(opts: LoggerOptions): Logger {
  const { level, dir, stderr } = opts
  const threshold = LEVEL_ORDER[level]
  const bindings = { sessionId: opts.sessionId, ...opts.bindings }

  if (dir) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 })
    } catch {
      // Logging must never be the reason a session fails to start.
    }
  }

  function write(lvl: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[lvl] < threshold) return
    const entry = {
      t: new Date().toISOString(),
      level: lvl,
      msg: redact(message),
      ...bindings,
      ...(fields ? (redactValue(fields) as LogFields) : {}),
    }
    const line = JSON.stringify(entry)
    if (dir) {
      try {
        appendFileSync(join(dir, 'flex.jsonl'), `${line}\n`, { mode: 0o600 })
      } catch {
        /* ignore */
      }
    }
    if (stderr) process.stderr.write(`${line}\n`)
  }

  const logger: Logger = {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (extra) =>
      createLogger({
        ...opts,
        dir,
        sessionId: opts.sessionId,
        bindings: { ...bindings, ...extra },
      }),
  }
  return logger
}

/** Discards everything. The default in tests and in `--quiet` invocations. */
export const nullLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
}

export function defaultLogDir(): string {
  return join(homedir(), '.flex', 'logs')
}
