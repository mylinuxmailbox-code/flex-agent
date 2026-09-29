import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GoogleProvider, thinkingConfig, toContents } from '../src/models/google.js'
import { OpenAICompatibleProvider, toOpenAIMessages } from '../src/models/openai-compatible.js'
import { collectStream } from '../src/models/provider.js'
import { buildProviders, pickDefaultModel } from '../src/models/registry.js'
import { ProviderRouter } from '../src/models/router.js'
import { toGeminiSchema } from '../src/models/schema.js'
import { readSSE } from '../src/models/sse.js'
import { buildToolNameMap } from '../src/models/tool-names.js'
import type { AgentMessage, ModelRequest, StreamEvent } from '../src/models/types.js'
import { json, type MockServer, sse, startMockServer } from './helpers/mock-server.js'

const baseRequest = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: 'test-model',
  system: { text: 'You are Flex.' },
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [],
  ...over,
})

const readTool = {
  name: 'read_file',
  description: 'Read a file',
  inputSchema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
}

async function drain(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = []
  for await (const e of events) out.push(e)
  return out
}

// ---------------------------------------------------------------------------
// OpenAI-compatible
// ---------------------------------------------------------------------------

describe('OpenAICompatibleProvider (real SDK against a local server)', () => {
  let server: MockServer
  beforeAll(async () => {
    server = await startMockServer()
  })
  afterAll(() => server.close())

  const make = (extra = {}) =>
    new OpenAICompatibleProvider({
      baseURL: `${server.url}/v1`,
      apiKey: 'sk-test',
      maxRetries: 0,
      ...extra,
    })

  const chunk = (delta: unknown, finish: string | null = null) => ({
    id: 'c1',
    object: 'chat.completion.chunk',
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: finish }],
  })

  it('streams text and reports usage from the trailing empty-choices chunk', async () => {
    server.handle((_req, res) =>
      sse(
        res,
        [
          chunk({ role: 'assistant', content: 'Hel' }),
          chunk({ content: 'lo' }),
          chunk({}, 'stop'),
          { id: 'c1', choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } },
        ],
        { done: true },
      ),
    )
    const response = await make().complete(baseRequest())
    expect(response.content).toEqual([{ type: 'text', text: 'Hello' }])
    expect(response.stopReason).toBe('end_turn')
    expect(response.usage).toMatchObject({ inputTokens: 11, outputTokens: 3 })

    const req = server.requests.at(-1)!
    expect(req.url).toBe('/v1/chat/completions')
    expect(req.headers.authorization).toBe('Bearer sk-test')
    const body = req.body as Record<string, unknown>
    // Non-OpenAI hosts get `max_tokens`, and usage must be requested explicitly.
    expect(body.max_tokens).toBeDefined()
    expect(body.max_completion_tokens).toBeUndefined()
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('reassembles interleaved parallel tool calls by index', async () => {
    server.handle((_req, res) =>
      sse(
        res,
        [
          chunk({
            tool_calls: [
              { index: 0, id: 'call_a', function: { name: 'read_file', arguments: '' } },
            ],
          }),
          chunk({
            tool_calls: [
              { index: 1, id: 'call_b', function: { name: 'read_file', arguments: '' } },
            ],
          }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
          chunk({ tool_calls: [{ index: 1, function: { arguments: '{"path":"b.ts"}' } }] }),
          chunk({ tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] }),
          // Servers sometimes say `stop` even though calls were streamed.
          chunk({}, 'stop'),
        ],
        { done: true },
      ),
    )
    const response = await make().complete(baseRequest({ tools: [readTool] }))
    const uses = response.content.filter((b) => b.type === 'tool_use')
    expect(uses).toEqual([
      { type: 'tool_use', id: 'call_a', name: 'read_file', input: { path: 'a.ts' } },
      { type: 'tool_use', id: 'call_b', name: 'read_file', input: { path: 'b.ts' } },
    ])
    expect(response.stopReason).toBe('tool_use')

    const body = server.requests.at(-1)!.body as {
      tools: Array<{ function: { parameters: Record<string, unknown> } }>
    }
    expect(body.tools[0]?.function.parameters.$schema).toBeUndefined()
  })

  it('surfaces malformed tool JSON as an argument error instead of throwing', async () => {
    server.handle((_req, res) =>
      sse(res, [
        chunk({
          tool_calls: [
            { index: 0, id: 'x', function: { name: 'read_file', arguments: '{"path": "a' } },
          ],
        }),
        chunk({}, 'tool_calls'),
      ]),
    )
    const response = await make().complete(baseRequest({ tools: [readTool] }))
    const use = response.content.find((b) => b.type === 'tool_use')
    expect(
      use && 'input' in use && (use.input as Record<string, unknown>).__parseError,
    ).toBeTruthy()
  })

  it('does not trust tool calls from a truncated (length) turn', async () => {
    server.handle((_req, res) =>
      sse(res, [
        chunk({
          tool_calls: [{ index: 0, id: 'x', function: { name: 'read_file', arguments: '{"pa' } }],
        }),
        chunk({}, 'length'),
      ]),
    )
    const response = await make().complete(baseRequest({ tools: [readTool] }))
    expect(response.stopReason).toBe('max_tokens')
  })

  it('emits reasoning as thinking and keeps it out of the text', async () => {
    server.handle((_req, res) =>
      sse(res, [chunk({ reasoning_content: 'hmm' }), chunk({ content: 'ok' }), chunk({}, 'stop')]),
    )
    const events = await drain(make().stream(baseRequest()))
    expect(events.find((e) => e.type === 'thinking_delta')).toMatchObject({ thinking: 'hmm' })
    const response = await collectStream(make().stream(baseRequest()))
    expect(response.content.find((b) => b.type === 'text')).toMatchObject({ text: 'ok' })
  })

  it('maps HTTP errors onto ModelError kinds', async () => {
    const cases: Array<[number, string]> = [
      [401, 'auth'],
      [429, 'rate_limit'],
      [503, 'overloaded'],
      [400, 'invalid_request'],
    ]
    for (const [status, kind] of cases) {
      server.handle((_req, res) => json(res, status, { error: { message: `boom ${status}` } }))
      const events = await drain(make().stream(baseRequest()))
      const err = events.find((e) => e.type === 'error')
      expect(err, `status ${status}`).toMatchObject({ error: { kind } })
    }
    server.handle((_req, res) =>
      json(res, 400, {
        error: {
          message: 'maximum context length is 8192 tokens',
          code: 'context_length_exceeded',
        },
      }),
    )
    const events = await drain(make().stream(baseRequest()))
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      error: { kind: 'context_overflow' },
    })
  })

  it('reports an error payload delivered mid-stream', async () => {
    server.handle((_req, res) =>
      sse(res, [chunk({ content: 'a' }), { error: { message: 'upstream died', code: 502 } }]),
    )
    const events = await drain(make().stream(baseRequest()))
    expect(events.find((e) => e.type === 'error')).toMatchObject({ error: { kind: 'overloaded' } })
  })

  it('aborts cleanly when the signal fires', async () => {
    server.handle((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify(chunk({ content: 'x' }))}\n\n`)
      // never ends
    })
    const controller = new AbortController()
    const events: StreamEvent[] = []
    for await (const e of make().stream(baseRequest({ signal: controller.signal }))) {
      events.push(e)
      if (e.type === 'text_delta') controller.abort()
    }
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'aborted' })
  })

  it('uses max_completion_tokens and reasoning_effort for reasoning models when configured', async () => {
    server.handle((_req, res) => sse(res, [chunk({ content: 'ok' }), chunk({}, 'stop')]))
    const provider = make({ maxTokensParam: 'max_completion_tokens', reasoningEffort: true })
    await provider.complete(baseRequest({ model: 'my-reasoner', effort: 'xhigh' }))
    const body = server.requests.at(-1)!.body as Record<string, unknown>
    expect(body.max_completion_tokens).toBeDefined()
    expect(body.max_tokens).toBeUndefined()
    expect(body.reasoning_effort).toBe('high')
  })

  it('never sends reasoning_effort to a model that does not take it', async () => {
    server.handle((_req, res) => sse(res, [chunk({ content: 'ok' }), chunk({}, 'stop')]))
    await make().complete(baseRequest({ model: 'qwen2.5-coder:7b', effort: 'high' }))
    expect(
      (server.requests.at(-1)!.body as Record<string, unknown>).reasoning_effort,
    ).toBeUndefined()
  })

  it('discovers models from /models', async () => {
    server.handle((req, res) =>
      req.url.endsWith('/models')
        ? json(res, 200, {
            object: 'list',
            data: [
              { id: 'llama3.1:8b', object: 'model' },
              { id: 'text-embedding-3', object: 'model' },
            ],
          })
        : json(res, 404, {}),
    )
    const provider = make()
    await provider.refreshModels()
    expect(provider.listModels().map((m) => m.id)).toEqual(['llama3.1:8b'])
    expect((await provider.available()).ok).toBe(true)
  })

  it('is unavailable (with a reason) when the server is unreachable', async () => {
    const dead = new OpenAICompatibleProvider({ baseURL: 'http://127.0.0.1:1/v1', maxRetries: 0 })
    const result = await dead.available()
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('cannot reach')
  })
})

describe('toOpenAIMessages', () => {
  it('keeps free text that shares a turn with tool results, after the results', () => {
    const messages: AgentMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'a' } }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', toolUseId: 't1', content: 'contents' },
          { type: 'text', text: 'Continue.' },
        ],
      },
    ]
    const out = toOpenAIMessages({ system: { text: 's' }, messages })
    expect(out.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user'])
    expect(out[3]).toMatchObject({ tool_call_id: 't1', content: 'contents' })
    expect(out[4]).toMatchObject({ content: 'Continue.' })
  })

  it('marks tool errors so the model can tell them from output', () => {
    const out = toOpenAIMessages({
      system: { text: 's' },
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] },
        {
          role: 'user',
          content: [{ type: 'tool_result', toolUseId: 't', content: 'nope', isError: true }],
        },
      ],
    })
    expect(out[2]).toMatchObject({ role: 'tool', content: 'Error: nope' })
  })
})

// ---------------------------------------------------------------------------
// Google AI Studio
// ---------------------------------------------------------------------------

describe('GoogleProvider (Gemini API against a local server)', () => {
  let server: MockServer
  beforeAll(async () => {
    server = await startMockServer()
  })
  afterAll(() => server.close())

  const make = (extra = {}) =>
    new GoogleProvider({
      apiKey: 'AIza-test',
      baseURL: `${server.url}/v1beta`,
      maxRetries: 0,
      ...extra,
    })

  const candidate = (parts: unknown[], finishReason?: string) => ({
    candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }],
  })

  it('streams text, separates thoughts, and reads usage including thinking tokens', async () => {
    server.handle((_req, res) =>
      sse(res, [
        candidate([{ text: 'planning', thought: true }]),
        candidate([{ text: 'Hel' }]),
        {
          ...candidate([{ text: 'lo' }], 'STOP'),
          usageMetadata: {
            promptTokenCount: 20,
            candidatesTokenCount: 4,
            thoughtsTokenCount: 6,
            cachedContentTokenCount: 5,
          },
        },
      ]),
    )
    const events = await drain(make().stream(baseRequest({ model: 'gemini-2.5-flash' })))
    expect(events.filter((e) => e.type === 'thinking_delta')).toHaveLength(1)
    const response = await make().complete(baseRequest({ model: 'gemini-2.5-flash' }))
    expect(response.content).toEqual([
      { type: 'thinking', thinking: 'planning' },
      { type: 'text', text: 'Hello' },
    ])
    expect(response.stopReason).toBe('end_turn')
    expect(response.usage).toMatchObject({
      inputTokens: 20,
      outputTokens: 10,
      reasoningTokens: 6,
      cacheReadTokens: 5,
    })

    const req = server.requests.at(-1)!
    expect(req.url).toBe('/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse')
    // The key travels in a header, never in the URL.
    expect(req.headers['x-goog-api-key']).toBe('AIza-test')
    expect(req.url).not.toContain('AIza')
  })

  it('builds a correct request: system instruction, declarations, thinking, token cap', async () => {
    server.handle((_req, res) => sse(res, [candidate([{ text: 'ok' }], 'STOP')]))
    await make().complete(
      baseRequest({
        model: 'gemini-2.5-pro',
        tools: [readTool],
        effort: 'max',
        maxOutputTokens: 1000,
      }),
    )
    // biome-ignore lint/suspicious/noExplicitAny: loosely-typed wire body
    const body = server.requests.at(-1)!.body as Record<string, any>
    expect(body.systemInstruction.parts[0].text).toBe('You are Flex.')
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }])
    expect(body.tools[0].functionDeclarations[0]).toMatchObject({
      name: 'read_file',
      parameters: { type: 'OBJECT', properties: { path: { type: 'STRING' } }, required: ['path'] },
    })
    // Gemini rejects unknown JSON Schema keywords.
    expect(JSON.stringify(body.tools)).not.toMatch(/additionalProperties|\$schema/)
    expect(body.generationConfig).toMatchObject({
      maxOutputTokens: 1000,
      thinkingConfig: { includeThoughts: true, thinkingBudget: 24576 },
    })
  })

  it('turns functionCall parts into tool calls and preserves the thought signature', async () => {
    server.handle((_req, res) =>
      sse(res, [
        candidate(
          [
            {
              functionCall: { name: 'read_file', args: { path: 'a.ts' } },
              thoughtSignature: 'SIG123',
            },
            { functionCall: { name: 'read_file', args: { path: 'b.ts' } } },
          ],
          'STOP',
        ),
      ]),
    )
    const response = await make().complete(
      baseRequest({ model: 'gemini-3-flash-preview', tools: [readTool] }),
    )
    const uses = response.content.filter((b) => b.type === 'tool_use')
    expect(uses).toHaveLength(2)
    expect(uses[0]).toMatchObject({
      name: 'read_file',
      input: { path: 'a.ts' },
      providerMeta: { thoughtSignature: 'SIG123' },
    })
    expect(uses[0]?.type === 'tool_use' && uses[0].id).not.toBe(
      uses[1]?.type === 'tool_use' && uses[1].id,
    )
    // A call is a call, whatever finishReason says.
    expect(response.stopReason).toBe('tool_use')

    // ...and the follow-up request echoes the signature and pairs results by name.
    server.handle((_req, res) => sse(res, [candidate([{ text: 'done' }], 'STOP')]))
    const first = uses[0]!
    await make().complete(
      baseRequest({
        model: 'gemini-3-flash-preview',
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'go' }] },
          { role: 'assistant', content: [first] },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                toolUseId: first.type === 'tool_use' ? first.id : '',
                content: 'file text',
              },
            ],
          },
        ],
      }),
    )
    // biome-ignore lint/suspicious/noExplicitAny: loosely-typed wire body
    const body = server.requests.at(-1)!.body as { contents: Array<{ role: string; parts: any[] }> }
    expect(body.contents.map((c) => c.role)).toEqual(['user', 'model', 'user'])
    expect(body.contents[1]?.parts[0]).toMatchObject({
      functionCall: { name: 'read_file' },
      thoughtSignature: 'SIG123',
    })
    expect(body.contents[2]?.parts[0]).toMatchObject({
      functionResponse: { name: 'read_file', response: { output: 'file text' } },
    })
  })

  it('maps finish reasons and blocked prompts', async () => {
    const cases: Array<[unknown[], string]> = [
      [[candidate([{ text: 'x' }], 'MAX_TOKENS')], 'max_tokens'],
      [[candidate([], 'SAFETY')], 'refusal'],
      [[{ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }], 'refusal'],
    ]
    for (const [events, reason] of cases) {
      server.handle((_req, res) => sse(res, events))
      expect((await make().complete(baseRequest({ model: 'gemini-2.5-pro' }))).stopReason).toBe(
        reason,
      )
    }
  })

  it('reports MALFORMED_FUNCTION_CALL as a retryable error', async () => {
    server.handle((_req, res) => sse(res, [candidate([], 'MALFORMED_FUNCTION_CALL')]))
    await expect(make().complete(baseRequest({ model: 'gemini-2.5-pro' }))).rejects.toMatchObject({
      retryable: true,
    })
  })

  it('maps HTTP errors and never leaks the key in the message', async () => {
    const cases: Array<[number, string, string]> = [
      [400, 'INVALID_ARGUMENT', 'invalid_request'],
      [401, 'UNAUTHENTICATED', 'auth'],
      [403, 'PERMISSION_DENIED', 'auth'],
      [404, 'NOT_FOUND', 'invalid_request'],
      [429, 'RESOURCE_EXHAUSTED', 'rate_limit'],
      [503, 'UNAVAILABLE', 'overloaded'],
    ]
    for (const [code, status, kind] of cases) {
      server.handle((_req, res) =>
        json(res, code, { error: { code, status, message: `failed ${code}` } }),
      )
      const events = await drain(make().stream(baseRequest({ model: 'gemini-2.5-pro' })))
      const error = events.find((e) => e.type === 'error')
      expect(error, `status ${code}`).toMatchObject({ error: { kind } })
      expect(JSON.stringify(error)).not.toContain('AIza-test')
    }
    server.handle((_req, res) =>
      json(res, 400, {
        error: {
          code: 400,
          status: 'INVALID_ARGUMENT',
          message: 'The input token count exceeds the maximum number of tokens allowed 1048576.',
        },
      }),
    )
    const events = await drain(make().stream(baseRequest({ model: 'gemini-2.5-pro' })))
    expect(events.find((e) => e.type === 'error')).toMatchObject({
      error: { kind: 'context_overflow' },
    })
  })

  it('retries a 503 and then succeeds', async () => {
    let calls = 0
    server.handle((_req, res) => {
      calls++
      if (calls === 1)
        return json(res, 503, { error: { code: 503, status: 'UNAVAILABLE', message: 'busy' } })
      sse(res, [candidate([{ text: 'recovered' }], 'STOP')])
    })
    const response = await make({ maxRetries: 2 }).complete(
      baseRequest({ model: 'gemini-2.5-pro' }),
    )
    expect(calls).toBe(2)
    expect(response.content).toEqual([{ type: 'text', text: 'recovered' }])
  }, 15_000)

  it('fails fast with an auth error when no key is configured', async () => {
    const saved = { ...process.env }
    for (const k of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'])
      delete process.env[k]
    try {
      const keyless = new GoogleProvider({ baseURL: `${server.url}/v1beta` })
      expect(keyless.configured()).toBe(false)
      expect((await keyless.available()).ok).toBe(false)
      const events = await drain(keyless.stream(baseRequest({ model: 'gemini-2.5-pro' })))
      expect(events[0]).toMatchObject({ type: 'error', error: { kind: 'auth' } })
    } finally {
      process.env = saved
    }
  })

  it('aborts cleanly', async () => {
    server.handle((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write(`data: ${JSON.stringify(candidate([{ text: 'x' }]))}\n\n`)
    })
    const controller = new AbortController()
    const events: StreamEvent[] = []
    for await (const e of make().stream(
      baseRequest({ model: 'gemini-2.5-pro', signal: controller.signal }),
    )) {
      events.push(e)
      if (e.type === 'text_delta') controller.abort()
    }
    expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'aborted' })
  })

  it('resolves aliases, versioned ids and unknown gemini ids; rejects foreign ids', () => {
    const p = make()
    expect(p.resolveModel('flash')?.id).toBe('gemini-3-flash-preview')
    expect(p.resolveModel('models/gemini-2.5-pro')?.id).toBe('gemini-2.5-pro')
    expect(p.resolveModel('gemini-9-ultra')).toMatchObject({
      id: 'gemini-9-ultra',
      supportsTools: true,
    })
    expect(p.resolveModel('gpt-4o')).toBeUndefined()
    expect(p.resolveModel('claude-opus-5-5')).toBeUndefined()
  })

  it('discovers models via GET /models and filters out non-chat models', async () => {
    server.handle((req, res) =>
      req.url.startsWith('/v1beta/models?')
        ? json(res, 200, {
            models: [
              {
                name: 'models/gemini-2.5-pro',
                displayName: 'Gemini 2.5 Pro',
                inputTokenLimit: 1048576,
                outputTokenLimit: 65536,
                supportedGenerationMethods: ['generateContent'],
              },
              {
                name: 'models/gemini-9-preview',
                displayName: 'Gemini 9',
                inputTokenLimit: 2000000,
                outputTokenLimit: 100000,
                supportedGenerationMethods: ['generateContent'],
              },
              { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
              {
                name: 'models/gemini-2.5-flash-preview-tts',
                supportedGenerationMethods: ['generateContent'],
              },
            ],
          })
        : json(res, 404, {}),
    )
    const p = make()
    await p.refreshModels()
    expect(p.listModels().map((m) => m.id)).toEqual(['gemini-2.5-pro', 'gemini-9-preview'])
    expect(p.resolveModel('gemini-9-preview')?.contextWindow).toBe(2_000_000)
  })
})

describe('Gemini wire helpers', () => {
  it('converts JSON Schema to the OpenAPI subset', () => {
    // biome-ignore lint/suspicious/noExplicitAny: loosely-typed schema tree
    const schema = toGeminiSchema({
      $schema: 'x',
      type: 'object',
      properties: {
        name: { type: ['string', 'null'], description: 'n' },
        count: { type: 'integer', minimum: 1, pattern: '^x$' },
        mode: { const: 'fast' },
        kind: { enum: ['a', 'b'] },
        tags: { type: 'array', items: { type: 'string' } },
        nested: { $ref: '#/$defs/Inner' },
        either: { anyOf: [{ type: 'string' }, { type: 'null' }] },
      },
      required: ['name', 'ghost'],
      additionalProperties: false,
      $defs: { Inner: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] } },
    }) as Record<string, any>
    expect(schema.type).toBe('OBJECT')
    expect(schema.required).toEqual(['name'])
    expect(schema.properties.name).toEqual({ type: 'STRING', nullable: true, description: 'n' })
    expect(schema.properties.count).toEqual({ type: 'INTEGER', minimum: 1 })
    expect(schema.properties.mode).toEqual({ type: 'STRING', enum: ['fast'] })
    expect(schema.properties.kind.enum).toEqual(['a', 'b'])
    expect(schema.properties.tags).toEqual({ type: 'ARRAY', items: { type: 'STRING' } })
    expect(schema.properties.nested.properties.x.type).toBe('NUMBER')
    expect(schema.properties.either).toEqual({ type: 'STRING', nullable: true })
  })

  it('omits parameters for tools that take none', () => {
    expect(toGeminiSchema({ type: 'object', properties: {} })).toBeUndefined()
  })

  it('merges same-role turns and starts with a user turn', () => {
    const contents = toContents(
      [
        { role: 'assistant', content: [{ type: 'text', text: 'earlier' }] },
        { role: 'user', content: [{ type: 'text', text: 'a' }] },
        { role: 'user', content: [{ type: 'text', text: 'b' }] },
      ],
      false,
    )
    expect(contents.map((c) => c.role)).toEqual(['user', 'model', 'user'])
    expect(contents[2]?.parts).toHaveLength(2)
  })

  it('supplies the documented dummy signature for Gemini 3 history lacking one', () => {
    const contents = toContents(
      [
        { role: 'user', content: [{ type: 'text', text: 'go' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'x', input: {} }] },
      ],
      true,
    )
    expect(contents[1]?.parts[0]?.thoughtSignature).toBe('skip_thought_signature_validator')
  })

  it('picks thinkingLevel for the 3 series and a budget for 2.5', () => {
    const info = { supportsThinking: true } as never
    expect(thinkingConfig('gemini-3-flash-preview', info, 'medium')).toMatchObject({
      thinkingLevel: 'medium',
    })
    expect(thinkingConfig('gemini-3.1-pro-preview', info, 'medium')).toMatchObject({
      thinkingLevel: 'high',
    })
    expect(thinkingConfig('gemini-2.5-flash', info, 'low')).toMatchObject({ thinkingBudget: 1024 })
    expect(thinkingConfig('gemma-3', { supportsThinking: false } as never, 'high')).toBeUndefined()
  })
})

describe('readSSE', () => {
  it('handles CRLF, multi-line data, comments and chunk boundaries', async () => {
    const text =
      ': keepalive\r\ndata: one\r\n\r\ndata: two\r\ndata: three\r\n\r\nevent: x\ndata: four\n\n'
    const bytes = new TextEncoder().encode(text)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Split mid-line and mid-CRLF to exercise buffering.
        for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7))
        controller.close()
      },
    })
    const out: Array<{ event?: string; data: string }> = []
    for await (const m of readSSE(stream)) out.push(m)
    expect(out).toEqual([
      { event: undefined, data: 'one' },
      { event: undefined, data: 'two\nthree' },
      { event: 'x', data: 'four' },
    ])
  })
})

// ---------------------------------------------------------------------------
// Registry + router: dynamic selection
// ---------------------------------------------------------------------------

describe('provider registry and router', () => {
  const none = {} as NodeJS.ProcessEnv

  it('enables only providers that have credentials, but always keeps Anthropic', () => {
    expect(buildProviders({ env: none }).providers.map((p) => p.id)).toEqual(['anthropic'])
    const set = buildProviders({
      env: { GEMINI_API_KEY: 'k', OPENAI_API_KEY: 'k2' } as NodeJS.ProcessEnv,
    })
    expect(set.providers.map((p) => p.id)).toEqual(['anthropic', 'google', 'openai'])
  })

  it('honours the legacy FLEX_OPENAI_* variables and OPENAI_BASE_URL', () => {
    const set = buildProviders({
      env: {
        FLEX_OPENAI_BASE_URL: 'http://localhost:11434/v1',
        FLEX_OPENAI_MODEL: 'qwen2.5-coder',
      } as NodeJS.ProcessEnv,
    })
    const openai = set.providers.find((p) => p.id === 'openai')
    expect(openai).toBeDefined()
    expect(openai?.resolveModel('')?.id).toBe('qwen2.5-coder')
  })

  it('builds custom providers from config and skips ones that are disabled or lack a URL', () => {
    const set = buildProviders({
      env: { MY_KEY: 'k', GEMINI_API_KEY: 'g' } as NodeJS.ProcessEnv,
      providers: {
        groq: {
          baseURL: 'https://api.groq.com/openai/v1',
          apiKeyEnv: 'MY_KEY',
          models: ['llama-3.3-70b'],
        },
        broken: {},
        off: { baseURL: 'http://x/v1', enabled: false },
        google: { enabled: false },
        studio2: { type: 'google', apiKeyEnv: 'MY_KEY' },
      },
    })
    expect(set.providers.map((p) => p.id)).toEqual(['anthropic', 'groq', 'studio2'])
  })

  it('routes by known model first, catch-all last, and by explicit prefix', () => {
    const { router } = buildProviders({
      env: { GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o' } as NodeJS.ProcessEnv,
      providers: { local: { baseURL: 'http://127.0.0.1:11434/v1' } },
    })
    expect(router.locate('claude-opus-5-5')?.provider.id).toBe('anthropic')
    expect(router.locate('sonnet')?.provider.id).toBe('anthropic')
    expect(router.locate('gemini-2.5-pro')?.provider.id).toBe('google')
    expect(router.locate('gemini')?.info.id).toBe('gemini-3.1-pro-preview')
    // gpt-* is known to nobody strict; the first catch-all (openai) takes it.
    expect(router.locate('gpt-5')?.provider.id).toBe('openai')
    // Explicit prefixes, aliases, and colons inside model ids.
    expect(router.locate('local:qwen2.5-coder:7b')).toMatchObject({
      provider: { id: 'local' },
      wireId: 'qwen2.5-coder:7b',
    })
    expect(router.locate('gemini:flash')?.provider.id).toBe('google')
    expect(router.locate('qwen2.5-coder:7b')?.wireId).toBe('qwen2.5-coder:7b')
    // The canonical id is qualified only when the bare id would go elsewhere.
    expect(router.resolveModel('gpt-5')?.id).toBe('gpt-5')
    expect(router.resolveModel('local:gpt-5')?.id).toBe('local:gpt-5')
  })

  it('sends the request to the right backend with the prefix stripped', async () => {
    const google = await startMockServer((_req, res) =>
      sse(res, [
        { candidates: [{ content: { parts: [{ text: 'from gemini' }] }, finishReason: 'STOP' }] },
      ]),
    )
    const openai = await startMockServer((_req, res) =>
      sse(res, [
        {
          id: '1',
          choices: [{ index: 0, delta: { content: 'from openai' }, finish_reason: null }],
        },
        { id: '1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ]),
    )
    try {
      const { router } = buildProviders({
        env: {} as NodeJS.ProcessEnv,
        providers: {
          google: { apiKey: 'g', baseURL: `${google.url}/v1beta` },
          openai: { apiKey: 'o', baseURL: `${openai.url}/v1` },
        },
      })
      const a = await router.complete(baseRequest({ model: 'google:gemini-2.5-pro' }))
      expect(a.content).toEqual([{ type: 'text', text: 'from gemini' }])
      expect(google.requests.at(-1)?.url).toContain('/models/gemini-2.5-pro:')

      const b = await router.complete(baseRequest({ model: 'openai:my-model' }))
      expect(b.content).toEqual([{ type: 'text', text: 'from openai' }])
      expect((openai.requests.at(-1)?.body as { model: string } | undefined)?.model).toBe(
        'my-model',
      )
    } finally {
      await google.close()
      await openai.close()
    }
  })

  it('reports an unroutable model as a clear error, not a crash', async () => {
    const router = new ProviderRouter(buildProviders({ env: none }).providers)
    const events = await drain(router.stream(baseRequest({ model: 'mystery-1' })))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'error', error: { kind: 'invalid_request' } })
  })

  it('rewrites unsafe tool names on the wire and restores them on the way back', async () => {
    const openai = await startMockServer((_req, res) =>
      sse(res, [
        {
          id: '1',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: 'c', function: { name: 'PLACEHOLDER', arguments: '{}' } },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        { id: '1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
      ]),
    )
    try {
      const weird = 'mcp__my.server__do thing'
      openai.handle((req, res) => {
        const sent = (req.body as { tools: Array<{ function: { name: string } }> }).tools[0]!
          .function.name
        expect(sent).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
        sse(res, [
          {
            id: '1',
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, id: 'c', function: { name: sent, arguments: '{}' } }],
                },
                finish_reason: null,
              },
            ],
          },
          { id: '1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        ])
      })
      const { router } = buildProviders({
        env: {} as NodeJS.ProcessEnv,
        providers: { openai: { apiKey: 'o', baseURL: `${openai.url}/v1` } },
      })
      const response = await router.complete(
        baseRequest({
          model: 'openai:m',
          tools: [{ name: weird, description: 'd', inputSchema: { type: 'object' } }],
        }),
      )
      expect(response.content.find((b) => b.type === 'tool_use')).toMatchObject({ name: weird })
    } finally {
      await openai.close()
    }
  })

  it('picks a default model from the first provider that is actually configured', () => {
    const onlyGemini = buildProviders({
      env: { GEMINI_API_KEY: 'g' } as NodeJS.ProcessEnv,
    }).providers
    // Anthropic has no key, so it must not be the default.
    expect(pickDefaultModel(onlyGemini, 'claude-opus-5-5')).toBe('gemini-3.1-pro-preview')
    const withAnthropic = buildProviders({
      env: { ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g' } as NodeJS.ProcessEnv,
    }).providers
    expect(pickDefaultModel(withAnthropic, 'x')).toBe('claude-opus-5-5')
    const local = buildProviders({
      env: none,
      providers: { local: { baseURL: 'http://127.0.0.1:11434/v1', defaultModel: 'qwen2.5-coder' } },
    }).providers
    expect(pickDefaultModel(local, 'x')).toBe('local:qwen2.5-coder')
    expect(pickDefaultModel(buildProviders({ env: none }).providers, 'fallback-model')).toBe(
      'fallback-model',
    )
  })
})

describe('buildToolNameMap', () => {
  it('leaves valid names alone and never collapses two names onto one', () => {
    const map = buildToolNameMap(['read_file', 'a.b', 'a b'])
    expect(map.toWire('read_file')).toBe('read_file')
    expect(map.toWire('a.b')).not.toBe(map.toWire('a b'))
    expect(map.fromWire(map.toWire('a.b'))).toBe('a.b')
    expect(map.toWire('x'.repeat(100)).length).toBeLessThanOrEqual(64)
  })
})
