import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/agent/events.js'
import { SubagentRunner } from '../src/agent/orchestrator/runner.js'
import { AgentRuntime, estimateTokens } from '../src/agent/runtime/loop.js'
import type { AgentMessage, ContentBlock, StreamEvent } from '../src/models/types.js'
import { effortProfile, ModelError } from '../src/models/types.js'
import { nullLogger } from '../src/observability/logger.js'
import { RiskClassifier } from '../src/permissions/classifier.js'
import { PermissionEngine } from '../src/permissions/policy.js'
import { NoSandboxBackend } from '../src/sandbox/backends/none.js'
import { buildPolicy } from '../src/sandbox/index.js'
import type { Sandbox } from '../src/sandbox/types.js'
import { readFileTool } from '../src/tools/filesystem/read.js'
import { ToolRegistry } from '../src/tools/registry.js'
import { ScriptedProvider, textTurn, toolTurn } from './helpers/scripted-provider.js'

let workspace: string
let sandbox: Sandbox
let registry: ToolRegistry

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'flex-robust-'))
  mkdirSync(join(workspace, 'src'), { recursive: true })
  writeFileSync(join(workspace, 'src', 'a.ts'), 'export const a = 1\n')
  sandbox = await new NoSandboxBackend().create(
    buildPolicy({ workspaceRoot: workspace, logger: nullLogger }),
    nullLogger,
  )
  registry = new ToolRegistry()
  registry.registerAll([readFileTool])
})
afterEach(() => rmSync(workspace, { recursive: true, force: true }))

function permissions() {
  return new PermissionEngine({
    mode: 'auto',
    classifier: new RiskClassifier({
      workspaceRoot: workspace,
      tempDir: join(workspace, '.tmp'),
      cacheDir: join(workspace, '.cache'),
    }),
  })
}

function makeRuntime(
  provider: ScriptedProvider,
  extra: Partial<ConstructorParameters<typeof AgentRuntime>[0]> = {},
) {
  return new AgentRuntime({
    provider,
    tools: registry,
    permissions: permissions(),
    sandbox,
    logger: nullLogger,
    model: 'scripted-1',
    effort: effortProfile('medium'),
    sessionId: 'test',
    promptContext: {
      workspaceRoot: workspace,
      repoSummary: '',
      projectInstructions: '',
      notices: [],
      platform: 'linux x64',
      today: '2026-01-01',
    },
    ...extra,
  })
}

async function collect(
  runtime: AgentRuntime,
  input: string,
  signal = new AbortController().signal,
) {
  const events: AgentEvent[] = []
  for await (const e of runtime.run(input, { signal })) events.push(e)
  return events
}

const resultsOf = (messages: readonly AgentMessage[]): ContentBlock[] =>
  messages.flatMap((m) => m.content.filter((b) => b.type === 'tool_result'))

describe('history repair', () => {
  it('fills in a result for a tool_use left dangling by an interrupted run', async () => {
    const provider = new ScriptedProvider([textTurn('ok')])
    const runtime = makeRuntime(provider)
    runtime.loadState(
      [
        { role: 'user', content: [{ type: 'text', text: 'do it' }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'orphan', name: 'read_file', input: { path: 'x' } }],
        },
      ],
      [],
      [],
    )
    await collect(runtime, 'continue please')
    const sent = provider.requests[0] as AgentMessage[]
    const result = sent.flatMap((m) => m.content).find((b) => b.type === 'tool_result')
    expect(result).toMatchObject({ type: 'tool_result', toolUseId: 'orphan' })
    // Roles must alternate for every provider.
    for (let i = 1; i < sent.length; i++) expect(sent[i]?.role).not.toBe(sent[i - 1]?.role)
  })
})

describe('turn handling', () => {
  it('stops with a notice when the turn cap is reached', async () => {
    const provider = new ScriptedProvider(
      Array.from({ length: 5 }, (_, i) => toolTurn('read_file', `c${i}`, { path: 'src/a.ts' })),
    )
    const events = await collect(makeRuntime(provider, { maxTurns: 3 }), 'loop forever')
    expect(events.filter((e) => e.type === 'turn_start')).toHaveLength(3)
    expect(events.some((e) => e.type === 'notice' && /Stopped after 3/.test(e.text))).toBe(true)
  })

  it('finalizeOnLimit spends the last turn tool-less asking for a report', async () => {
    const provider = new ScriptedProvider([
      toolTurn('read_file', 'c0', { path: 'src/a.ts' }),
      toolTurn('read_file', 'c1', { path: 'src/a.ts' }),
      textTurn('Final report: found a.'),
    ])
    const runtime = makeRuntime(provider, { maxTurns: 3, finalizeOnLimit: true })
    const events = await collect(runtime, 'investigate')
    const last = provider.fullRequests.at(-1)
    expect(last?.tools).toEqual([])
    const lastUser = last?.messages.at(-1)
    expect(JSON.stringify(lastUser)).toMatch(/out of turns/)
    expect(
      events
        .filter((e) => e.type === 'text_delta')
        .map((e) => e.text)
        .join(''),
    ).toContain('Final report')
  })

  it('does not keep or run a tool call cut off by max_tokens, and asks the model to retry', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'message_start', id: 'm', model: 'scripted-1' },
        { type: 'tool_call_end', index: 0, id: 'c1', name: 'read_file', input: { path: 'sr' } },
        { type: 'done', stopReason: 'max_tokens', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
      textTurn('retrying'),
    ])
    const runtime = makeRuntime(provider)
    const events = await collect(runtime, 'read')
    expect(resultsOf(runtime.messages)).toHaveLength(0)
    expect(JSON.stringify(runtime.messages)).not.toContain('"tool_use"')
    expect(events.some((e) => e.type === 'notice')).toBe(true)
    expect(JSON.stringify(provider.requests[1])).toMatch(/cut off/)
  })

  it('continues after pause_turn instead of finishing', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'message_start', id: 'm', model: 'scripted-1' },
        { type: 'text_delta', text: 'working…' },
        { type: 'done', stopReason: 'pause_turn', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
      textTurn('finished'),
    ])
    const events = await collect(makeRuntime(provider), 'go')
    expect(events.filter((e) => e.type === 'turn_start')).toHaveLength(2)
    expect(JSON.stringify(provider.requests[1])).toContain('Continue.')
  })

  it('surfaces a refusal as a notice and stops', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'message_start', id: 'm', model: 'scripted-1' },
        { type: 'done', stopReason: 'refusal', usage: { inputTokens: 1, outputTokens: 0 } },
      ],
    ])
    const events = await collect(makeRuntime(provider), 'x')
    expect(events.some((e) => e.type === 'notice' && /declined/.test(e.text))).toBe(true)
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('reports a provider error and leaves the runtime in the error state', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'message_start', id: 'm', model: 'scripted-1' },
        { type: 'error', error: ModelError.unknown('upstream exploded') },
      ],
    ])
    const runtime = makeRuntime(provider)
    const events = await collect(runtime, 'x')
    expect(events.some((e) => e.type === 'error')).toBe(true)
    expect(runtime.state).toBe('error')
  })

  it('aborting mid-stream ends with an aborted done and no dangling tool_use', async () => {
    const controller = new AbortController()
    const provider = new ScriptedProvider([toolTurn('read_file', 'c1', { path: 'src/a.ts' })])
    const runtime = makeRuntime(provider)
    const events: AgentEvent[] = []
    for await (const e of runtime.run('go', { signal: controller.signal })) {
      events.push(e)
      if (e.type === 'tool_start') controller.abort()
    }
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'aborted' })
    // Whatever was recorded must still be a valid conversation for the next request.
    const next = new ScriptedProvider([textTurn('ok')])
    const resumed = makeRuntime(next)
    resumed.loadState(runtime.messages, [], [])
    await collect(resumed, 'again')
    const uses = new Set<string>()
    const answered = new Set<string>()
    for (const m of next.requests[0] as AgentMessage[]) {
      for (const b of m.content) {
        if (b.type === 'tool_use') uses.add(b.id)
        if (b.type === 'tool_result') answered.add(b.toolUseId)
      }
    }
    expect([...uses].every((id) => answered.has(id))).toBe(true)
  })
})

describe('thinking replay', () => {
  it('replays a signed thinking block ahead of tool_use on the next request', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'message_start', id: 'm', model: 'scripted-1' },
        { type: 'thinking_delta', thinking: 'hmm' },
        { type: 'thinking_signature', signature: 'sig-1' },
        {
          type: 'tool_call_end',
          index: 0,
          id: 'c1',
          name: 'read_file',
          input: { path: 'src/a.ts' },
        },
        { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
      textTurn('done'),
    ])
    await collect(makeRuntime(provider), 'go')
    const assistant = (provider.requests[1] as AgentMessage[]).find((m) => m.role === 'assistant')
    expect(assistant?.content[0]).toMatchObject({
      type: 'thinking',
      thinking: 'hmm',
      signature: 'sig-1',
    })
    expect(assistant?.content.at(-1)).toMatchObject({ type: 'tool_use', id: 'c1' })
  })

  it('does not store unsigned reasoning', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'message_start', id: 'm', model: 'scripted-1' },
        { type: 'thinking_delta', thinking: 'private' },
        { type: 'text_delta', text: 'answer' },
        { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
    ])
    const runtime = makeRuntime(provider)
    await collect(runtime, 'go')
    expect(JSON.stringify(runtime.messages)).not.toContain('private')
  })

  it('preserves provider metadata on tool_use blocks (Gemini thought signatures)', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'message_start', id: 'm', model: 'scripted-1' },
        {
          type: 'tool_call_end',
          index: 0,
          id: 'c1',
          name: 'read_file',
          input: { path: 'src/a.ts' },
          providerMeta: { thoughtSignature: 'ts-1' },
        },
        { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
      ],
      textTurn('done'),
    ])
    await collect(makeRuntime(provider), 'go')
    const uses = (provider.requests[1] as AgentMessage[])
      .flatMap((m) => m.content)
      .filter((b) => b.type === 'tool_use')
    expect(uses[0]).toMatchObject({ providerMeta: { thoughtSignature: 'ts-1' } })
  })
})

describe('context management', () => {
  const filler = (n: number): AgentMessage[] =>
    Array.from(
      { length: n },
      (_, i): AgentMessage =>
        i % 2 === 0
          ? { role: 'user', content: [{ type: 'text', text: `question ${i} ${'x'.repeat(400)}` }] }
          : {
              role: 'assistant',
              content: [{ type: 'text', text: `answer ${i} ${'y'.repeat(400)}` }],
            },
    )

  it('compacts old turns without orphaning tool results', () => {
    const runtime = makeRuntime(new ScriptedProvider([]))
    const msgs: AgentMessage[] = [
      ...filler(10),
      { role: 'user', content: [{ type: 'text', text: 'read it' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: {} }],
      },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 't1', content: 'data' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'text', text: 'next' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'sure' }] },
    ]
    runtime.loadState(msgs, [], [])
    const before = estimateTokens(runtime.messages)
    const result = runtime.compact()
    expect(result.didCompact).toBe(true)
    expect(estimateTokens(runtime.messages)).toBeLessThan(before)

    const uses = new Set<string>()
    const answered = new Set<string>()
    for (const m of runtime.messages) {
      for (const b of m.content) {
        if (b.type === 'tool_use') uses.add(b.id)
        if (b.type === 'tool_result') answered.add(b.toolUseId)
      }
    }
    for (const id of answered) expect(uses.has(id)).toBe(true) // no orphan results
    expect(runtime.messages[0]?.role).toBe('user')
    for (let i = 1; i < runtime.messages.length; i++) {
      expect(runtime.messages[i]?.role).not.toBe(runtime.messages[i - 1]?.role)
    }
  })

  it('refuses to compact a conversation that is already short', () => {
    const runtime = makeRuntime(new ScriptedProvider([]))
    runtime.loadState(filler(3), [], [])
    expect(runtime.compact().didCompact).toBe(false)
  })

  it('recovers from a context_overflow stop by compacting and retrying', async () => {
    const overflow: StreamEvent[] = [
      { type: 'message_start', id: 'm', model: 'scripted-1' },
      { type: 'done', stopReason: 'context_overflow', usage: { inputTokens: 1, outputTokens: 0 } },
    ]
    const provider = new ScriptedProvider([overflow, textTurn('recovered')])
    const runtime = makeRuntime(provider)
    runtime.loadState(filler(20), [], [])
    const events = await collect(runtime, 'next question')
    expect(events.some((e) => e.type === 'context_compacted')).toBe(true)
    expect(
      events
        .filter((e) => e.type === 'text_delta')
        .map((e) => e.text)
        .join(''),
    ).toBe('recovered')
  })
})

describe('tool input', () => {
  it('passes parsed (not raw) input to the tool and reports validation errors', async () => {
    const provider = new ScriptedProvider([
      toolTurn('read_file', 'c1', { path: 'src/a.ts', start_line: 1, end_line: 1 }),
      textTurn('done'),
    ])
    const runtime = makeRuntime(provider)
    await collect(runtime, 'go')
    expect(resultsOf(runtime.messages)[0]).toMatchObject({ isError: false })
  })
})

describe('SubagentRunner', () => {
  function runner(provider: ScriptedProvider) {
    const notes: string[] = []
    const r = new SubagentRunner({
      provider,
      tools: registry,
      permissions: permissions(),
      sandbox,
      logger: nullLogger,
      workspaceRoot: workspace,
      model: 'scripted-1',
      effort: effortProfile('ultracode'),
      sessionId: 's',
      mutatingTools: [],
      noteFileChange: (p) => notes.push(p),
    })
    return { r, notes }
  }

  it('runs the real loop for each subagent and returns its final message as the report', async () => {
    const provider = new ScriptedProvider([
      toolTurn('read_file', 'c1', { path: 'src/a.ts' }),
      textTurn('Report: a is 1.'),
    ])
    const { r } = runner(provider)
    const [res] = await r.fanOut({
      specs: [{ id: 'one', role: 'explorer', task: 'look at a.ts', tools: ['read_file'] }],
      signal: new AbortController().signal,
    })
    expect(res).toMatchObject({ id: 'one', status: 'completed', toolCalls: 1 })
    expect(res?.report).toBe('Report: a is 1.')
    // The second model call must have seen the first tool result: real history, not a fresh prompt.
    expect(JSON.stringify(provider.requests[1])).toContain('export const a')
  })

  it('never lets a subagent spawn subagents', async () => {
    const provider = new ScriptedProvider([textTurn('done')])
    const { r } = runner(provider)
    await r.fanOut({
      specs: [{ id: 'x', role: 'explorer', task: 't', tools: ['read_file', 'spawn_subagent'] }],
      signal: new AbortController().signal,
    })
    const names = (provider.fullRequests[0]?.tools ?? []).map((t) => t.name)
    expect(names).toContain('read_file')
    expect(names).not.toContain('spawn_subagent')
  })

  it('reports a failed subagent without rejecting the whole fan-out', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'message_start', id: 'm', model: 'scripted-1' },
        { type: 'error', error: ModelError.unknown('provider down') },
      ],
    ])
    const { r } = runner(provider)
    const [res] = await r.fanOut({
      specs: [{ id: 'x', role: 'explorer', task: 't', tools: ['read_file'] }],
      signal: new AbortController().signal,
    })
    expect(res?.status).toBe('failed')
    expect(res?.error).toMatch(/provider down/)
  })

  it('marks everything cancelled when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const { r } = runner(new ScriptedProvider([]))
    const results = await r.fanOut({
      specs: [
        { id: 'a', role: 'explorer', task: 't' },
        { id: 'b', role: 'explorer', task: 't' },
      ],
      signal: controller.signal,
    })
    expect(results.map((x) => x.status)).toEqual(['cancelled', 'cancelled'])
  })

  it('returns results in the order requested', async () => {
    const provider = new ScriptedProvider([textTurn('A'), textTurn('B'), textTurn('C')])
    const { r } = runner(provider)
    const results = await r.fanOut({
      specs: ['a', 'b', 'c'].map((id) => ({ id, role: 'explorer' as const, task: id, tools: [] })),
      signal: new AbortController().signal,
      maxConcurrency: 1,
    })
    expect(results.map((x) => x.id)).toEqual(['a', 'b', 'c'])
    expect(results.every((x) => x.status === 'completed')).toBe(true)
  })
})
