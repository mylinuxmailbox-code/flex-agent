import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { PlanStep } from '../agent/events.js'
import type { AgentMessage, EffortLevel } from '../models/types.js'
import { flexHome } from '../paths.js'
import type { PermissionMode } from '../permissions/types.js'

export interface PersistedSession {
  id: string
  version: 1
  createdAt: number
  updatedAt: number
  workspaceRoot: string
  model: string
  effort: EffortLevel
  permissionMode: PermissionMode
  messages: AgentMessage[]
  plan: PlanStep[]
  changedFiles: string[]
  metadata?: Record<string, unknown>
}

export class SessionPersistence {
  readonly #baseDir: string | undefined
  /** Saves are serialised per session so two quick turns cannot interleave writes. */
  readonly #queue = new Map<string, Promise<void>>()
  /** Called when a save fails. Persistence must never crash a turn, but it must not be silent. */
  onError: ((error: unknown) => void) | undefined

  constructor(baseDir?: string) {
    this.#baseDir = baseDir
  }

  /** Resolved on every use so `FLEX_HOME` set after import is honoured. */
  get baseDir(): string {
    return this.#baseDir ?? join(flexHome(), 'sessions')
  }

  private sessionFile(id: string): string {
    // Ids come from us, but a resumed file name is user-influenced.
    return join(this.baseDir, `${id.replace(/[^\w.-]/g, '_')}.json`)
  }

  save(session: PersistedSession): Promise<void> {
    const previous = this.#queue.get(session.id) ?? Promise.resolve()
    const next = previous.then(() => this.#write(session))
    this.#queue.set(session.id, next)
    void next.finally(() => {
      if (this.#queue.get(session.id) === next) this.#queue.delete(session.id)
    })
    return next
  }

  async #write(session: PersistedSession): Promise<void> {
    try {
      const file = this.sessionFile(session.id)
      await mkdir(dirname(file), { recursive: true, mode: 0o700 })
      // Write-then-rename so a crash mid-write cannot leave a truncated session.
      const tmp = `${file}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(session), { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, file)
    } catch (err) {
      this.onError?.(err)
    }
  }

  /** Delete sessions beyond `keep` most recent, and any older than `maxAgeDays`. */
  async prune(options: { keep?: number; maxAgeDays?: number } = {}): Promise<number> {
    const keep = options.keep ?? 200
    const cutoff = Date.now() - (options.maxAgeDays ?? 90) * 86_400_000
    const all = await this.list()
    let removed = 0
    for (const [index, session] of all.entries()) {
      if (index >= keep || session.updatedAt < cutoff) {
        if (await this.delete(session.id)) removed++
      }
    }
    return removed
  }

  async load(id: string): Promise<PersistedSession | null> {
    try {
      const file = this.sessionFile(id)
      const data = await readFile(file, 'utf8')
      return JSON.parse(data) as PersistedSession
    } catch {
      return null
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      await rm(this.sessionFile(id), { force: true })
      return true
    } catch {
      return false
    }
  }

  async list(workspaceRoot?: string): Promise<PersistedSession[]> {
    try {
      await mkdir(this.baseDir, { recursive: true })
      const entries = await readdir(this.baseDir)
      const sessions: PersistedSession[] = []

      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue
        try {
          const content = await readFile(join(this.baseDir, entry), 'utf8')
          const parsed = JSON.parse(content) as PersistedSession
          if (!workspaceRoot || parsed.workspaceRoot === workspaceRoot) {
            sessions.push(parsed)
          }
        } catch {
          // ignore corrupted files
        }
      }

      return sessions.sort((a, b) => b.updatedAt - a.updatedAt)
    } catch {
      return []
    }
  }

  async findLatest(workspaceRoot?: string): Promise<PersistedSession | null> {
    const sessions = await this.list(workspaceRoot)
    return sessions[0] ?? null
  }
}

export const sessionPersistence = new SessionPersistence()
