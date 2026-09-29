import { resolve } from 'node:path'
import {
  credentialsPath,
  hasCredential,
  loadCredentials,
  saveCredentials,
} from '../config/credentials.js'
import { type FlexConfig, loadConfig, saveGlobalConfig } from '../config/index.js'
import { normalizeProviderId, type ProviderId } from '../models/registry.js'
import type { SetupResult } from '../tui/setup.js'
import { runFirstRunSetup } from '../tui/setup-runner.js'

export interface ProviderSetupDecision {
  proceed: boolean
  /** Provider inferred from an existing credential or explicit configuration. */
  provider?: ProviderId
  result?: SetupResult
}

export async function ensureProviderSetup(
  workspaceRoot: string,
  requested: { provider?: string; model?: string },
): Promise<ProviderSetupDecision> {
  const resolved = loadConfig({ workspaceRoot })
  const credentials = loadCredentials()
  const model = requested.model ?? process.env.FLEX_MODEL ?? resolved.value.model
  const modelIsExplicit =
    Boolean(requested.model || process.env.FLEX_MODEL) || resolved.provenance.model !== 'defaults'
  const provider =
    normalizeProviderId(requested.provider) ??
    normalizeProviderId(process.env.FLEX_PROVIDER) ??
    normalizeProviderId(resolved.value.provider) ??
    (modelIsExplicit ? inferProvider(model) : undefined)

  const configuredProvider =
    provider ??
    inferConfiguredProvider(resolved.value) ??
    inferSignalProvider(resolved.value, credentials, model)
  const hasSignal = configuredProvider
    ? providerHasSignal(configuredProvider, resolved.value, credentials)
    : hasAnyProviderSignal(resolved.value, credentials)

  if (hasSignal) return { proceed: true, provider: configuredProvider }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      'flex: no AI provider is configured. Run `flex` from an interactive terminal to start setup, or configure an API key; see `flex --help`.\n',
    )
    process.exitCode = 1
    return { proceed: false }
  }

  process.stdout.write('\n')
  const result = await runFirstRunSetup(configuredProvider)
  if (!result) {
    process.stdout.write('Flex setup cancelled. No changes were made.\n')
    return { proceed: false }
  }

  if (!setupCanAuthenticate(result)) {
    process.stderr.write(
      `No credential was entered for this hosted provider. No provider settings were saved; set its environment variable or run flex again to configure it.\n`,
    )
    return { proceed: false }
  }
  saveSetup(result)
  return { proceed: true, result }
}

function saveSetup(result: SetupResult): void {
  const key =
    result.providerId === 'anthropic'
      ? 'anthropic'
      : result.providerId === 'google'
        ? 'google'
        : 'openai'
  const connection: Record<string, string> = {}
  if (result.providerName) connection.label = result.providerName
  if (result.baseURL) connection.baseURL = result.baseURL

  saveGlobalConfig({
    provider: result.providerId,
    model: result.model,
    providers: { [key]: connection },
  } as FlexConfig)
  if (result.apiKey) saveCredentials({ [key]: { apiKey: result.apiKey } })
}

function setupCanAuthenticate(result: SetupResult): boolean {
  if (result.apiKey) return true
  if (result.providerId === 'anthropic') {
    return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
  }
  if (result.providerId === 'google') {
    return Boolean(
      process.env.FLEX_GOOGLE_API_KEY ||
        process.env.FLEX_GEMINI_API_KEY ||
        process.env.GEMINI_API_KEY ||
        process.env.GOOGLE_API_KEY ||
        process.env.GOOGLE_AI_API_KEY ||
        process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
        process.env.GOOGLE_AI_STUDIO_API_KEY,
    )
  }
  return Boolean(
    process.env.FLEX_OPENAI_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.DEEPSEEK_API_KEY ||
      process.env.MISTRAL_API_KEY ||
      process.env.GROQ_API_KEY ||
      process.env.TOGETHER_API_KEY ||
      process.env.FIREWORKS_API_KEY ||
      process.env.OPENROUTER_API_KEY ||
      endpointIsLocal(result.baseURL) ||
      (result.isCustomEndpoint && result.baseURL),
  )
}

function providerHasSignal(
  provider: ProviderId,
  config: FlexConfig,
  credentials: ReturnType<typeof loadCredentials>,
): boolean {
  const connection = providerConnection(provider, config)
  const stored = providerCredential(provider, credentials)
  if (
    connection?.apiKey ||
    connection?.authToken ||
    hasCredential(stored) ||
    (provider === 'openai-compatible' && connection?.baseURL)
  ) {
    return true
  }
  if (provider === 'anthropic') {
    return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
  }
  if (provider === 'google') {
    return Boolean(
      process.env.FLEX_GOOGLE_API_KEY ||
        process.env.FLEX_GEMINI_API_KEY ||
        process.env.GEMINI_API_KEY ||
        process.env.GOOGLE_API_KEY ||
        process.env.GOOGLE_AI_API_KEY ||
        process.env.GOOGLE_GENERATIVE_AI_API_KEY ||
        process.env.GOOGLE_AI_STUDIO_API_KEY,
    )
  }
  return Boolean(
    process.env.FLEX_OPENAI_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.DEEPSEEK_API_KEY ||
      process.env.MISTRAL_API_KEY ||
      process.env.GROQ_API_KEY ||
      process.env.TOGETHER_API_KEY ||
      process.env.FIREWORKS_API_KEY ||
      process.env.OPENROUTER_API_KEY ||
      endpointIsLocal(
        connection?.baseURL ?? process.env.FLEX_OPENAI_BASE_URL ?? process.env.OPENAI_BASE_URL,
      ),
  )
}

function hasAnyProviderSignal(
  config: FlexConfig,
  credentials: ReturnType<typeof loadCredentials>,
): boolean {
  return (
    providerHasSignal('anthropic', config, credentials) ||
    providerHasSignal('google', config, credentials) ||
    providerHasSignal('openai-compatible', config, credentials)
  )
}

function inferConfiguredProvider(config: FlexConfig): ProviderId | undefined {
  const configured = config.providers
  const candidates: ProviderId[] = []
  if (configured?.anthropic) candidates.push('anthropic')
  if (configured?.google) candidates.push('google')
  if (configured?.openai) candidates.push('openai-compatible')
  return candidates.length === 1 ? candidates[0] : undefined
}

function inferProvider(model: string | undefined): ProviderId | undefined {
  if (!model) return undefined
  if (/^claude-/i.test(model)) return 'anthropic'
  if (/^gemini-/i.test(model)) return 'google'
  if (/^(gpt-|o\d|deepseek-|mistral|llama|qwen|phi-|command-|kimi-)/i.test(model)) {
    return 'openai-compatible'
  }
  return undefined
}

function inferSignalProvider(
  config: FlexConfig,
  credentials: ReturnType<typeof loadCredentials>,
  model: string | undefined,
): ProviderId | undefined {
  const fromModel = inferProvider(model)
  if (fromModel && providerHasSignal(fromModel, config, credentials)) return fromModel

  const candidates = (['anthropic', 'google', 'openai-compatible'] as const).filter((id) =>
    providerHasSignal(id, config, credentials),
  )
  return candidates.length === 1 ? candidates[0] : undefined
}

function providerConnection(provider: ProviderId, config: FlexConfig) {
  if (provider === 'anthropic') return config.providers?.anthropic
  if (provider === 'google') return config.providers?.google
  return config.providers?.openai
}

function providerCredential(provider: ProviderId, credentials: ReturnType<typeof loadCredentials>) {
  if (provider === 'anthropic') return credentials.anthropic
  if (provider === 'google') return credentials.google
  return credentials.openai
}

function endpointIsLocal(baseURL: string | undefined): boolean {
  if (!baseURL) return false
  try {
    const hostname = new URL(baseURL).hostname
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1'
  } catch {
    return false
  }
}

export function showConfig(
  workspaceRoot: string,
  requested: { provider?: string; model?: string },
): void {
  const resolved = loadConfig({ workspaceRoot })
  const credentials = loadCredentials()
  const model = requested.model ?? process.env.FLEX_MODEL ?? resolved.value.model
  const explicitModel =
    Boolean(requested.model || process.env.FLEX_MODEL) || resolved.provenance.model !== 'defaults'
  const provider =
    normalizeProviderId(requested.provider) ??
    normalizeProviderId(process.env.FLEX_PROVIDER) ??
    normalizeProviderId(resolved.value.provider) ??
    (explicitModel ? inferProvider(model) : undefined) ??
    inferSignalProvider(resolved.value, credentials, model)
  const providers = {
    anthropic: safeConnection('anthropic', resolved.value, credentials),
    google: safeConnection('google', resolved.value, credentials),
    openai: safeConnection('openai-compatible', resolved.value, credentials),
  }
  process.stdout.write(
    `${JSON.stringify(
      {
        workspace: resolve(workspaceRoot),
        active: { provider: provider ?? 'not selected', model },
        provenance: resolved.provenance,
        providers,
        credentialsFile: credentialsPath(),
        note: 'Secrets are redacted; environment variables override stored credentials.',
      },
      null,
      2,
    )}\n`,
  )
}

function safeConnection(
  provider: ProviderId,
  config: FlexConfig,
  credentials: ReturnType<typeof loadCredentials>,
): Record<string, string | undefined> {
  const connection = providerConnection(provider, config)
  const stored = providerCredential(provider, credentials)
  const envKey =
    provider === 'anthropic'
      ? (process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN)
      : provider === 'google'
        ? (process.env.FLEX_GOOGLE_API_KEY ??
          process.env.FLEX_GEMINI_API_KEY ??
          process.env.GEMINI_API_KEY ??
          process.env.GOOGLE_API_KEY ??
          process.env.GOOGLE_AI_API_KEY ??
          process.env.GOOGLE_GENERATIVE_AI_API_KEY ??
          process.env.GOOGLE_AI_STUDIO_API_KEY)
        : (process.env.FLEX_OPENAI_API_KEY ??
          process.env.OPENAI_API_KEY ??
          process.env.DEEPSEEK_API_KEY ??
          process.env.MISTRAL_API_KEY ??
          process.env.GROQ_API_KEY ??
          process.env.TOGETHER_API_KEY ??
          process.env.FIREWORKS_API_KEY ??
          process.env.OPENROUTER_API_KEY)
  return {
    label: connection?.label,
    baseURL: connection?.baseURL,
    credentials:
      envKey || connection?.apiKey || connection?.authToken || hasCredential(stored)
        ? 'configured'
        : 'missing',
  }
}
