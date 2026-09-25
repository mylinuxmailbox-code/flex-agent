import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PlanStep } from '../agent/events.js'
import type { AgentMessage, EffortLevel } from '../models/types.js'
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
  readonly baseDir: string

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(homedir(), '.flex', 'sessions')
  }

  private sessionFile(id: string): string {
    return join(this.baseDir, `${id}.json`)
  }

  async save(session: PersistedSession): Promise<void> {
    try {
      const file = this.sessionFile(session.id)
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, JSON.stringify(session, null, 2), 'utf8')
    } catch (_err) {
      // non-fatal, log or ignore
    }
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
