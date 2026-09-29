import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { showConfig } from '../src/cli/setup.js'
import { credentialsPath, loadCredentials, saveCredentials } from '../src/config/credentials.js'
import { saveGlobalConfig } from '../src/config/index.js'
import { normalizeProviderId } from '../src/models/registry.js'

const originalFlexHome = process.env.FLEX_HOME
const originalProvider = process.env.FLEX_PROVIDER
const originalModel = process.env.FLEX_MODEL

let home: string

afterEach(() => {
  if (originalFlexHome === undefined) delete process.env.FLEX_HOME
  else process.env.FLEX_HOME = originalFlexHome
  if (originalProvider === undefined) delete process.env.FLEX_PROVIDER
  else process.env.FLEX_PROVIDER = originalProvider
  if (originalModel === undefined) delete process.env.FLEX_MODEL
  else process.env.FLEX_MODEL = originalModel
  rmSync(home, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('user-local setup state', () => {
  it('stores credentials separately with restrictive permissions', () => {
    home = mkdtempSync(join(tmpdir(), 'flex-setup-'))
    process.env.FLEX_HOME = home

    saveCredentials({ google: { apiKey: 'setup-test-secret' } })

    expect(loadCredentials()).toEqual({ google: { apiKey: 'setup-test-secret' } })
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600)
    expect(readFileSync(join(home, 'config', 'credentials.json'), 'utf8')).toContain(
      'setup-test-secret',
    )
  })

  it('reports configuration status without exposing credential values', () => {
    home = mkdtempSync(join(tmpdir(), 'flex-setup-'))
    process.env.FLEX_HOME = home
    saveGlobalConfig({
      provider: 'google',
      model: 'gemini-custom-test',
      providers: { google: { baseURL: 'https://example.test/v1beta' } },
    })
    saveCredentials({ google: { apiKey: 'show-config-secret' } })

    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    showConfig(home, {})
    const output = write.mock.calls.map(([chunk]) => String(chunk)).join('')

    expect(output).toContain('"credentials": "configured"')
    expect(output).toContain('https://example.test/v1beta')
    expect(output).not.toContain('show-config-secret')
  })
})

describe('provider aliases', () => {
  it.each(['deepseek', 'mistral', 'groq', 'ollama', 'openrouter'])(
    'normalizes %s to the OpenAI-compatible registry entry',
    (alias) => {
      expect(normalizeProviderId(alias)).toBe('openai-compatible')
    },
  )
})
