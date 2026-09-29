import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
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

  // Containment is judged on the *real* location. A symlink inside the workspace
  // that points at ~/.ssh is not inside the workspace.
  const real = realLocation(abs.length > 1 && abs.endsWith(sep) ? abs.slice(0, -1) : abs)

  if (mustBeInWorkspace) {
    const roots = [ctx.workspaceRoot]
    if (allowScratch && ctx.sandbox) {
      roots.push(...ctx.sandbox.writableRoots())
    }
    const realRoots = roots.flatMap((r) => [resolve(r), realLocation(resolve(r))])
    if (!realRoots.some((root) => isInside(real, root))) {
      throw new PathError(`path escapes the workspace: ${rawPath} (resolved to ${real})`, rawPath)
    }
  }

  const denied = DEFAULT_DENY_PATHS.map((p) => expandPath(p)).flatMap((p) => [p, realLocation(p)])
  if (denied.some((d) => isInside(real, d))) {
    throw new PathError(`path is in a protected location: ${rawPath}`, rawPath)
  }

  if (mustExist && !existsSync(real)) {
    throw new PathError(`not found: ${rawPath} does not exist`, rawPath)
  }

  if (ctx.sandbox && mustExist && !ctx.sandbox.canRead(real)) {
    throw new PathError(`sandbox policy does not permit reading ${rawPath}`, rawPath)
  }

  return real
}

/**
 * The path with every existing symlink resolved. The tail that does not exist
 * yet (a file about to be created) is appended unchanged, so this works for
 * writes as well as reads.
 */
export function realLocation(path: string): string {
  let existing = resolve(path)
  const tail: string[] = []
  while (!existsSync(existing)) {
    const parent = resolve(existing, '..')
    if (parent === existing) return resolve(path)
    tail.unshift(existing.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)))
    existing = parent
  }
  try {
    return join(realpathSync(existing), ...tail)
  } catch {
    return resolve(path)
  }
}

/** True when `child` is `parent` or lives under it. */
export function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child))
  if (rel === '') return true
  // `..foo` is a legitimate directory name; only `..` and `../x` escape.
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** Present an absolute path back to the user the way they typed it. */
export function toDisplayPath(absPath: string, workspaceRoot: string): string {
  const rel = relative(workspaceRoot, absPath)
  if (rel === '') return '.'
  if (rel === '..' || rel.startsWith(`..${sep}`)) return absPath
  return rel.split(sep).join('/')
}

export function toPosix(path: string): string {
  return path.split(sep).join('/')
}
