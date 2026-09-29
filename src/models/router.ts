import type { ModelProvider } from './provider.js'
import { collectStream } from './provider.js'
import { buildToolNameMap, renameBlocks, requestToolNames } from './tool-names.js'
import {
  type AgentMessage,
  ModelError,
  type ModelInfo,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from './types.js'

/**
 * Routes a request to whichever provider serves its model.
 *
 * The agent loop and the subagent runner each take exactly one `ModelProvider`.
 * Rather than teach them about several, this router *is* that one provider:
 * `/model google:gemini-2.5-pro` mid-session simply changes the model string,
 * and the router decides where it goes.
 *
 * Model specs:
 *   `provider:model`  explicit — `google:gemini-2.5-pro`, `openai:gpt-5`, `ollama:qwen2.5-coder:7b`
 *   `model`           implicit — providers that *know* the id win; catch-all
 *                     providers (local servers, gateways) are asked last.
 *
 * The prefix is only treated as a provider when it names one, so Ollama-style
 * ids that contain a colon (`qwen2.5-coder:7b`) still work unprefixed.
 */
export class ProviderRouter implements ModelProvider {
  readonly id = 'router'
  readonly label = 'Providers'
  readonly providers: readonly ModelProvider[]

  constructor(providers: readonly ModelProvider[]) {
    if (providers.length === 0) throw new Error('ProviderRouter needs at least one provider')
    this.providers = providers
  }

  configured(): boolean {
    return this.providers.some((p) => p.configured?.() ?? true)
  }

  async available(): Promise<{ ok: boolean; reason?: string }> {
    const results = await Promise.all(
      this.providers.map(async (p) => ({ p, r: await p.available() })),
    )
    if (results.some((x) => x.r.ok)) return { ok: true }
    return {
      ok: false,
      reason: results.map((x) => `${x.p.id}: ${x.r.reason ?? 'unavailable'}`).join('; '),
    }
  }

  listModels(): ModelInfo[] {
    return this.providers.flatMap((p) =>
      p.listModels().map((m) => ({ ...m, provider: m.provider ?? p.id })),
    )
  }

  async refreshModels(signal?: AbortSignal): Promise<void> {
    await Promise.all(this.providers.map((p) => p.refreshModels?.(signal)))
  }

  /** Find the provider for a spec, and the id to send it. */
  locate(spec: string): { provider: ModelProvider; info: ModelInfo; wireId: string } | undefined {
    const trimmed = spec.trim()

    const colon = trimmed.indexOf(':')
    if (colon > 0) {
      const prefix = trimmed.slice(0, colon).toLowerCase()
      const provider = this.providers.find(
        (p) => p.id.toLowerCase() === prefix || p.aliases?.some((a) => a.toLowerCase() === prefix),
      )
      if (provider) {
        const info = provider.resolveModel(trimmed.slice(colon + 1))
        return info ? { provider, info, wireId: info.id } : undefined
      }
    }

    for (const catchAll of [false, true]) {
      for (const provider of this.providers) {
        if ((provider.catchAll ?? false) !== catchAll) continue
        const info = provider.resolveModel(trimmed)
        if (info) return { provider, info, wireId: info.id }
      }
    }
    return undefined
  }

  /**
   * The canonical spec for a model: qualified only when the bare id would route
   * somewhere else, so saved sessions keep working when providers are added.
   */
  resolveModel(spec: string): ModelInfo | undefined {
    const target = this.locate(spec)
    if (!target) return undefined
    const bare = this.locate(target.info.id)
    const qualified = bare?.provider !== target.provider
    return {
      ...target.info,
      provider: target.info.provider ?? target.provider.id,
      id: qualified ? `${target.provider.id}:${target.info.id}` : target.info.id,
    }
  }

  stream(request: ModelRequest): AsyncGenerator<StreamEvent> {
    return this.#route(request)
  }

  complete(request: ModelRequest): Promise<ModelResponse> {
    return collectStream(this.#route(request))
  }

  async *#route(request: ModelRequest): AsyncGenerator<StreamEvent> {
    const target = this.locate(request.model)
    if (!target) {
      const known = this.listModels()
        .slice(0, 6)
        .map((m) => m.id)
        .join(', ')
      yield {
        type: 'error',
        error: ModelError.invalidRequest(
          `No configured provider serves model "${request.model}". Known: ${known}. ` +
            'Use provider:model (e.g. google:gemini-2.5-pro) to choose explicitly.',
          404,
        ),
      }
      return
    }

    // Third-party tool names are rewritten to wire-safe ones and restored on
    // the way back, so nothing above the router ever sees the alias.
    const names = buildToolNameMap(requestToolNames(request.tools, request.messages))
    const outbound: ModelRequest = {
      ...request,
      model: target.wireId,
      ...(names.rewritten
        ? {
            tools: request.tools.map((t) => ({ ...t, name: names.toWire(t.name) })),
            messages: request.messages.map(
              (m): AgentMessage => ({ ...m, content: renameBlocks(m.content, names.toWire) }),
            ),
          }
        : {}),
    }

    for await (const event of target.provider.stream(outbound)) {
      if (names.rewritten && (event.type === 'tool_call_start' || event.type === 'tool_call_end')) {
        yield { ...event, name: names.fromWire(event.name) }
      } else {
        yield event
      }
    }
  }
}
