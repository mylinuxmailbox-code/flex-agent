import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nullLogger } from '../../src/observability/logger.js'
import { NoSandboxBackend } from '../../src/sandbox/backends/none.js'
import { buildPolicy } from '../../src/sandbox/index.js'
import type { ToolContext, ToolEvent } from '../../src/tools/types.js'

export interface TestWorkspace {
  root: string
  ctx: ToolContext
  events: ToolEvent[]
  changed: string[]
  cleanup(): void
}

/** A real temp workspace plus a ToolContext that allows everything (permissions are tested elsewhere). */
export async function makeWorkspace(overrides: Partial<ToolContext> = {}): Promise<TestWorkspace> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'flex-tools-')))
  const sandbox = await new NoSandboxBackend().create(
    buildPolicy({ workspaceRoot: root, logger: nullLogger }),
    nullLogger,
  )
  const events: ToolEvent[] = []
  const changed: string[] = []
  const ctx: ToolContext = {
    cwd: root,
    workspaceRoot: root,
    permissions: {
      mode: 'auto',
      authorize: async () => ({
        decision: { outcome: 'allow' },
        risk: { level: 'safe', reasons: [], signals: [], irreversible: false, external: false },
        source: 'policy',
      }),
    } as unknown as ToolContext['permissions'],
    sandbox,
    logger: nullLogger,
    sessionId: 'test',
    signal: new AbortController().signal,
    emit: (e) => events.push(e),
    noteFileChange: (p) => changed.push(p),
    ...overrides,
  }
  return {
    root,
    ctx,
    events,
    changed,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}
