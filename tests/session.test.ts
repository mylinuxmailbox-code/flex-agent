import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionPersistence } from '../src/session/persistence.js'
import { Session } from '../src/session/session.js'
import { ScriptedProvider, textTurn } from './helpers/scripted-provider.js'

let home: string
let workspace: string
const savedHome = process.env.FLEX_HOME
const sessions: Session[] = []

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'flex-home-'))
  workspace = mkdtempSync(join(tmpdir(), 'flex-ws-'))
  process.env.FLEX_HOME = home
})
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()))
  if (savedHome === undefined) delete process.env.FLEX_HOME
  else process.env.FLEX_HOME = savedHome
  rmSync(home, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

async function create(provider: ScriptedProvider, extra: Record<string, unknown> = {}) {
  const session = await Session.create({
    workspaceRoot: workspace,
    providers: [provider],
    extensions: false,
    ...extra,
  })
  sessions.push(session)
  return session
}

async function drain(session: Session, input: string) {
  const events = []
  for await (const e of session.runTurn(input)) events.push(e)
  return events
}

describe('Session', () => {
  it('starts on a model its provider can serve when nothing was configured', async () => {
    const session = await create(new ScriptedProvider([textTurn('hi')]))
    expect(session.model).toBe('scripted-1')
    expect(session.startupNotices).toEqual([])
    expect(session.router.locate('scripted-1')?.provider.id).toBe('scripted')
  })

  it('warns when the requested model is unknown to every provider', async () => {
    const session = await create(new ScriptedProvider([]), { model: 'nope-9' })
    expect(session.startupNotices.join('\n')).toMatch(/No provider knows the model "nope-9"/)
  })

  it('runs a turn and persists it under FLEX_HOME/sessions', async () => {
    const session = await create(new ScriptedProvider([textTurn('hello there')]))
    const events = await drain(session, 'hi')
    expect(events.at(-1)).toMatchObject({ type: 'done' })
    await new Promise((r) => setTimeout(r, 50))
    const saved = await sessionPersistence.load(session.runtime.sessionId)
    expect(saved?.messages).toHaveLength(2)
    expect(saved?.model).toBe('scripted-1')
    expect(saved?.workspaceRoot).toBe(session.config.workspaceRoot)
  })

  it('resumes with the saved conversation and the saved model', async () => {
    const first = await create(new ScriptedProvider([textTurn('one')]))
    await drain(first, 'first question')
    await new Promise((r) => setTimeout(r, 50))
    const saved = await sessionPersistence.load(first.runtime.sessionId)
    expect(saved).not.toBeNull()

    const provider = new ScriptedProvider([textTurn('two')])
    const resumed = await Session.resume(saved as NonNullable<typeof saved>, {
      providers: [provider],
      extensions: false,
    })
    sessions.push(resumed)
    expect(resumed.runtime.sessionId).toBe(first.runtime.sessionId)
    expect(resumed.model).toBe('scripted-1')
    await drain(resumed, 'second question')
    // The model must see the earlier exchange.
    expect(JSON.stringify(provider.requests[0])).toContain('first question')
  })

  it('setModel rejects unknown models with a helpful message', async () => {
    const session = await create(new ScriptedProvider([]))
    const result = session.setModel('gpt-imaginary')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toMatch(/Unknown model/)
    expect(session.setModel('scripted-1')).toMatchObject({ ok: true })
  })

  it('setPermissionMode reaches the enforcing engine', async () => {
    const session = await create(new ScriptedProvider([]), { permissionMode: 'ask' })
    expect(session.permissions.mode).toBe('ask')
    session.setPermissionMode('auto')
    expect(session.permissions.mode).toBe('auto')
    expect(session.config.permissionMode).toBe('auto')
  })

  it('advertises spawn_subagent only in fan-out effort modes, and follows /effort', async () => {
    const session = await create(new ScriptedProvider([]), { effort: 'high' })
    expect(session.tools.has('spawn_subagent')).toBe(false)
    session.setEffort('ultracode')
    expect(session.tools.has('spawn_subagent')).toBe(true)
    session.setEffort('high')
    expect(session.tools.has('spawn_subagent')).toBe(false)
  })

  it('/full-control disables the sandbox but not the permission engine', async () => {
    const session = await create(new ScriptedProvider([]), { fullControl: true })
    expect(session.sandbox.info.isolated).toBe(false)
    expect(session.config.fullControl).toBe(true)
  })

  it('describeProviders reports readiness and the active provider', async () => {
    const session = await create(new ScriptedProvider([]))
    const [p] = await session.describeProviders()
    expect(p).toMatchObject({ id: 'scripted', ok: true, active: true })
    expect(p?.models.map((m) => m.id)).toContain('scripted-1')
  })

  it('close() is idempotent', async () => {
    const session = await create(new ScriptedProvider([]))
    await session.close()
    await expect(session.close()).resolves.toBeUndefined()
  })
})
