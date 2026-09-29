import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface FileSnapshot {
  id: string
  path: string
  timestamp: number
  /** null means the file did not exist before */
  previousContent: string | null
  /** null means the file was deleted */
  newContent: string | null
  summary: string
}

export interface UndoResult {
  success: boolean
  message: string
  path?: string
}

/** Enough for a long session; older entries fall off the far end. */
const MAX_HISTORY = 100

/**
 * In-memory undo/redo for file edits made by the agent.
 *
 * Snapshots are deliberately not written to disk: they contain whole file
 * contents (possibly secrets), and an undo stack that outlives the process
 * would promise something Flex does not verify — the file may have changed
 * since. Use git for anything durable.
 *
 * Undo and redo refuse to overwrite a file that has been changed since the
 * recorded edit, so `/undo` cannot silently destroy the user's own work.
 * `force` overrides that check.
 */
export class SnapshotManager {
  private static instance: SnapshotManager
  private undoStack: FileSnapshot[] = []
  private redoStack: FileSnapshot[] = []

  static get(): SnapshotManager {
    if (!SnapshotManager.instance) SnapshotManager.instance = new SnapshotManager()
    return SnapshotManager.instance
  }

  async record(
    path: string,
    previousContent: string | null,
    newContent: string | null,
    summary: string,
  ): Promise<FileSnapshot> {
    const snapshot: FileSnapshot = {
      id: `snap_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      path,
      timestamp: Date.now(),
      previousContent,
      newContent,
      summary,
    }
    this.undoStack.push(snapshot)
    if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift()
    this.redoStack = [] // a new edit invalidates the redo branch
    return snapshot
  }

  canUndo(): boolean {
    return this.undoStack.length > 0
  }

  canRedo(): boolean {
    return this.redoStack.length > 0
  }

  clear(): void {
    this.undoStack = []
    this.redoStack = []
  }

  async undo(options: { force?: boolean } = {}): Promise<UndoResult> {
    const snapshot = this.undoStack.at(-1)
    if (!snapshot) return { success: false, message: 'Nothing to undo.' }

    const drift = await this.#drift(snapshot.path, snapshot.newContent, options.force)
    if (drift) return { success: false, message: drift, path: snapshot.path }

    try {
      await this.#apply(snapshot.path, snapshot.previousContent)
      this.undoStack.pop()
      this.redoStack.push(snapshot)
      return {
        success: true,
        message: `Undid ${snapshot.summary} on ${snapshot.path}`,
        path: snapshot.path,
      }
    } catch (err) {
      return {
        success: false,
        message: `Failed to undo: ${err instanceof Error ? err.message : String(err)}`,
        path: snapshot.path,
      }
    }
  }

  async redo(options: { force?: boolean } = {}): Promise<UndoResult> {
    const snapshot = this.redoStack.at(-1)
    if (!snapshot) return { success: false, message: 'Nothing to redo.' }

    const drift = await this.#drift(snapshot.path, snapshot.previousContent, options.force)
    if (drift) return { success: false, message: drift, path: snapshot.path }

    try {
      await this.#apply(snapshot.path, snapshot.newContent)
      this.redoStack.pop()
      this.undoStack.push(snapshot)
      return {
        success: true,
        message: `Redid ${snapshot.summary} on ${snapshot.path}`,
        path: snapshot.path,
      }
    } catch (err) {
      return {
        success: false,
        message: `Failed to redo: ${err instanceof Error ? err.message : String(err)}`,
        path: snapshot.path,
      }
    }
  }

  history(): readonly FileSnapshot[] {
    return this.undoStack
  }

  /** A message when the file no longer matches what the snapshot expects, else null. */
  async #drift(path: string, expected: string | null, force?: boolean): Promise<string | null> {
    if (force) return null
    let current: string | null
    try {
      current = await readFile(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      current = null
    }
    if (current === expected) return null
    return `${path} has changed since that edit; refusing to overwrite it. Use "/undo force" (or "/redo force") to override.`
  }

  async #apply(path: string, content: string | null): Promise<void> {
    if (content === null) {
      await rm(path, { force: true })
      return
    }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
  }
}
