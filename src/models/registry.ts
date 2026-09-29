import type { ProviderConfig } from '../config/index.js'
import { AnthropicProvider } from './anthropic.js'
import { GoogleProvider } from './google.js'
import { OpenAICompatibleProvider } from './openai-compatible.js'
import type { ModelProvider } from './provider.js'
import { ProviderRouter } from './router.js'

/**
 * Builds the provider set for a session.
 *
 * Sources, in the order they are applied:
 *   1. Built-ins that have credentials in the environment
 *        anthropic: ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN (+ ANTHROPIC_BASE_URL)
 *        google:    GEMINI_API_KEY / GOOGLE_API_KEY          (+ GEMINI_BASE_URL)
 *        openai:    OPENAI_API_KEY / FLEX_OPENAI_API_KEY     (+ OPENAI_BASE_URL / FLEX_OPENAI_BASE_URL)
 *   2. The `providers` block of the merged config, which can add endpoints,
 *      override a built-in, or switch one off with `enabled: false`.
 *
 * Anthropic is always present (it was Flex's only provider), so a missing key
 * produces a clear auth error instead of an empty model list.
 */

export interface BuildProvidersOptions {
  providers?: Record<string, ProviderConfig>
  env?: NodeJS.ProcessEnv
  /** Session-level overrides for the Anthropic built-in (legacy `SessionConfig`). */
  anthropic?: { apiKey?: string; baseURL?: string }
}

export interface ProviderSet {
  router: ProviderRouter
  providers: ModelProvider[]
}

const BUILTIN_TYPES: Record<string, NonNullable<ProviderConfig['type']>> = {
  anthropic: 'anthropic',
  google: 'google',
  gemini: 'google',
  openai: 'openai-compatible',
}

export const OPENAI_DEFAULT_BASE_URL = 'https://api.openai.com/v1'

function envKey(
  env: NodeJS.ProcessEnv,
  spec: ProviderConfig,
  fallbacks: string[],
): string | undefined {
  if (spec.apiKey) return spec.apiKey
  const names = spec.apiKeyEnv ? [spec.apiKeyEnv] : fallbacks
  for (const name of names) {
    const value = env[name]
    if (value) return value
  }
  return undefined
}

export function buildProviders(options: BuildProvidersOptions = {}): ProviderSet {
  const env = options.env ?? process.env
  const configured = { ...(options.providers ?? {}) }
  const out: ModelProvider[] = []

  // `gemini` is an accepted spelling of `google` in config.
  if (configured.gemini && !configured.google) {
    configured.google = configured.gemini
    delete configured.gemini
  }

  // --- built-ins -------------------------------------------------------------
  const anthropicSpec = configured.anthropic ?? {}
  if (anthropicSpec.enabled !== false) {
    out.push(
      new AnthropicProvider({
        apiKey: options.anthropic?.apiKey ?? envKey(env, anthropicSpec, ['ANTHROPIC_API_KEY']),
        baseURL: options.anthropic?.baseURL ?? anthropicSpec.baseURL ?? env.ANTHROPIC_BASE_URL,
        ...(anthropicSpec.timeoutMs ? { timeoutMs: anthropicSpec.timeoutMs } : {}),
      }),
    )
  }

  const googleSpec = configured.google
  const googleKey = envKey(env, googleSpec ?? {}, [
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY',
  ])
  if (googleSpec ? googleSpec.enabled !== false : Boolean(googleKey)) {
    out.push(
      new GoogleProvider({
        id: 'google',
        label: googleSpec?.label,
        apiKey: googleKey,
        baseURL: googleSpec?.baseURL ?? env.GEMINI_BASE_URL,
        headers: googleSpec?.headers,
        timeoutMs: googleSpec?.timeoutMs,
        defaultModel: googleSpec?.defaultModel,
        models: googleSpec?.models,
      }),
    )
  }

  const openaiSpec = configured.openai
  const openaiBase = openaiSpec?.baseURL ?? env.FLEX_OPENAI_BASE_URL ?? env.OPENAI_BASE_URL
  const openaiKey = envKey(env, openaiSpec ?? {}, ['FLEX_OPENAI_API_KEY', 'OPENAI_API_KEY'])
  if (openaiSpec ? openaiSpec.enabled !== false : Boolean(openaiBase || openaiKey)) {
    out.push(
      openAIFrom('openai', openaiSpec ?? {}, openaiBase ?? OPENAI_DEFAULT_BASE_URL, openaiKey, env),
    )
  }

  // --- everything else in config --------------------------------------------
  for (const [name, spec] of Object.entries(configured)) {
    if (name in BUILTIN_TYPES || spec.enabled === false) continue
    const type = spec.type ?? 'openai-compatible'
    if (type === 'google') {
      out.push(
        new GoogleProvider({
          id: name,
          label: spec.label,
          apiKey: envKey(env, spec, ['GEMINI_API_KEY', 'GOOGLE_API_KEY']),
          baseURL: spec.baseURL,
          headers: spec.headers,
          timeoutMs: spec.timeoutMs,
          defaultModel: spec.defaultModel,
          models: spec.models,
        }),
      )
    } else if (type === 'anthropic') {
      out.push(
        new AnthropicProvider({
          apiKey: envKey(env, spec, ['ANTHROPIC_API_KEY']),
          baseURL: spec.baseURL,
        }),
      )
    } else {
      if (!spec.baseURL) continue // an OpenAI-compatible endpoint without a URL is a typo, not a provider
      out.push(openAIFrom(name, spec, spec.baseURL, envKey(env, spec, []), env))
    }
  }

  return { router: new ProviderRouter(out), providers: out }
}

function openAIFrom(
  id: string,
  spec: ProviderConfig,
  baseURL: string,
  apiKey: string | undefined,
  env: NodeJS.ProcessEnv,
): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    id,
    label: spec.label,
    baseURL,
    apiKey,
    headers: spec.headers,
    defaultModel: spec.defaultModel ?? env.FLEX_OPENAI_MODEL,
    models: spec.models,
    contextWindow: spec.contextWindow,
    maxOutputTokens: spec.maxOutputTokens,
    timeoutMs: spec.timeoutMs,
    maxTokensParam: spec.maxTokensParam,
    reasoningEffort: spec.reasoningEffort,
  })
}

/**
 * The model to start with when the user named none anywhere.
 *
 * Preference follows the order providers were built; the first one that is
 * actually configured wins, so a user with only a Gemini key does not start on
 * an Anthropic model that would fail its first request.
 */
export function pickDefaultModel(providers: readonly ModelProvider[], fallback: string): string {
  for (const provider of providers) {
    if (!(provider.configured?.() ?? false)) continue
    const first = provider.resolveModel('')
    if (!first) continue
    // A catch-all provider accepts any id, so name it explicitly.
    return provider.catchAll ? `${provider.id}:${first.id}` : first.id
  }
  return fallback
}
