import type { Dirent } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { Tool, ToolResult } from '../types.js'
import { fail, ok } from '../types.js'
import { PathError, resolvePath, toDisplayPath } from './paths.js'

const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'target',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.turbo',
  '.cache',
  'coverage',
  '.gradle',
  '.idea',
  '.vscode-test',
])

const listSchema = z.object({
  path: z.string().optional().describe('Directory to list. Defaults to the workspace root.'),
  depth: z.number().int().min(1).max(4).optional().describe('Recursion depth, 1-4. Default 1.'),
  limit: z.number().int().min(1).max(2000).optional().describe('Max entries. Default 200.'),
  show_hidden: z.boolean().optional().describe('Include dotfiles. Default true for the top level.'),
})

export const listDirectoryTool: Tool<typeof listSchema> = {
  name: 'list_directory',
  description:
    'List the contents of a directory. Set `depth` to explore a tree. Build outputs, dependency directories and .git are skipped by default to keep output small.',
  inputSchema: listSchema,
  readOnly: true,
  category: 'filesystem',

  plan(input, ctx) {
    const abs = safeResolve(input.path ?? '.', ctx)
    return {
      tool: this.name,
      input,
      readPaths: [abs],
      cwd: ctx.cwd,
      purpose: `list ${input.path ?? '.'}`,
    }
  },

  async execute(input, ctx): Promise<ToolResult> {
    let root: string
    try {
      root = resolvePath(input.path ?? '.', ctx, { mustExist: true })
    } catch (err) {
      return fail(err instanceof PathError ? err.message : String(err), `list ${input.path ?? '.'}`)
    }

    const stats = await stat(root).catch(() => null)
    if (!stats?.isDirectory()) return fail(`${input.path ?? '.'} is not a directory.`, 'list')

    const maxDepth = input.depth ?? 1
    const limit = input.limit ?? 200
    const showHidden = input.show_hidden ?? true
    const entries: string[] = []
    let truncated = false
    let dirsSeen = 0
    let filesSeen = 0

    const walk = async (dir: string, depth: number, prefix: string): Promise<void> => {
      if (depth > maxDepth || entries.length >= limit) {
        truncated = true
        return
      }
      let items: Dirent[]
      try {
        items = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      // Directories first, then alphabetical — matches how humans scan a tree.
      items.sort((a, b) => {
        const aDir = a.isDirectory() ? 0 : 1
        const bDir = b.isDirectory() ? 0 : 1
        return aDir - bDir || a.name.localeCompare(b.name)
      })

      for (const item of items) {
        if (entries.length >= limit) {
          truncated = true
          return
        }
        if (!showHidden && item.name.startsWith('.')) continue
        if (IGNORED_DIRS.has(item.name) && item.name !== '.git') continue

        const full = join(dir, item.name)
        if (item.isDirectory()) {
          dirsSeen++
          entries.push(`${prefix}${item.name}/`)
          await walk(full, depth + 1, `${prefix}  `)
        } else {
          filesSeen++
          const size = await stat(full)
            .then((s) => s.size)
            .catch(() => 0)
          entries.push(`${prefix}${item.name}${formatSize(size)}`)
        }
      }
    }

    await walk(root, 1, '')

    const header = toDisplayPath(root, ctx.workspaceRoot) || '.'
    const body = entries.join('\n') || '(empty)'
    const footer = truncated
      ? `\n\n[Truncated at ${limit} entries. Narrow the path or raise depth.]`
      : ''

    return ok(
      `${header}\n${body}${footer}`,
      `list ${header} (${dirsSeen} dirs, ${filesSeen} files)`,
      { root, dirs: dirsSeen, files: filesSeen, truncated },
    )
  },
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return ''
  if (bytes < 1024 * 1024) return ` (${Math.round(bytes / 1024)}K)`
  return ` (${(bytes / (1024 * 1024)).toFixed(1)}M)`
}

function safeResolve(path: string, ctx: { workspaceRoot: string }): string {
  const expanded = isAbsolute(path) ? resolve(path) : resolve(ctx.workspaceRoot, path)
  return expanded.split(sep).join('/')
}

// ---------------------------------------------------------------------------
// glob
// ---------------------------------------------------------------------------

const globSchema = z.object({
  pattern: z
    .string()
    .describe('Glob pattern relative to `path`, e.g. `src/**/*.ts` or `**/*.test.ts`.'),
  path: z.string().optional().describe('Directory to search from. Defaults to the workspace root.'),
  limit: z.number().int().min(1).max(1000).optional().describe('Max results. Default 200.'),
})

export const globTool: Tool<typeof globSchema> = {
  name: 'glob',
  description:
    'Find files by glob pattern. Supports `**`, `*`, `?`, and `{a,b}` alternation. Results are sorted by modification time, newest first. Use search_text when you need matching *lines* rather than filenames.',
  inputSchema: globSchema,
  readOnly: true,
  category: 'search',

  plan(input, ctx) {
    const abs = safeResolve(input.path ?? '.', ctx)
    return {
      tool: this.name,
      input,
      readPaths: [abs],
      cwd: ctx.cwd,
      purpose: `glob ${input.pattern}`,
    }
  },

  async execute(input, ctx): Promise<ToolResult> {
    let root: string
    try {
      root = resolvePath(input.path ?? '.', ctx, { mustExist: true })
    } catch (err) {
      return fail(err instanceof PathError ? err.message : String(err), `glob ${input.pattern}`)
    }

    const limit = input.limit ?? 200
    const regex = globToRegExp(input.pattern)
    const results: { path: string; mtime: number }[] = []

    const walk = async (dir: string): Promise<void> => {
      if (results.length >= limit * 4) return
      const items = await readdir(dir, { withFileTypes: true }).catch(() => null)
      if (!items) return
      for (const item of items) {
        if (item.name === '.git' || IGNORED_DIRS.has(item.name)) continue
        const full = join(dir, item.name)
        if (item.isDirectory()) {
          await walk(full)
        } else {
          const rel = full
            .slice(root.length + 1)
            .split(sep)
            .join('/')
          if (regex.test(rel) || regex.test(item.name)) {
            const mtime = await stat(full)
              .then((s) => s.mtimeMs)
              .catch(() => 0)
            results.push({ path: rel, mtime })
          }
        }
      }
    }

    await walk(root)
    results.sort((a, b) => b.mtime - a.mtime)
    const shown = results.slice(0, limit)
    const base = toDisplayPath(root, ctx.workspaceRoot)

    if (shown.length === 0) {
      return ok(`No files match ${input.pattern} under ${base}.`, `glob: 0 matches`)
    }
    const list = shown.map((r) => r.path).join('\n')
    const more =
      results.length > shown.length ? `\n… ${results.length - shown.length} more matches` : ''
    return ok(
      `${shown.length} match${shown.length === 1 ? '' : 'es'} for ${input.pattern}:\n${list}${more}`,
      `glob ${input.pattern} (${shown.length})`,
      { count: shown.length, total: results.length },
    )
  },
}

/** Translate a glob to an anchored RegExp. `**` crosses directory separators. */
export function globToRegExp(pattern: string): RegExp {
  let out = ''
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` consumes zero or more directories; a bare `**` consumes anything.
        if (pattern[i + 2] === '/') {
          out += '(?:.*/)?'
          i += 2
        } else {
          out += '.*'
          i += 1
        }
      } else {
        out += '[^/]*'
      }
    } else if (ch === '?') {
      out += '[^/]'
    } else if (ch === '{') {
      out += '(?:'
    } else if (ch === '}') {
      out += ')'
    } else if (ch === ',') {
      out += '|'
    } else if ('.+^$()|[]\\'.includes(ch ?? '')) {
      out += `\\${ch}`
    } else {
      out += ch
    }
  }
  return new RegExp(`^${out}$`)
}

// ---------------------------------------------------------------------------
// file_info
// ---------------------------------------------------------------------------

const infoSchema = z.object({
  path: z.string().describe('File or directory to inspect.'),
})

export const fileInfoTool: Tool<typeof infoSchema> = {
  name: 'file_info',
  description:
    'Get metadata for a file: size, type, modified time, and whether it is tracked by git. Use this before overwriting something important.',
  inputSchema: infoSchema,
  readOnly: true,
  category: 'filesystem',

  plan(input, ctx) {
    const abs = safeResolve(input.path, ctx)
    return { tool: this.name, input, readPaths: [abs], cwd: ctx.cwd, purpose: `info ${input.path}` }
  },

  async execute(input, ctx): Promise<ToolResult> {
    let abs: string
    try {
      abs = resolvePath(input.path, ctx, { mustExist: true })
    } catch (err) {
      return fail(err instanceof PathError ? err.message : String(err), `info ${input.path}`)
    }
    const stats = await stat(abs).catch(() => null)
    if (!stats) return fail(`Not found: ${input.path}`, `info ${input.path}`)

    const kind = stats.isDirectory() ? 'directory' : stats.isSymbolicLink() ? 'symlink' : 'file'
    const lines = [
      `path: ${abs}`,
      `type: ${kind}`,
      `size: ${stats.size} bytes`,
      `modified: ${stats.mtime.toISOString()}`,
      `mode: ${(stats.mode & 0o777).toString(8)}`,
    ]
    return ok(lines.join('\n'), `info ${toDisplayPath(abs, ctx.workspaceRoot)}`)
  },
}
