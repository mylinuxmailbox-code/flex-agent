import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export interface FileSnapshot {
  id: string
  path: string
  timestamp: number
  /** null means file was newly created and did not exist before */
  previousContent: string | null
  /** null means file was deleted */
  newContent: string | null
  summary: string
}

export class SnapshotManager {
  private static instance: SnapshotManager
  private undoStack: FileSnapshot[] = []
  private redoStack: FileSnapshot[] = []
  private baseDir: string

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), '.flex', 'snapshots')
  }

  static get(): SnapshotManager {
    if (!SnapshotManager.instance) {
      SnapshotManager.instance = new SnapshotManager()
    }
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
    this.redoStack = [] // clear redo on new action

    // Optionally persist to disk for forensics
    try {
      const snapFile = join(this.baseDir, `${snapshot.id}.json`)
      await mkdir(dirname(snapFile), { recursive: true })
      await writeFile(snapFile, JSON.stringify(snapshot, null, 2), 'utf8')
    } catch {
      // non-fatal
    }

    return snapshot
  }

  canUndo(): boolean {
    return this.undoStack.length > 0
  }

  canRedo(): boolean {
    return this.redoStack.length > 0
  }

  async undo(): Promise<{ success: boolean; message: string; path?: string }> {
    const snapshot = this.undoStack.pop()
    if (!snapshot) {
      return { success: false, message: 'Nothing to undo.' }
    }

    try {
      if (snapshot.previousContent === null) {
        // Was created; undoing means deleting it
        await rm(snapshot.path, { force: true })
      } else {
        // Restore previous content
        await mkdir(dirname(snapshot.path), { recursive: true })
        await writeFile(snapshot.path, snapshot.previousContent, 'utf8')
      }

      this.redoStack.push(snapshot)
      return {
        success: true,
        message: `Undid ${snapshot.summary} on ${snapshot.path}`,
        path: snapshot.path,
      }
    } catch (err) {
      // Put it back if restore failed
      this.undoStack.push(snapshot)
      return {
        success: false,
        message: `Failed to undo: ${err instanceof Error ? err.message : String(err)}`,
        path: snapshot.path,
      }
    }
  }

  async redo(): Promise<{ success: boolean; message: string; path?: string }> {
    const snapshot = this.redoStack.pop()
    if (!snapshot) {
      return { success: false, message: 'Nothing to redo.' }
    }

    try {
      if (snapshot.newContent === null) {
        // Redoing a delete
        await rm(snapshot.path, { force: true })
      } else {
        // Redoing content write
        await mkdir(dirname(snapshot.path), { recursive: true })
        await writeFile(snapshot.path, snapshot.newContent, 'utf8')
      }

      this.undoStack.push(snapshot)
      return {
        success: true,
        message: `Redid ${snapshot.summary} on ${snapshot.path}`,
        path: snapshot.path,
      }
    } catch (err) {
      this.redoStack.push(snapshot)
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

  clear(): void {
    this.undoStack = []
    this.redoStack = []
  }
}
