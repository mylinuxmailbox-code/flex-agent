import type { ModelProvider } from '../../src/models/provider.js'
import type {
  AgentMessage,
  ModelInfo,
  ModelRequest,
  ModelResponse,
  StreamEvent,
} from '../../src/models/types.js'

export class ScriptedProvider implements ModelProvider {
  readonly id = 'scripted'
  readonly label = 'Scripted'
  /** One list of events per turn; consumed in order. */
  readonly turns: StreamEvent[][] = []
  /** Message history as the model saw it, for asserting what it was told. */
  readonly requests: AgentMessage[][] = []
  /** Full requests, for asserting tools/effort/system. */
  readonly fullRequests: ModelRequest[] = []
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
    this.fullRequests.push({ ...request, messages: structuredClone(request.messages) })
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

export function toolTurn(name: string, id: string, input: unknown): StreamEvent[] {
  return [
    { type: 'message_start', id: 'msg', model: 'scripted-1' },
    { type: 'text_delta', text: `Calling ${name}.` },
    { type: 'tool_call_start', index: 0, id, name },
    { type: 'tool_call_delta', index: 0, partialJson: JSON.stringify(input) },
    { type: 'tool_call_end', index: 0, id, name, input },
    { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 20 } },
  ]
}

export function textTurn(text: string): StreamEvent[] {
  return [
    { type: 'message_start', id: 'msg', model: 'scripted-1' },
    { type: 'text_delta', text },
    { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 120, outputTokens: 30 } },
  ]
}
