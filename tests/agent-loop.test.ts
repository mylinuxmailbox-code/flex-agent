import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEvent } from '../src/agent/events.js'
import { AgentRuntime } from '../src/agent/runtime/loop.js'
import type { ModelProvider } from '../src/models/provider.js'
import type {
  AgentMessage,
  ContentBlock,
  ModelInfo,
  ModelRequest,
  ModelResponse,
  StreamEvent,
} from '../src/models/types.js'
import { effortProfile } from '../src/models/types.js'
import { nullLogger } from '../src/observability/logger.js'
import { RiskClassifier } from '../src/permissions/classifier.js'
import { PermissionEngine } from '../src/permissions/policy.js'
import type { PermissionChoice, PermissionPrompt } from '../src/permissions/types.js'
import { NoSandboxBackend } from '../src/sandbox/backends/none.js'
import { buildPolicy } from '../src/sandbox/index.js'
import type { Sandbox } from '../src/sandbox/types.js'
import { editFileTool } from '../src/tools/filesystem/edit.js'
import { deleteFileTool } from '../src/tools/filesystem/mutate.js'
import { readFileTool } from '../src/tools/filesystem/read.js'
import { ToolRegistry } from '../src/tools/registry.js'

/**
 * End-to-end agent loop tests.
 *
 * These drive the real loop with a scripted provider, so the assertions are
 * about behaviour rather than about what a model happened to say: tools are
 * authorized before they run, denials come back as evidence rather than
 * exceptions, malformed arguments are recoverable, and the loop stops when the
 * model stops asking for tools.
 */

class ScriptedProvider implements ModelProvider {
  readonly id = 'scripted'
  readonly label = 'Scripted'
  /** One list of events per turn; consumed in order. */
  readonly turns: StreamEvent[][] = []
  /** Message history as the model saw it, for asserting what it was told. */
  readonly requests: AgentMessage[][] = []
  #turn = 0

  constructor(turns: StreamEvent[][]) {
    this.turns = turns
  }

  async available() {
    return { ok: true }
  }
  listModels(): ModelInfo[] {
    return [
      {
        id: 'scripted-1',
        label: 'Scripted',
        contextWindow: 100_000,
        maxOutputTokens: 4096,
        supportsTools: true,
        supportsThinking: false,
        supportsEffort: false,
        supportsWebSearch: false,
        supportsPromptCaching: false,
      },
    ]
  }
  resolveModel(spec: string) {
    return this.listModels().find((m) => m.id === spec)
  }

  async *stream(request: ModelRequest): AsyncGenerator<StreamEvent> {
    this.requests.push(structuredClone(request.messages))
    const turn = this.turns[this.#turn++] ?? [
      { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } },
    ]
    for (const event of turn) yield event
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const events: StreamEvent[] = []
    for await (const e of this.stream(request)) events.push(e)
    return {
      id: 'x',
      model: 'scripted-1',
      content: [],
      stopReason: 'end_turn',
      usage: { inputTokens: 0, outputTokens: 0 },
    }
  }
}

function toolTurn(name: string, id: string, input: unknown): StreamEvent[] {
  return [
    { type: 'message_start', id: 'msg', model: 'scripted-1' },
    { type: 'text_delta', text: `Calling ${name}.` },
    { type: 'tool_call_start', index: 0, id, name },
    { type: 'tool_call_delta', index: 0, partialJson: JSON.stringify(input) },
    { type: 'tool_call_end', index: 0, id, name, input },
    { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 20 } },
  ]
}

function textTurn(text: string): StreamEvent[] {
  return [
    { type: 'message_start', id: 'msg', model: 'scripted-1' },
    { type: 'text_delta', text },
    { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 120, outputTokens: 30 } },
  ]
}

let workspace: string
let sandbox: Sandbox
let registry: ToolRegistry

function makeRuntime(
  provider: ScriptedProvider,
  prompter?: (p: PermissionPrompt) => PermissionChoice,
) {
  const permissions = new PermissionEngine({
    mode: 'ask',
    autoThreshold: 'low',
    askThreshold: 'low',
    classifier: new RiskClassifier({
      workspaceRoot: workspace,
      tempDir: join(workspace, '.tmp'),
      cacheDir: join(workspace, '.cache'),
    }),
    prompter: prompter ? { prompt: async (p) => prompter(p) } : undefined,
  })

  return new AgentRuntime({
    provider,
    tools: registry,
    permissions,
    sandbox,
    logger: nullLogger,
    model: 'scripted-1',
    effort: effortProfile('medium'),
    sessionId: 'test',
    promptContext: {
      workspaceRoot: workspace,
      repoSummary: 'A test repository.',
      projectInstructions: '',
      notices: [],
      platform: 'linux x64',
      today: '2026-01-01',
    },
  })
}

async function collect(runtime: AgentRuntime, input: string): Promise<AgentEvent[]> {
  const controller = new AbortController()
  const events: AgentEvent[] = []
  for await (const event of runtime.run(input, { signal: controller.signal })) events.push(event)
  return events
}

/** Every tool_result the loop has fed back to the model so far. */
function toolResults(messages: readonly AgentMessage[]): ContentBlock[] {
  return messages.flatMap((m) => m.content.filter((b) => b.type === 'tool_result'))
}

function resultText(block: ContentBlock): string {
  return block.type === 'tool_result' && typeof block.content === 'string' ? block.content : ''
}

beforeEach(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'flex-loop-'))
  mkdirSync(join(workspace, 'src'), { recursive: true })
  writeFileSync(join(workspace, 'src', 'hello.ts'), 'export const greeting = "hi"\n')
  sandbox = await new NoSandboxBackend().create(
    buildPolicy({ workspaceRoot: workspace, logger: nullLogger }),
    nullLogger,
  )
  registry = new ToolRegistry()
  registry.registerAll([readFileTool, editFileTool, deleteFileTool])
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('agent loop', () => {
  it('runs a tool the model asks for and feeds the result back', async () => {
    const provider = new ScriptedProvider([
      toolTurn('read_file', 'call_1', { path: 'src/hello.ts' }),
      textTurn('The file exports a greeting.'),
    ])
    const runtime = makeRuntime(provider)
    const events = await collect(runtime, 'read hello.ts')

    const start = events.find((e) => e.type === 'tool_start')
    const end = events.find((e) => e.type === 'tool_end')
    expect(start).toBeDefined()
    expect(end).toMatchObject({ isError: false })

    const results = toolResults(runtime.messages)
    expect(results).toHaveLength(1)
    expect(resultText(results[0]!)).toContain('export const greeting')
    // The model must be able to see what the tool returned on the next turn.
    expect(provider.requests).toHaveLength(2)
    expect(resultText(toolResults(provider.requests[1]!)[0]!)).toContain('greeting')
  })

  it('streams text deltas as they arrive', async () => {
    const provider = new ScriptedProvider([textTurn('All done.')])
    const runtime = makeRuntime(provider)
    const events = await collect(runtime, 'hi')
    const deltas = events.filter((e) => e.type === 'text_delta')
    expect(deltas).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' })
  })

  it('applies an edit and records the changed file', async () => {
    const provider = new ScriptedProvider([
      toolTurn('edit_file', 'call_1', {
        path: 'src/hello.ts',
        old_string: '"hi"',
        new_string: '"hello"',
      }),
      textTurn('Updated the greeting.'),
    ])
    const runtime = makeRuntime(provider)
    await collect(runtime, 'change the greeting')

    const content = readFileSync(join(workspace, 'src', 'hello.ts'), 'utf8')
    expect(content).toContain('"hello"')
    expect(runtime.changedFiles.some((f) => f.endsWith('hello.ts'))).toBe(true)
  })

  it('returns a readable error instead of throwing when a tool fails', async () => {
    const provider = new ScriptedProvider([
      toolTurn('read_file', 'call_1', { path: 'does/not/exist.ts' }),
      textTurn('That file is not there.'),
    ])
    const runtime = makeRuntime(provider)
    await collect(runtime, 'read a missing file')

    const results = toolResults(runtime.messages)
    expect(resultText(results[0]!)).toMatch(/not found|Error/i)
  })

  it('rejects an unknown tool without stopping the loop', async () => {
    const provider = new ScriptedProvider([
      toolTurn('teleport', 'call_1', { to: 'mars' }),
      textTurn('That tool does not exist.'),
    ])
    const runtime = makeRuntime(provider)
    await collect(runtime, 'teleport me')

    const results = toolResults(runtime.messages)
    expect(resultText(results[0]!)).toContain('Unknown tool')
  })

  it('reports invalid arguments so the model can retry', async () => {
    const provider = new ScriptedProvider([
      toolTurn('read_file', 'call_1', { path: 123, bogus: true }),
      textTurn('Those arguments were wrong.'),
    ])
    const runtime = makeRuntime(provider)
    await collect(runtime, 'read something')

    const results = toolResults(runtime.messages)
    expect(resultText(results[0]!)).toMatch(/invalid arguments/i)
  })

  it('asks for permission before a destructive action and proceeds when allowed', async () => {
    const seen: PermissionPrompt[] = []
    const provider = new ScriptedProvider([
      toolTurn('delete_file', 'call_1', { path: 'src/hello.ts' }),
      textTurn('Deleted it.'),
    ])
    const runtime = makeRuntime(provider, (p) => {
      seen.push(p)
      return 'allow-once'
    })
    await collect(runtime, 'delete hello.ts')

    expect(seen).toHaveLength(1)
    expect(seen[0]?.risk.level).toBe('high')
    expect(seen[0]?.risk.signals).toContain('destructive-delete')
  })

  it('does not execute a denied action and tells the model why', async () => {
    const provider = new ScriptedProvider([
      toolTurn('delete_file', 'call_1', { path: 'src/hello.ts' }),
      textTurn('Understood, leaving it alone.'),
    ])
    const runtime = makeRuntime(provider, () => 'deny')
    const _events = await collect(runtime, 'delete hello.ts')

    // The file must still be there.
    expect(readFileSync(join(workspace, 'src', 'hello.ts'), 'utf8')).toContain('greeting')
    const results = toolResults(runtime.messages)
    expect(resultText(results[0]!)).toMatch(/permission denied/i)
  })

  it('never auto-approves a destructive action even in auto mode', async () => {
    const seen: PermissionPrompt[] = []
    const provider = new ScriptedProvider([
      toolTurn('delete_file', 'call_1', { path: 'src/hello.ts' }),
      textTurn('Done.'),
    ])
    const permissions = new PermissionEngine({
      mode: 'auto',
      autoThreshold: 'critical', // maximally permissive
      classifier: new RiskClassifier({
        workspaceRoot: workspace,
        tempDir: join(workspace, '.tmp'),
        cacheDir: join(workspace, '.cache'),
      }),
      prompter: {
        prompt: async (p) => {
          seen.push(p)
          return 'deny'
        },
      },
    })
    const runtime = new AgentRuntime({
      provider,
      tools: registry,
      permissions,
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
        platform: 'linux',
        today: '2026-01-01',
      },
    })
    await collect(runtime, 'delete hello.ts')

    // `neverAuto` includes destructive-delete, so a critical threshold must
    // still stop and ask. This is the guarantee that makes auto mode safe.
    expect(seen).toHaveLength(1)
    expect(readFileSync(join(workspace, 'src', 'hello.ts'), 'utf8')).toContain('greeting')
  })

  it('runs independent tool calls concurrently and returns all results', async () => {
    writeFileSync(join(workspace, 'src', 'a.ts'), 'export const a = 1\n')
    writeFileSync(join(workspace, 'src', 'b.ts'), 'export const b = 2\n')
    const provider = new ScriptedProvider([
      [
        { type: 'message_start', id: 'm', model: 'scripted-1' },
        { type: 'tool_call_start', index: 0, id: 'c1', name: 'read_file' },
        {
          type: 'tool_call_end',
          index: 0,
          id: 'c1',
          name: 'read_file',
          input: { path: 'src/a.ts' },
        },
        { type: 'tool_call_start', index: 1, id: 'c2', name: 'read_file' },
        {
          type: 'tool_call_end',
          index: 1,
          id: 'c2',
          name: 'read_file',
          input: { path: 'src/b.ts' },
        },
        { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 10, outputTokens: 5 } },
      ],
      textTurn('Both files read.'),
    ])
    const runtime = makeRuntime(provider)
    await collect(runtime, 'read both files')

    const results = toolResults(runtime.messages)
    expect(results).toHaveLength(2)
    expect(resultText(results[0]!) + resultText(results[1]!)).toContain('export const a')
    expect(resultText(results[0]!) + resultText(results[1]!)).toContain('export const b')
  })

  it('stops immediately when the turn is aborted', async () => {
    const provider = new ScriptedProvider([textTurn('never seen')])
    const runtime = makeRuntime(provider)
    const controller = new AbortController()
    controller.abort()
    const events: AgentEvent[] = []
    for await (const event of runtime.run('go', { signal: controller.signal })) events.push(event)
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'aborted' })
  })

  it('refuses to run a tool call truncated by max_tokens', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'message_start', id: 'm', model: 'scripted-1' },
        { type: 'tool_call_start', index: 0, id: 'c1', name: 'delete_file' },
        // partial JSON, never completed
        {
          type: 'tool_call_end',
          index: 0,
          id: 'c1',
          name: 'delete_file',
          input: { __partial: '{"path":"src' },
        },
        { type: 'done', stopReason: 'max_tokens', usage: { inputTokens: 10, outputTokens: 4096 } },
      ],
      textTurn('Let me retry that.'),
    ])
    const runtime = makeRuntime(provider, () => 'allow-once')
    await collect(runtime, 'delete')

    // The file survives: truncated input never reaches execution.
    expect(readFileSync(join(workspace, 'src', 'hello.ts'), 'utf8')).toContain('greeting')
  })
})
