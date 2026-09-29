import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import type { Tool, ToolResult } from '../types.js'
import { errorResult, fail, ok } from '../types.js'
import { PathError, resolvePath, toDisplayPath } from './paths.js'
import { SnapshotManager } from './snapshots.js'

// ---------------------------------------------------------------------------
// move_file
// ---------------------------------------------------------------------------

const moveSchema = z.object({
  from: z.string().describe('Existing file or directory to move.'),
  to: z.string().describe('Destination path. Must not already exist.'),
  overwrite: z
    .boolean()
    .optional()
    .describe('Replace the destination if it exists. Default false.'),
})

export const moveFileTool: Tool<typeof moveSchema> = {
  name: 'move_file',
  description:
    'Move or rename a file or directory. Fails if the destination exists unless `overwrite` is true. Use this instead of shell `mv` so the permission system can see both paths.',
  inputSchema: moveSchema,
  readOnly: false,
  category: 'filesystem',

  plan(input, ctx) {
    let from = input.from
    let to = input.to
    try {
      from = resolvePath(input.from, ctx, { mustExist: true })
      to = resolvePath(input.to, ctx)
    } catch {
      /* classify raw paths when resolution fails */
    }
    return {
      tool: this.name,
      input,
      readPaths: [from],
      writePaths: [from, to],
      cwd: ctx.cwd,
      purpose: `move ${input.from} → ${input.to}`,
      signals: ['destructive-delete'],
    }
  },

  async execute(input, ctx): Promise<ToolResult> {
    let from: string
    let to: string
    try {
      from = resolvePath(input.from, ctx, { mustExist: true })
      to = resolvePath(input.to, ctx)
    } catch (err) {
      return fail(err instanceof PathError ? err.message : String(err), `move ${input.from}`)
    }

    if (from === to) return ok(`${input.from} is already at that path.`, `move ${input.from}`)

    const destinationExists = await stat(to)
      .then(() => true)
      .catch(() => false)
    if (destinationExists && !input.overwrite) {
      return fail(
        `${input.to} already exists. Pass overwrite: true to replace it.`,
        `move ${input.from} (exists)`,
      )
    }

    // Text files are snapshotted so /undo can put them back. The order matters:
    // undo pops newest-first, so removing the new path comes before restoring the old.
    const source = await readTextForSnapshot(from)
    const overwritten = destinationExists ? await readTextForSnapshot(to) : null
    try {
      await mkdir(dirname(to), { recursive: true })
      await rename(from, to)
    } catch (err) {
      return errorResult(err, `move ${input.from}`)
    }
    if (source !== null) {
      const snaps = SnapshotManager.get()
      await snaps.record(from, source, null, `move ${input.from} → ${input.to} (remove old path)`)
      await snaps.record(
        to,
        overwritten,
        source,
        `move ${input.from} → ${input.to} (create new path)`,
      )
    }

    ctx.noteFileChange(from)
    ctx.noteFileChange(to)
    return ok(
      `Moved ${input.from} → ${input.to}`,
      `move ${toDisplayPath(from, ctx.workspaceRoot)} → ${toDisplayPath(to, ctx.workspaceRoot)}`,
      { from, to },
    )
  },
}

// ---------------------------------------------------------------------------
// delete_file
// ---------------------------------------------------------------------------

const deleteSchema = z.object({
  path: z.string().describe('File or directory to delete.'),
  recursive: z
    .boolean()
    .optional()
    .describe('Required to delete a non-empty directory. Default false.'),
})

/**
 * Deleting is the sharpest edge in the filesystem toolset, so `plan` reports it
 * precisely: the classifier sees a `destructive-delete` signal, which is on the
 * never-auto list, which means a prompt — always, including in auto mode.
 */
export const deleteFileTool: Tool<typeof deleteSchema> = {
  name: 'delete_file',
  description:
    'Delete a file or directory. Always requires user approval. Never use this to clean up a file you did not create, and never to make a failing test pass.',
  inputSchema: deleteSchema,
  readOnly: false,
  category: 'filesystem',

  plan(input, ctx) {
    let abs = input.path
    try {
      abs = resolvePath(input.path, ctx)
    } catch {
      /* classify raw path when resolution fails */
    }
    return {
      tool: this.name,
      input,
      readPaths: [],
      writePaths: [abs],
      cwd: ctx.cwd,
      purpose: `delete ${input.path}`,
      // Deleting is never inferable from a path, so the tool says so itself.
      // This is what forces a prompt even in auto mode.
      signals: ['destructive-delete'],
    }
  },

  async execute(input, ctx): Promise<ToolResult> {
    let abs: string
    try {
      abs = resolvePath(input.path, ctx, { mustExist: true })
    } catch (err) {
      return fail(err instanceof PathError ? err.message : String(err), `delete ${input.path}`)
    }

    const stats = await stat(abs).catch(() => null)
    if (!stats) return fail(`Not found: ${input.path}`, `delete ${input.path}`)

    const isDirectory = stats.isDirectory()
    if (isDirectory && !input.recursive) {
      const entries = await readdir(abs).catch(() => ['?'])
      if (entries.length > 0) {
        return fail(
          `${input.path} is a directory and is not empty. ` +
            'Pass recursive: true to delete it and everything inside.',
          `delete ${input.path} (dir)`,
        )
      }
    }

    const display = toDisplayPath(abs, ctx.workspaceRoot)
    try {
      if (!isDirectory) {
        const before = await readTextForSnapshot(abs)
        if (before !== null) {
          await SnapshotManager.get().record(abs, before, null, `delete ${input.path}`)
        }
      }
      await rm(abs, { recursive: isDirectory, force: false })
    } catch (err) {
      return errorResult(err, `delete ${display}`)
    }

    ctx.noteFileChange(abs)
    return ok(
      `Deleted ${input.path}${isDirectory && input.recursive ? ' (recursive; not undoable)' : ''}.`,
      `delete ${display}`,
    )
  },
}

/** Expand `~` and relative segments for a caller that already validated scope. */
export function absolutize(path: string, base: string): string {
  return isAbsolute(path) ? resolve(path) : resolve(base, path)
}

const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024

/**
 * File contents for the undo stack, or null when that would not be faithful:
 * directories, large files, and binaries (a UTF-8 round trip corrupts them).
 */
export async function readTextForSnapshot(path: string): Promise<string | null> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_SNAPSHOT_BYTES) return null
    const buffer = await readFile(path)
    if (buffer.subarray(0, 8192).includes(0)) return null
    return buffer.toString('utf8')
  } catch {
    return null
  }
}
