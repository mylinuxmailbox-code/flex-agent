import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createTwoFilesPatch, diffLines } from 'diff'
import { z } from 'zod'
import type { Tool, ToolResult } from '../types.js'
import { errorResult, fail, ok } from '../types.js'
import { readTextForSnapshot } from './mutate.js'
import { PathError, resolvePath, toDisplayPath } from './paths.js'
import { SnapshotManager } from './snapshots.js'

const MAX_DIFF_LINES = 200

const inputSchema = z.object({
  path: z.string().describe('File to modify.'),
  old_string: z
    .string()
    .describe(
      'Exact text to replace, including whitespace. Must match the file byte for byte and appear exactly once unless `replace_all` is set.',
    ),
  new_string: z.string().describe('Replacement text. Pass an empty string to delete `old_string`.'),
  replace_all: z
    .boolean()
    .optional()
    .describe('Replace every occurrence instead of requiring a unique match. Default false.'),
})

export const editFileTool: Tool<typeof inputSchema> = {
  name: 'edit_file',
  description:
    'Replace an exact string in a file. `old_string` must match the file exactly and be unique unless `replace_all` is true. This is the preferred way to modify existing code: it cannot clobber surrounding lines the way a full rewrite can. Returns a diff of what changed.',
  inputSchema,
  readOnly: false,
  category: 'filesystem',
  promptGuidance: [
    'Prefer edit_file over write_file for existing files. It is surgical and leaves unrelated lines untouched.',
    'Read the file first so old_string is exact, including indentation. A failed match usually means stale context, not a bug in the tool.',
    'Do not include line numbers in old_string — they are display-only.',
  ].join(' '),

  plan(input, ctx) {
    let abs = input.path
    try {
      abs = resolvePath(input.path, ctx)
    } catch {
      /* classify the raw path when resolution fails */
    }
    return {
      tool: this.name,
      input,
      readPaths: [abs],
      writePaths: [abs],
      cwd: ctx.cwd,
      purpose: `edit ${input.path}`,
    }
  },

  async execute(input, ctx): Promise<ToolResult> {
    let abs: string
    try {
      abs = resolvePath(input.path, ctx, { mustExist: true })
    } catch (err) {
      return fail(err instanceof PathError ? err.message : String(err), `edit ${input.path}`)
    }

    let original: string
    try {
      original = await readFile(abs, 'utf8')
    } catch (err) {
      return errorResult(err, `edit ${input.path}`)
    }

    if (input.old_string === input.new_string) {
      return fail('old_string and new_string are identical — nothing to do.', `edit ${input.path}`)
    }

    const occurrences = countOccurrences(original, input.old_string)

    if (occurrences === 0) {
      return fail(
        `old_string was not found in ${input.path}. It must match exactly, including indentation and line endings. ` +
          `Re-read the file to get the current text, then retry.`,
        `edit ${input.path} (no match)`,
      )
    }
    if (occurrences > 1 && !input.replace_all) {
      const lines = lineNumbersOf(original, input.old_string)
      return fail(
        `old_string is not unique — it appears ${occurrences} times in ${input.path} (at lines ${lines.join(', ')}). ` +
          `Add more surrounding context to make it unique, or set replace_all: true.`,
        `edit ${input.path} (ambiguous)`,
      )
    }

    const updated = input.replace_all
      ? original.split(input.old_string).join(input.new_string)
      : // A function, so `$&`, `$1` and friends in new_string stay literal text.
        original.replace(input.old_string, () => input.new_string)

    try {
      await SnapshotManager.get().record(abs, original, updated, `edit ${input.path}`)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, updated, 'utf8')
    } catch (err) {
      return errorResult(err, `edit ${input.path}`)
    }

    ctx.noteFileChange(abs)
    const display = toDisplayPath(abs, ctx.workspaceRoot)
    ctx.emit({ type: 'diff', path: abs, diff: unifiedDiff(input.path, original, updated) })

    const changeCount = occurrences === 1 ? 1 : occurrences
    return ok(
      `Edited ${input.path} (${changeCount} replacement${changeCount === 1 ? '' : 's'}).\n\n` +
        renderDiff(input.path, original, updated),
      `edit ${display}`,
      { path: abs, replacements: changeCount },
    )
  },
}

/** Overlapping occurrences must not double-count. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') return 0
  let count = 0
  let index = haystack.indexOf(needle)
  const step = Math.max(1, needle.length)
  while (index !== -1) {
    count++
    index = haystack.indexOf(needle, index + step)
  }
  return count
}

function lineNumbersOf(haystack: string, needle: string): number[] {
  const lines: number[] = []
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    lines.push(haystack.slice(0, index).split('\n').length)
    index = haystack.indexOf(needle, index + Math.max(1, needle.length))
  }
  return lines.slice(0, 10)
}

function unifiedDiff(path: string, before: string, after: string): string {
  const patch = createTwoFilesPatch(`a/${path}`, `b/${path}`, before, after, '', '', { context: 3 })
  const lines = patch.replace(/^Index: .*\n=+\n/, '').split('\n')
  if (lines.length <= MAX_DIFF_LINES) return lines.join('\n')
  return `${lines.slice(0, MAX_DIFF_LINES).join('\n')}\n… diff truncated after ${MAX_DIFF_LINES} lines\n`
}

function renderDiff(path: string, before: string, after: string): string {
  const changes: string[] = []
  let removed = 0
  let added = 0
  for (const part of diffLines(before, after)) {
    const value = part.value.replace(/\n$/, '')
    if (part.added) {
      added++
      changes.push(`+ ${value}`)
    } else if (part.removed) {
      removed++
      changes.push(`- ${value}`)
    }
  }
  const body = changes.slice(0, 60).join('\n')
  const more = changes.length > 60 ? `\n… ${changes.length - 60} more changed lines` : ''
  return `${path}: +${added} -${removed}\n${body}${more}`
}

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

const writeSchema = z.object({
  path: z.string().describe('File to create or overwrite.'),
  content: z.string().describe('Full file content.'),
})

export const writeFileTool: Tool<typeof writeSchema> = {
  name: 'write_file',
  description:
    'Create a new file, or completely replace an existing one. Prefer edit_file when modifying part of an existing file — this overwrites everything, so reading first is essential when the file already exists.',
  inputSchema: writeSchema,
  readOnly: false,
  category: 'filesystem',

  plan(input, ctx) {
    let abs = input.path
    const existed = false
    try {
      abs = resolvePath(input.path, ctx)
    } catch {
      /* classify the raw path when resolution fails */
    }
    return {
      tool: this.name,
      input,
      writePaths: [abs],
      readPaths: [],
      cwd: ctx.cwd,
      purpose: `${existed ? 'replace' : 'create'} ${input.path}`,
    }
  },

  async execute(input, ctx): Promise<ToolResult> {
    let abs: string
    try {
      abs = resolvePath(input.path, ctx)
    } catch (err) {
      return fail(err instanceof PathError ? err.message : String(err), `write ${input.path}`)
    }

    const existed = await stat(abs)
      .then((s) => s.isFile())
      .catch(() => false)
    // null for a binary or oversized file: replacing it is allowed but cannot be undone.
    const before = existed ? await readTextForSnapshot(abs) : null
    const undoable = !existed || before !== null

    try {
      if (undoable) {
        await SnapshotManager.get().record(
          abs,
          existed ? before : null,
          input.content,
          `${existed ? 'replace' : 'create'} ${input.path}`,
        )
      }
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, input.content, 'utf8')
    } catch (err) {
      return errorResult(err, `write ${input.path}`)
    }

    ctx.noteFileChange(abs)
    const display = toDisplayPath(abs, ctx.workspaceRoot)
    if (existed && before !== null) {
      ctx.emit({ type: 'diff', path: abs, diff: unifiedDiff(input.path, before, input.content) })
    }

    const bytes = Buffer.byteLength(input.content, 'utf8')
    return ok(
      `${existed ? 'Replaced' : 'Created'} ${input.path} (${input.content.split('\n').length} lines, ${bytes} bytes).${undoable ? '' : ' The previous content was binary or too large to snapshot, so /undo cannot restore it.'}`,
      `${existed ? 'replace' : 'create'} ${display}`,
      { path: abs, created: !existed, bytes },
    )
  },
}
