import { execa } from 'execa'
import { z } from 'zod'
import type { Tool, ToolResult } from '../types.js'
import { fail, ok } from '../types.js'

/**
 * Read-only git views.
 *
 * Mutation commands (add, commit, push, branch, rebase) are deliberately not
 * exposed as tools in this first cut. The agent can still run them through
 * `run_command`, where the risk classifier sees the full command text and
 * applies its git rules. A structured `commit` tool would bypass command
 * pattern matching and silently widen what auto mode allows.
 */

const GIT_TIMEOUT = 15_000

async function git(cwd: string, args: string[], signal?: AbortSignal) {
  return execa('git', args, {
    cwd,
    signal,
    timeout: GIT_TIMEOUT,
    reject: false,
    maxBuffer: 16 * 1024 * 1024,
  })
}

// --- status ----------------------------------------------------------------

const statusSchema = z.object({
  path: z.string().optional().describe('Limit to a path. Defaults to the whole repository.'),
})

export const gitStatusTool: Tool<typeof statusSchema> = {
  name: 'git_status',
  description:
    'Show the working-tree status: which files are modified, staged, untracked, or conflicted. Run this before making changes so you do not disturb work that was already in progress.',
  inputSchema: statusSchema,
  readOnly: true,
  category: 'git',
  promptGuidance:
    'Check git status before editing. If files are already modified and are not yours, do not revert or reformat them.',

  plan(input, ctx) {
    return { tool: this.name, input, cwd: ctx.workspaceRoot, purpose: 'git status' }
  },

  async execute(input, ctx): Promise<ToolResult> {
    const args = ['status', '--porcelain=v1', '--branch']
    if (input.path) args.push('--', input.path)
    const result = await git(ctx.workspaceRoot, args, ctx.signal)
    if (result.exitCode !== 0) {
      return fail(`git status failed: ${result.stderr || 'not a git repository'}`, 'git status')
    }
    const output = result.stdout.trim()
    if (!output) return ok('Working tree is clean.', 'git status (clean)')

    const lines = output.split('\n')
    const branch = lines[0]?.replace(/^##\s*/, '').split('...')[0] ?? 'unknown'
    const changes = lines.slice(1).map((line) => {
      const code = line.slice(0, 2)
      const path = line.slice(3)
      const label =
        {
          '??': 'untracked',
          M: 'modified',
          A: 'added',
          D: 'deleted',
          R: 'renamed',
          C: 'copied',
          U: 'conflicted',
        }[code.trim().replace(/[^MADRCU]/g, '')] ?? 'changed'
      return `  ${label.padEnd(10)} ${path}`
    })

    return ok(
      `Branch: ${branch}\n${changes.length} change(s):\n${changes.join('\n')}`,
      `git status (${changes.length} changed)`,
    )
  },
}

// --- diff ------------------------------------------------------------------

const diffSchema = z.object({
  path: z.string().optional().describe('Limit the diff to a path.'),
  staged: z.boolean().optional().describe('Show staged changes instead of unstaged ones.'),
  stat: z.boolean().optional().describe('Return a summary instead of the full diff.'),
  context_lines: z
    .number()
    .int()
    .min(0)
    .max(20)
    .optional()
    .describe('Lines of context around each hunk. Default 3.'),
})

export const gitDiffTool: Tool<typeof diffSchema> = {
  name: 'git_diff',
  description:
    'Show the current diff. Use `stat: true` for a summary, and `path` to focus on one file. This is how you confirm that your change did exactly what you intended and nothing else.',
  inputSchema: diffSchema,
  readOnly: true,
  category: 'git',

  plan(input, ctx) {
    return {
      tool: this.name,
      input,
      readPaths: input.path ? [input.path] : [],
      cwd: ctx.workspaceRoot,
      purpose: 'git diff',
    }
  },

  async execute(input, ctx): Promise<ToolResult> {
    const args = ['diff']
    if (input.staged) args.push('--staged')
    if (input.stat) args.push('--stat')
    else args.push(`--unified=${input.context_lines ?? 3}`)
    if (input.path) args.push('--', input.path)

    const result = await git(ctx.workspaceRoot, args, ctx.signal)
    if (result.exitCode !== 0) {
      return fail(`git diff failed: ${result.stderr || 'not a git repository'}`, 'git diff')
    }
    const diff = result.stdout
    if (!diff.trim()) {
      return ok(input.staged ? 'No staged changes.' : 'No unstaged changes.', 'git diff (empty)')
    }

    if (input.stat) {
      return ok(diff.trim(), 'git diff --stat')
    }

    // A full diff of a large change is context poison; summarise and point at
    // the file rather than pasting thousands of lines into the conversation.
    const MAX_DIFF_LINES = 400
    const lines = diff.split('\n')
    if (lines.length > MAX_DIFF_LINES) {
      const files = [...new Set(diff.matchAll(/^\+\+\+ b\/(.*)$/gm))]
        .map((m) => m[1])
        .filter(Boolean)
      return {
        content:
          `Diff is ${lines.length} lines across ${files.length} file(s): ${files.slice(0, 20).join(', ')}\n\n` +
          `First ${MAX_DIFF_LINES} lines:\n${lines.slice(0, MAX_DIFF_LINES).join('\n')}\n` +
          `\n[diff truncated — use git_diff with path: to see a specific file]`,
        display: `git diff (${lines.length} lines, ${files.length} files)`,
        metadata: { files, truncated: true },
      }
    }

    return ok(diff, `git diff (${lines.length} lines)`)
  },
}

// --- log -------------------------------------------------------------------

const logSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().describe('Number of commits. Default 20.'),
  path: z.string().optional().describe('Only commits touching this path.'),
  oneline: z.boolean().optional().describe('One line per commit. Default true.'),
})

export const gitLogTool: Tool<typeof logSchema> = {
  name: 'git_log',
  description:
    "Show recent commit history. Use it to learn the project's commit conventions and to find when something changed.",
  inputSchema: logSchema,
  readOnly: true,
  category: 'git',

  plan(input, ctx) {
    return { tool: this.name, input, cwd: ctx.workspaceRoot, purpose: 'git log' }
  },

  async execute(input, ctx): Promise<ToolResult> {
    const args = ['log', `--max-count=${input.limit ?? 20}`]
    if (input.oneline !== false) args.push('--oneline', '--no-decorate')
    else args.push(`--pretty=format:%h %ad %an%n    %s%n`, '--date=short')
    if (input.path) args.push('--', input.path)

    const result = await git(ctx.workspaceRoot, args, ctx.signal)
    if (result.exitCode !== 0) {
      return fail(`git log failed: ${result.stderr || 'no commits yet'}`, 'git log')
    }
    const output = result.stdout.trim()
    if (!output) return ok('No commits yet.', 'git log (empty)')
    const count = output.split('\n').length
    return ok(output, `git log (${count})`)
  },
}
