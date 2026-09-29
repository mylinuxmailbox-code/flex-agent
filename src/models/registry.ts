import { AnthropicProvider, type AnthropicProviderOptions } from './anthropic.js'
import { GoogleAIStudioProvider, type GoogleAIStudioProviderOptions } from './google.js'
import { type OpenAICompatibleOptions, OpenAICompatibleProvider } from './openai-compatible.js'
import type { ModelProvider } from './provider.js'

export type ProviderId = 'anthropic' | 'openai-compatible' | 'google'

export interface ProviderRegistryOptions {
  /** Explicit provider preference, e.g. from `--provider` or FLEX_PROVIDER. */
  providerId?: string
  /** Model is used to include a provider when only a model-specific env is set. */
  model?: string
  anthropic?: AnthropicProviderOptions
  openai?: OpenAICompatibleOptions
  google?: GoogleAIStudioProviderOptions
}

export interface ResolvedProvider {
  provider: ModelProvider
  model: string
}

/**
 * Build the configured provider set in deterministic preference order.
 *
 * A provider with no credentials is still included when explicitly requested,
 * so `available()` can report the actionable configuration error. Unrequested
 * providers are only added when their environment or model id indicates that
 * they are intended to be used.
 */
export function createModelProviders(options: ProviderRegistryOptions = {}): ModelProvider[] {
  const preferred = normalizeProviderId(options.providerId)
  const model = stripProviderPrefix(options.model ?? '')
  const wantsAnthropic =
    preferred === 'anthropic' ||
    (!preferred &&
      (Boolean(options.anthropic?.apiKey) ||
        Boolean(options.anthropic?.authToken) ||
        Boolean(process.env.ANTHROPIC_API_KEY) ||
        Boolean(process.env.ANTHROPIC_AUTH_TOKEN) ||
        model.startsWith('claude-')))
  const wantsOpenAI =
    preferred === 'openai-compatible' ||
    (!preferred &&
      (Boolean(options.openai?.apiKey) ||
        Boolean(options.openai?.baseURL) ||
        Boolean(process.env.FLEX_OPENAI_API_KEY) ||
        Boolean(process.env.OPENAI_API_KEY) ||
        Boolean(process.env.FLEX_OPENAI_BASE_URL) ||
        Boolean(process.env.OPENAI_BASE_URL) ||
        isOpenAIModel(model)))
  const wantsGoogle =
    preferred === 'google' ||
    (!preferred &&
      (Boolean(options.google?.apiKey) ||
        Boolean(options.google?.baseURL) ||
        Boolean(process.env.FLEX_GOOGLE_BASE_URL) ||
        Boolean(process.env.FLEX_GOOGLE_API_KEY) ||
        Boolean(process.env.FLEX_GEMINI_API_KEY) ||
        Boolean(process.env.GEMINI_API_KEY) ||
        Boolean(process.env.GOOGLE_AI_API_KEY) ||
        Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY) ||
        Boolean(process.env.GOOGLE_AI_STUDIO_API_KEY) ||
        model.startsWith('gemini-')))

  const factories: Array<{ id: ProviderId; make: () => ModelProvider; enabled: boolean }> = [
    {
      id: 'anthropic',
      enabled: wantsAnthropic || (!wantsOpenAI && !wantsGoogle),
      make: () => new AnthropicProvider(options.anthropic),
    },
    {
      id: 'openai-compatible',
      enabled: wantsOpenAI,
      make: () => new OpenAICompatibleProvider(options.openai),
    },
    {
      id: 'google',
      enabled: wantsGoogle,
      make: () => new GoogleAIStudioProvider(options.google),
    },
  ]

  const enabled = factories.filter((factory) => factory.enabled)
  enabled.sort((a, b) => {
    if (a.id === preferred) return -1
    if (b.id === preferred) return 1
    return 0
  })
  return enabled.map((factory) => factory.make())
}

/** Resolve a model, honoring `provider:model` selectors before model heuristics. */
export function resolveProvider(
  providers: readonly ModelProvider[],
  spec: string,
  preferredId?: string,
): ResolvedProvider | undefined {
  const { providerId, model } = splitProvider(spec)
  const preferred = normalizeProviderId(providerId ?? preferredId)
  const ordered = [...providers].sort((a, b) => {
    if (a.id === preferred) return -1
    if (b.id === preferred) return 1
    return providerModelPriority(a, model) - providerModelPriority(b, model)
  })

  for (const provider of ordered) {
    const info = provider.resolveModel(model)
    if (info) return { provider, model: info.id }
  }
  return undefined
}

export function normalizeProviderId(value: string | undefined): ProviderId | undefined {
  switch (value?.trim().toLowerCase()) {
    case 'anthropic':
      return 'anthropic'
    case 'openai':
    case 'openai-compatible':
    case 'openai_compatible':
      return 'openai-compatible'
    case 'google':
    case 'gemini':
    case 'google-ai-studio':
    case 'google-ai':
      return 'google'
    default:
      return undefined
  }
}

function splitProvider(spec: string): { providerId?: ProviderId; model: string } {
  const colon = spec.indexOf(':')
  if (colon <= 0) return { model: stripProviderPrefix(spec) }
  const providerId = normalizeProviderId(spec.slice(0, colon))
  return providerId ? { providerId, model: spec.slice(colon + 1).trim() } : { model: spec }
}

function stripProviderPrefix(spec: string): string {
  const colon = spec.indexOf(':')
  if (colon <= 0) return spec.trim()
  return normalizeProviderId(spec.slice(0, colon)) ? spec.slice(colon + 1).trim() : spec.trim()
}

function isOpenAIModel(model: string): boolean {
  return /^(?:gpt-|o[1-9]|chatgpt-|deepseek-|qwen|llama|mistral|codestral|command-|kimi-|phi[-\d])/i.test(
    model,
  )
}

function providerModelPriority(provider: ModelProvider, model: string): number {
  if (provider.id === 'google' && /^gemini-/i.test(model)) return -2
  if (provider.id === 'anthropic' && /^claude-/i.test(model)) return -2
  if (provider.id === 'openai-compatible' && isOpenAIModel(model)) return -1
  return 0
}
