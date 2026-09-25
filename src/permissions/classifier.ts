import { homedir, tmpdir } from 'node:os'
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'
import {
  type ActionDescription,
  maxRisk,
  type NetworkTarget,
  type RiskAssessment,
  type RiskLevel,
  type RiskSignal,
} from './types.js'

/**
 * Rule-based risk classifier.
 *
 * This is a *deterministic* pre-filter, not a judgement call: it maps concrete
 * signals (a path under ~/.ssh, a pipe from curl into sh, a force push) onto
 * a risk level. The policy engine then decides whether that level warrants
 * interrupting the user. Keeping the two separate means plugins can add
 * policy without weakening detection, and the UI can always explain *why*.
 */

export interface ClassifierContext {
  /** The repository/workspace the session is operating in. */
  workspaceRoot: string
  /** Flex's own scratch space; writes here are routine. */
  tempDir: string
  /** Flex's cache; writes here are routine. */
  cacheDir: string
  /** Extra read roots the user granted (e.g. a monorepo sibling). */
  additionalReadRoots?: readonly string[]
}

export interface CommandRule {
  id: string
  pattern: RegExp
  signal: RiskSignal
  level: RiskLevel
  reason: string
  /** Only count as a match outside a sandboxed preview of the command. */
  requiresWordBoundary?: boolean
}

/**
 * Ordered most-specific first. The first match contributes its signal; every
 * match contributes to the final level, so `sudo rm -rf /` is worse than
 * either half.
 */
export const COMMAND_RULES: readonly CommandRule[] = [
  // --- catastrophic, unrecoverable -----------------------------------------
  {
    id: 'destroy-block-device',
    pattern: /\b(mkfs(\.\w+)?|fdisk|parted|shred|wipefs)\b|\bdd\b[^|;&]*\bof=\/dev\//,
    signal: 'destructive-delete',
    level: 'critical',
    reason: 'writes directly to a block device, destroying data irreversibly',
  },
  {
    id: 'delete-root-or-home',
    pattern:
      /\brm\b[^|;&]*\s(-[a-zA-Z]*[rR][a-zA-Z]*[fF]|-[a-zA-Z]*[fF][a-zA-Z]*[rR])[^|;&]*(\s|\s-[a-zA-Z]+\s)*(~|\$HOME|\/\s*$|\/\*|\/\.\s*$|\/etc|\/usr|\/var|\/bin|\/lib|\/opt|\/System|\/Applications)/,
    signal: 'destructive-delete',
    level: 'critical',
    reason: 'recursively force-deletes a system or home directory',
  },
  {
    id: 'delete-git-metadata',
    pattern:
      /\brm\b[^|;&]*\s(-[a-zA-Z]*r[a-zA-Z]*[fF]|-[a-zA-Z]*[fF][a-zA-Z]*r)[^|;&]*\s\.git(\b|\/)/,
    signal: 'destructive-delete',
    level: 'critical',
    reason: 'deletes git history for the repository',
  },
  {
    id: 'pipe-download-to-shell',
    pattern:
      /\b(curl|wget|fetch)\b[^|]*\|\s*(sudo\s+)?(ba|z|k|da)?sh\b|\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(python[23]?|node|ruby|perl)\b/,
    signal: 'remote-execution',
    level: 'critical',
    reason: 'downloads and immediately executes remote code without review',
  },
  {
    id: 'disk-fill',
    pattern: /\bdd\b[^|;&]*\bof=\/dev\/(null|zero)\b[^|;&]*\b(if|of)=\/dev\//,
    signal: 'destructive-delete',
    level: 'medium',
    reason: 'writes an unbounded amount of data to a device',
  },

  // --- privilege and system -------------------------------------------------
  {
    id: 'privilege-escalation',
    pattern: /(^|[\s;|&(])(sudo|doas|pkexec|su)\s/,
    signal: 'privilege-escalation',
    level: 'high',
    reason: 'runs with elevated privileges',
  },
  {
    id: 'system-modification',
    pattern:
      /\b(systemctl|service|launchctl|defaults|regedit|setcap|chown|chgrp|usermod|useradd|groupadd|visudo)\b/,
    signal: 'system-modification',
    level: 'high',
    reason: 'modifies system-level configuration or services',
  },
  {
    id: 'system-path-write',
    pattern:
      /(^|[\s;|&(])(rm|mv|cp|chmod|chown|truncate|tee)\s+[^|;&]*(\/etc\/|\/usr\/|\/bin\/|\/sbin\/|\/boot\/|\/System\/|C:\\Windows)/,
    signal: 'system-modification',
    level: 'high',
    reason: 'modifies files outside the system directories',
  },
  {
    id: 'permission-change',
    pattern:
      /\bchmod\s+(-[a-zA-Z]+\s+)*(777|666|a\+rwx|o\+w)\b|\bchown\b[^|;&]*\broot\b|\bsetfacl\b/,
    signal: 'permission-change',
    level: 'high',
    reason: 'makes files or directories world-writable',
  },
  {
    id: 'shutdown',
    pattern: /\b(shutdown|reboot|halt|poweroff|init\s+0)\b/,
    signal: 'system-modification',
    level: 'high',
    reason: 'shuts down or restarts the machine',
  },
  {
    id: 'package-manager-system',
    pattern: /\b(apt|apt-get|yum|dnf|pacman|brew|port)\s+(install|remove|purge|uninstall)\b/,
    signal: 'system-modification',
    level: 'high',
    reason: 'installs or removes system packages',
  },

  // --- credentials and secrets ---------------------------------------------
  {
    id: 'credential-path-read',
    pattern:
      /(~|\$HOME|\/home\/[^/\s]+|\/Users\/[^/\s]+)\/\.(ssh|aws|config\/gcloud|docker|gnupg|kube|azure|azure-cli|config\/gh|terraform\.d|npmrc|netrc|pypirc)\b/,
    signal: 'credential-access',
    level: 'high',
    reason: 'reads a credentials or key store',
  },
  {
    id: 'private-key-read',
    pattern:
      /\b(id_rsa|id_dsa|id_ecdsa|id_ed25519|.*\.pem|.*\.p12|.*\.pfx|credentials\.json|service-account.*\.json)\b/,
    signal: 'credential-access',
    level: 'high',
    reason: 'accesses private key material',
  },
  {
    id: 'env-dump',
    pattern: /\b(env|printenv|set)\b\s*(\||>|;|$)|\bexport\s+-p\b/,
    signal: 'secret-exposure',
    level: 'medium',
    reason: 'dumps the full environment, which commonly contains secrets',
  },
  {
    id: 'git-credential',
    pattern:
      /\.git-credentials\b|\bgh\s+auth\s+token\b|\baws\s+configure\s+get\b|\bgcloud\s+auth\s+print-access-token\b/,
    signal: 'credential-access',
    level: 'high',
    reason: 'prints a stored credential',
  },

  // --- git: irreversible local and remote changes ---------------------------
  {
    id: 'git-force-push',
    pattern: /\bgit\b[^|;&]*\bpush\b[^|;&]*(--force\b(?!-with-lease)|(^|\s)-f(\s|$))/,
    signal: 'force-push',
    level: 'high',
    reason: 'force-pushes, which can destroy remote history for collaborators',
  },
  {
    id: 'git-delete-remote',
    pattern: /\bgit\b[^|;&]*\bpush\b[^|;&]*\s--delete\b|\bgit\b[^|;&]*\bpush\b[^|;&]*\s:[\w./-]+\s/,
    signal: 'cloud-destruction',
    level: 'high',
    reason: 'deletes a remote branch',
  },
  {
    id: 'git-history-rewrite',
    pattern:
      /\bgit\b[^|;&]*\b(rebase|filter-branch|filter-repo)\b|\bgit\b[^|;&]*\bcommit\b[^|;&]*--amend\b/,
    signal: 'history-rewrite',
    level: 'high',
    reason: 'rewrites existing commit history',
  },
  {
    id: 'git-hard-reset',
    pattern:
      /\bgit\b[^|;&]*\breset\b[^|;&]*--hard\b|\bgit\b[^|;&]*\bclean\b[^|;&]*-[a-zA-Z]*[fd][a-zA-Z]*[dx]?/,
    signal: 'destructive-delete',
    level: 'high',
    reason: 'discards uncommitted work irreversibly',
  },
  {
    id: 'git-checkout-discard',
    pattern: /\bgit\b[^|;&]*\b(checkout|restore)\b[^|;&]*(--\s|\s--\s*$)|git checkout\s+--\s+\S/,
    signal: 'destructive-delete',
    level: 'medium',
    reason: 'discards local modifications',
  },

  // --- external effects -----------------------------------------------------
  {
    id: 'package-publish',
    pattern:
      /\b(npm|yarn|pnpm)\s+publish\b|\b(cargo|gem|twine|mvn|poetry)\s+(publish|push)\b|\bdocker\s+push\b/,
    signal: 'package-publish',
    level: 'high',
    reason: 'publishes an artifact to a public or shared registry',
  },
  {
    id: 'cloud-cli',
    pattern:
      /\b(aws|gcloud|az|doctl|flyctl|heroku|vercel|wrangler|kubectl|helm|terraform|pulumi)\b/,
    signal: 'production-modification',
    level: 'high',
    reason: 'operates on cloud or production infrastructure',
  },
  {
    id: 'k8s-destructive',
    pattern: /\bkubectl\b[^|;&]*\b(delete|apply|replace|scale|rollout\s+restart)\b/,
    signal: 'cloud-destruction',
    level: 'critical',
    reason: 'mutates cluster state',
  },
  {
    id: 'terraform-apply',
    pattern: /\bterraform\b[^|;&]*\b(apply|destroy|import)\b|\bpulumi\b[^|;&]*\b(up|destroy)\b/,
    signal: 'production-modification',
    level: 'critical',
    reason: 'applies or destroys real infrastructure',
  },
  {
    id: 'db-destructive',
    pattern: /\b(drop|truncate)\s+(table|database|schema)\b|\bDELETE\s+FROM\b[^;]*;?\s*$/i,
    signal: 'cloud-destruction',
    level: 'high',
    reason: 'destroys database contents',
  },

  // --- network exfiltration --------------------------------------------------
  {
    id: 'upload-to-remote',
    pattern:
      /\b(curl|wget|scp|rsync)\b[^|;&]*\s(-T\s|--upload-file\s|-d\s--data|-F\s|--form|-X\s*POST)\b/,
    signal: 'network-exfiltration',
    level: 'high',
    reason: 'uploads local data to a remote destination',
  },
  {
    id: 'reverse-shell',
    pattern:
      /\b(nc|ncat|netcat|socat)\b[^|;&]*\s(-e\b|--exec)|\/dev\/tcp\/|bash\s+-i\s+>&\s*\/dev\/tcp/,
    signal: 'remote-execution',
    level: 'critical',
    reason: 'opens a reverse shell to a remote host',
  },

  // --- moderate -------------------------------------------------------------
  {
    id: 'dependency-install',
    pattern:
      /\b(npm|pnpm|yarn|bun)\s+(add|install|i)\b|\bpip3?\s+install\b|\bcargo\s+(add|install)\b|\bgo\s+get\b/,
    signal: 'dependency-install',
    level: 'medium',
    reason: 'installs third-party code that will execute in this environment',
  },
  {
    id: 'unbounded-delete',
    pattern: /\brm\b[^|;&]*\s-[a-zA-Z]*[rR][a-zA-Z]*\s/,
    signal: 'destructive-delete',
    level: 'medium',
    reason: 'recursively deletes files',
  },
]

/** Paths that should never be read without an explicit, informed decision. */
const SENSITIVE_PATH_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /\/\.ssh(\/|$)/, reason: 'SSH private keys' },
  { pattern: /\/\.aws(\/|$)/, reason: 'AWS credentials' },
  { pattern: /\/\.config\/gcloud(\/|$)/, reason: 'Google Cloud credentials' },
  { pattern: /\/\.azure(\/|$)/, reason: 'Azure credentials' },
  { pattern: /\/\.kube(\/|$)/, reason: 'Kubernetes credentials' },
  { pattern: /\/\.gnupg(\/|$)/, reason: 'GPG keyring' },
  { pattern: /\/\.docker(\/|$)/, reason: 'Docker registry credentials' },
  { pattern: /\/\.config\/gh(\/|$)/, reason: 'GitHub credentials' },
  { pattern: /\/\.netrc$/, reason: 'netrc credentials' },
  { pattern: /\/\.npmrc$/, reason: 'npm credentials' },
  { pattern: /\/\.pypirc$/, reason: 'PyPI credentials' },
  { pattern: /\/(\.env|\.env\.[a-z]+)$/i, reason: 'environment secrets' },
  { pattern: /\/\.git-credentials$/, reason: 'stored git credentials' },
  { pattern: /(^|\/)(id_rsa|id_dsa|id_ecdsa|id_ed25519)$/, reason: 'SSH private key' },
  { pattern: /\.(pem|p12|pfx|key|keystore)$/i, reason: 'key material' },
  { pattern: /\/\.password-store(\/|$)/, reason: 'password store' },
  { pattern: /\/(Security|Keychains)\//, reason: 'macOS keychain' },
  { pattern: /\/etc\/(shadow|gshadow|sudoers)/, reason: 'system credential file' },
  { pattern: /\/\.claude\.json$/, reason: 'agent credentials and conversation history' },
  { pattern: /\/\.config\/flex\//, reason: 'Flex configuration and credentials' },
]

/** Where destructive writes are tolerated without prompting. */
function isRoutineWriteTarget(path: string, ctx: ClassifierContext): boolean {
  const resolved = resolve(path)
  return (
    isInside(resolved, ctx.workspaceRoot) ||
    isInside(resolved, ctx.tempDir) ||
    isInside(resolved, ctx.cacheDir) ||
    isInside(resolved, tmpdir()) ||
    (isInside(resolved, homedir()) &&
      // package caches are noise, not user content
      /(\.cache|\.npm|\.pnpm-store|\.local\/share)/.test(resolved))
  )
}

/**
 * Levels for signals a tool declares about itself.
 *
 * A tool declaring a signal is taken at its word: a tool that says it is
 * deleting gets the destructive level even if its arguments look harmless.
 */
const DECLARED_SIGNAL_LEVELS: Partial<Record<RiskSignal, { level: RiskLevel; reason: string }>> = {
  'destructive-delete': { level: 'high', reason: 'deletes or overwrites data' },
  'secret-exposure': { level: 'critical', reason: 'handles credential material' },
  'credential-access': { level: 'high', reason: 'reads credential material' },
  'network-exfiltration': { level: 'high', reason: 'sends data off this machine' },
  'package-publish': { level: 'high', reason: 'publishes to a shared registry' },
  'production-modification': { level: 'high', reason: 'affects production infrastructure' },
  'outside-workspace-write': { level: 'high', reason: 'writes outside the workspace' },
  'permission-change': { level: 'high', reason: 'changes file permissions' },
  'remote-execution': { level: 'critical', reason: 'executes code from a remote source' },
}

export function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export class RiskClassifier {
  readonly #ctx: ClassifierContext
  readonly #extraRules: CommandRule[] = []

  constructor(ctx: ClassifierContext) {
    this.#ctx = ctx
  }

  /** Plugins may contribute rules. They cannot lower an existing signal's level. */
  addRules(rules: readonly CommandRule[]): void {
    this.#extraRules.push(...rules)
  }

  assess(action: ActionDescription): RiskAssessment {
    const signals = new Set<RiskSignal>()
    const reasons: string[] = []
    let level: RiskLevel = 'safe'
    let irreversible = false
    let external = false

    const bump = (next: RiskLevel, signal?: RiskSignal, reason?: string) => {
      level = maxRisk(level, next)
      if (signal) signals.add(signal)
      if (reason && !reasons.includes(reason)) reasons.push(reason)
    }

    // --- signals the tool asserts about itself ------------------------------
    for (const signal of action.signals ?? []) {
      const declared = DECLARED_SIGNAL_LEVELS[signal]
      if (declared) bump(declared.level, signal, declared.reason)
      else bump('medium', signal, `tool reported a ${signal} action`)
      if (signal === 'destructive-delete' || signal === 'secret-exposure') irreversible = true
      if (signal === 'network-exfiltration' || signal === 'package-publish') external = true
    }

    // --- command analysis ---------------------------------------------------
    if (action.command) {
      for (const rule of [...this.#extraRules, ...COMMAND_RULES]) {
        if (rule.pattern.test(action.command)) {
          bump(rule.level, rule.signal, rule.reason)
          if (rule.level === 'critical' || rule.id.startsWith('delete-')) irreversible = true
          if (
            ['package-publish', 'force-push', 'cloud-destruction', 'network-exfiltration'].includes(
              rule.signal,
            )
          ) {
            external = true
          }
        }
      }
      // Piping unknown data into an interpreter is a code-execution smell even
      // when no download is visible in the command text.
      if (/\|\s*(sudo\s+)?(ba|z|k|)sh\b/.test(action.command) && !signals.has('remote-execution')) {
        bump('high', 'remote-execution', 'pipes data into a shell interpreter')
      }
    }

    // --- sensitive paths ---------------------------------------------------
    for (const path of [...(action.readPaths ?? []), ...(action.writePaths ?? [])]) {
      const hit = SENSITIVE_PATH_PATTERNS.find((p) => p.pattern.test(path))
      if (hit) {
        const isWrite = action.writePaths?.includes(path) ?? false
        bump(
          isWrite ? 'critical' : 'high',
          isWrite ? 'secret-exposure' : 'credential-access',
          `${isWrite ? 'writes to' : 'reads'} ${hit.reason}`,
        )
        irreversible ||= isWrite
      }
    }

    // --- writes outside the workspace --------------------------------------
    for (const path of action.writePaths ?? []) {
      if (!isRoutineWriteTarget(path, this.#ctx)) {
        bump('high', 'outside-workspace-write', `writes outside the workspace: ${path}`)
        irreversible = true
      }
    }

    // --- network -----------------------------------------------------------
    for (const target of action.network ?? []) {
      external = true
      const verdict = classifyNetworkTarget(target)
      if (verdict.level !== 'safe') {
        bump(verdict.level, verdict.signal, verdict.reason)
      }
      if (target.transmits) {
        bump('high', 'network-exfiltration', `transmits data to ${target.host}`)
        external = true
      }
    }

    // --- plugin / MCP tools get a floor ------------------------------------
    // An unknown tool doing unknown things is never treated as trivially safe.
    if (isThirdPartyTool(action.tool) && level === 'safe') {
      bump('low', undefined, 'third-party tool with unknown behaviour')
    }

    if (reasons.length === 0) {
      reasons.push(level === 'safe' ? 'no risk signals detected' : 'risk detected')
    }

    return { level, reasons, signals: [...signals], irreversible, external }
  }
}

function isThirdPartyTool(tool: string): boolean {
  return tool.startsWith('mcp__') || tool.startsWith('plugin:')
}

export interface NetworkVerdict {
  level: RiskLevel
  signal?: RiskSignal
  reason?: string
}

/** Literal addresses and hostnames that mean "inside the network". */
export function classifyNetworkTarget(target: NetworkTarget): NetworkVerdict {
  const host = target.host.toLowerCase().replace(/^\[|\]$/g, '')
  const port = target.port ?? (target.protocol === 'https' || target.protocol === 'wss' ? 443 : 80)

  if (isPrivateHost(host)) {
    return {
      level: 'high',
      signal: 'network-exfiltration',
      reason: `contacts a private-network address (${target.host})`,
    }
  }
  if (host === 'localhost' || host === '::1' || host.endsWith('.localhost')) {
    return { level: 'medium', signal: 'production-modification', reason: 'contacts localhost' }
  }
  if (port === 22) {
    return { level: 'medium', reason: 'contacts an SSH endpoint' }
  }
  return { level: 'safe' }
}

const PRIVATE_IPV4 =
  /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/

export function isPrivateHost(host: string): boolean {
  if (PRIVATE_IPV4.test(host)) return true
  if (host === '::1' || host === '::') return true
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true // fc00::/7 unique-local
  if (/^fe80:/i.test(host)) return true // link-local
  if (host.endsWith('.internal') || host.endsWith('.local')) return true
  // AWS/GCP metadata services
  if (host === '169.254.169.254' || host === 'metadata.google.internal') return true
  return false
}

/** Path helpers used by tools to keep behaviour and classification consistent. */
export function normalizeForCompare(path: string, base?: string): string {
  const abs = isAbsolute(path) ? path : resolve(base ?? process.cwd(), path)
  return normalize(abs).split(sep).join('/')
}
