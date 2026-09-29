import { isAbsolute, relative, resolve, sep } from 'node:path'
import { DEFAULT_DENY_PATHS, expandPath, type Sandbox } from '../../sandbox/types.js'

/**
 * Path resolution shared by every filesystem tool.
 *
 * The rule everywhere: paths from the model are untrusted input. Resolve them
 * against the workspace root, expand `~`, and refuse anything that escapes the
 * workspace or lands in a denied location. Containment is checked *after*
 * normalisation so `a/../../etc/passwd` cannot slip through.
 */

export class PathError extends Error {
  readonly path: string
  constructor(message: string, path: string) {
    super(message)
    this.name = 'PathError'
    this.path = path
  }
}

export interface ResolveOptions {
  /** Require the result to stay inside the workspace. Default true. */
  mustBeInWorkspace?: boolean
  /** Allow results inside the sandbox's own temp/cache dirs. Default true. */
  allowScratch?: boolean
  /** When true, the path need not exist yet. Default true (for writes). */
  mustExist?: boolean
}

export function resolvePath(
  rawPath: string,
  ctx: { workspaceRoot: string; sandbox?: Sandbox },
  opts: ResolveOptions = {},
): string {
  const { mustBeInWorkspace = true, allowScratch = true, mustExist = false } = opts
  if (!rawPath || rawPath.trim() === '') throw new PathError('path is empty', rawPath)

  const expanded = expandPath(rawPath.trim())
  const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(ctx.workspaceRoot, expanded)

  if (abs !== '/' && abs.endsWith(sep)) return abs.slice(0, -1)

  if (mustBeInWorkspace) {
    const roots = [ctx.workspaceRoot]
    if (allowScratch && ctx.sandbox) {
      roots.push(...ctx.sandbox.writableRoots())
    }
    if (!roots.some((root) => isInside(abs, root))) {
      throw new PathError(`path escapes the workspace: ${rawPath} (resolved to ${abs})`, rawPath)
    }
  }

  const denied = [
    ...DEFAULT_DENY_PATHS.map((p) => expandPath(p)),
    resolve(ctx.workspaceRoot, '.flex', 'config.json'),
    resolve(ctx.workspaceRoot, '.env'),
    resolve(ctx.workspaceRoot, '.env.local'),
    resolve(ctx.workspaceRoot, '.env.development'),
    resolve(ctx.workspaceRoot, '.env.production'),
  ]
  if (denied.some((d) => isInside(abs, d))) {
    throw new PathError(`path is in a protected location: ${rawPath}`, rawPath)
  }

  if (ctx.sandbox && mustExist && !ctx.sandbox.canRead(abs)) {
    throw new PathError(`sandbox policy does not permit reading ${rawPath}`, rawPath)
  }

  return abs
}

/** True when `child` is `parent` or lives under it. */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Present an absolute path back to the user the way they typed it. */
export function toDisplayPath(absPath: string, workspaceRoot: string): string {
  const rel = relative(workspaceRoot, absPath)
  if (rel === '') return '.'
  if (rel.startsWith('..')) return absPath
  return rel.split(sep).join('/')
}

export function toPosix(path: string): string {
  return path.split(sep).join('/')
}
