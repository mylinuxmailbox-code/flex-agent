import { afterEach, describe, expect, it, vi } from 'vitest'
import { GoogleAIStudioProvider, toGoogleContents } from '../src/models/google.js'
import { OpenAICompatibleProvider } from '../src/models/openai-compatible.js'
import { createModelProviders, resolveProvider } from '../src/models/registry.js'
import type { ModelRequest } from '../src/models/types.js'

const request: ModelRequest = {
  model: 'test-model',
  system: { text: 'You are a coding assistant.', toolGuidance: 'Use tools carefully.' },
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Read the file.' }] }],
  tools: [
    {
      name: 'read_file',
      description: 'Read a file',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  ],
  effort: 'high',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('OpenAICompatibleProvider', () => {
  it('translates streamed text, tool calls, and usage', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      calls.push({ url: String(input), body })
      return new Response(
        [
          'data: {"id":"chatcmpl_1","model":"test-model","choices":[{"index":0,"delta":{"role":"assistant","content":"I will read it.","tool_calls":[{"index":0,"id":"call_1","function":{"name":"read_file","arguments":"{\\"path\\":\\"src/"}}]}}]}',
          '',
          'data: {"id":"chatcmpl_1","model":"test-model","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"hello.ts\\"}"}}]}}]}',
          '',
          'data: {"id":"chatcmpl_1","model":"test-model","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
          '',
          'data: {"id":"chatcmpl_1","model":"test-model","choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7}}',
          '',
          'data: [DONE]',
          '',
        ].join('\n'),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    })

    const provider = new OpenAICompatibleProvider({
      baseURL: 'https://example.test/v1',
      apiKey: 'test-key',
    })
    const events = []
    for await (const event of provider.stream(request)) events.push(event)

    expect(calls[0]?.url).toBe('https://example.test/v1/chat/completions')
    expect(calls[0]?.body).toMatchObject({
      model: 'test-model',
      stream: true,
      stream_options: { include_usage: true },
    })
    expect(calls[0]?.body.messages).toEqual([
      { role: 'system', content: 'You are a coding assistant.\n\nUse tools carefully.' },
      { role: 'user', content: 'Read the file.' },
    ])
    expect(events).toContainEqual({ type: 'text_delta', text: 'I will read it.' })
    expect(events).toContainEqual({
      type: 'tool_call_end',
      index: 0,
      id: 'call_1',
      name: 'read_file',
      input: { path: 'src/hello.ts' },
    })
    expect(events).toContainEqual({
      type: 'done',
      stopReason: 'tool_use',
      usage: { inputTokens: 12, outputTokens: 7 },
    })
  })

  it('normalizes a host-only endpoint and resolves the configured default model', () => {
    const provider = new OpenAICompatibleProvider({
      baseURL: 'http://localhost:11434',
      apiKey: 'not-needed',
      defaultModel: 'qwen-local',
    })
    expect(provider.resolveModel('')?.id).toBe('qwen-local')
    expect(provider.resolveModel('custom-local-model')?.id).toBe('custom-local-model')
  })
})

describe('GoogleAIStudioProvider', () => {
  it('translates Gemini SSE text, thinking, function calls, and usage', async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      })
      return new Response(
        [
          'data: {"responseId":"resp_1","candidates":[{"content":{"parts":[{"text":"Thinking...","thought":true},{"text":"I will read it."}]}}],"usageMetadata":{"promptTokenCount":10}}',
          '',
          'data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"read_file","args":{"path":"src/hello.ts"}}}]},"finishReason":"STOP"}],"usageMetadata":{"candidatesTokenCount":8,"thoughtsTokenCount":3}}',
          '',
        ].join('\n'),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    })

    const provider = new GoogleAIStudioProvider({
      apiKey: 'google-test',
      defaultModel: 'gemini-2.5-flash',
    })
    const events = []
    for await (const event of provider.stream({ ...request, model: 'gemini-2.5-flash' }))
      events.push(event)

    expect(requests[0]?.url).toContain(
      '/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=google-test',
    )
    expect(requests[0]?.body).toMatchObject({
      systemInstruction: { parts: [{ text: 'You are a coding assistant.' }] },
      generationConfig: {
        maxOutputTokens: 65_536,
        thinkingConfig: { includeThoughts: true, thinkingBudget: 8_192 },
      },
    })
    expect(events).toContainEqual({ type: 'thinking_delta', thinking: 'Thinking...' })
    expect(events).toContainEqual({ type: 'text_delta', text: 'I will read it.' })
    expect(events).toContainEqual({
      type: 'tool_call_end',
      index: 0,
      id: 'call_0',
      name: 'read_file',
      input: { path: 'src/hello.ts' },
    })
    expect(events).toContainEqual({
      type: 'done',
      stopReason: 'tool_use',
      usage: { inputTokens: 10, outputTokens: 8, reasoningTokens: 3 },
    })
  })

  it('replays tool calls and results in Gemini content format', () => {
    const contents = toGoogleContents([
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'call_1', content: 'file contents' }],
      },
    ])
    expect(contents).toEqual([
      { role: 'model', parts: [{ functionCall: { name: 'read_file', args: { path: 'a.ts' } } }] },
      {
        role: 'user',
        parts: [{ functionResponse: { name: 'read_file', response: { output: 'file contents' } } }],
      },
    ])
  })
})

describe('model provider registry', () => {
  it('selects providers by explicit prefix and model family', () => {
    const providers = createModelProviders({
      openai: { apiKey: 'openai-test', baseURL: 'https://example.test/v1' },
      google: { apiKey: 'google-test' },
    })

    expect(resolveProvider(providers, 'google:gemini-2.5-flash')?.provider.id).toBe('google')
    expect(resolveProvider(providers, 'gpt-4o')?.provider.id).toBe('openai-compatible')
    expect(resolveProvider(providers, 'gemini-2.5-flash')?.provider.id).toBe('google')
  })
})
