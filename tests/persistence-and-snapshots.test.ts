import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type PersistedSession, SessionPersistence } from '../src/session/persistence.js'
import { SnapshotManager } from '../src/tools/filesystem/snapshots.js'

describe('SnapshotManager', () => {
  let tmp: string
  let manager: SnapshotManager

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'flex-snap-test-'))
    manager = new SnapshotManager(join(tmp, 'snaps'))
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('can undo an edit back to previous content', async () => {
    const file = join(tmp, 'hello.txt')
    await writeFile(file, 'initial content', 'utf8')

    await manager.record(file, 'initial content', 'modified content', 'edit hello.txt')
    await writeFile(file, 'modified content', 'utf8')

    expect(manager.canUndo()).toBe(true)
    const undoRes = await manager.undo()
    expect(undoRes.success).toBe(true)

    const restored = await readFile(file, 'utf8')
    expect(restored).toBe('initial content')

    expect(manager.canRedo()).toBe(true)
    const redoRes = await manager.redo()
    expect(redoRes.success).toBe(true)

    const redone = await readFile(file, 'utf8')
    expect(redone).toBe('modified content')
  })

  it('undoing a newly created file deletes it', async () => {
    const file = join(tmp, 'new.txt')
    await manager.record(file, null, 'fresh content', 'create new.txt')
    await writeFile(file, 'fresh content', 'utf8')

    const undoRes = await manager.undo()
    expect(undoRes.success).toBe(true)
    await expect(readFile(file, 'utf8')).rejects.toThrow()
  })
})

describe('SessionPersistence', () => {
  let tmp: string
  let persistence: SessionPersistence

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'flex-sess-test-'))
    persistence = new SessionPersistence(tmp)
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('saves and loads sessions', async () => {
    const session: PersistedSession = {
      id: 'sess_123',
      version: 1,
      createdAt: 1000,
      updatedAt: 2000,
      workspaceRoot: '/test/workspace',
      model: 'claude-opus-5-5',
      effort: 'high',
      permissionMode: 'auto',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      plan: [{ id: 'p1', text: 'step 1', status: 'active' }],
      changedFiles: ['/test/workspace/file.ts'],
    }

    await persistence.save(session)

    const loaded = await persistence.load('sess_123')
    expect(loaded).not.toBeNull()
    expect(loaded?.id).toBe('sess_123')
    expect(loaded?.messages).toHaveLength(1)
    expect(loaded?.plan).toHaveLength(1)

    const latest = await persistence.findLatest('/test/workspace')
    expect(latest?.id).toBe('sess_123')
  })
})
